import { haversine } from './geo';
import type { LngLat } from './types';
import type { PublicRoute, PublicStop, TripDirection } from './trackingTypes';

// A directed, measured version of a route: the verified road geometry oriented for the trip's direction,
// with each stop placed at a distance along it. Everything downstream (matching, next stop, arrival,
// ETA) works in "metres along the route", never in screen or longitude terms.

export interface PlanStop {
  stop_id: string;
  name: string;
  seq: number;
  location: LngLat;
  geofence_radius_m: number;
  along_m: number;
}

export interface DirectedRoutePlan {
  route_id: string;
  route_version: number;
  direction: TripDirection;
  line: LngLat[];
  /** cum[i] = metres from line[0] to line[i]. */
  cum: number[];
  length_m: number;
  stops: PlanStop[];
}

export interface RouteConfigInput {
  route: Pick<PublicRoute, 'id' | 'version' | 'stop_ids' | 'college_stop_id' | 'geometry' | 'geometry_status'>;
  stops: Map<string, Pick<PublicStop, 'id' | 'name' | 'location' | 'status' | 'geofence_radius_m'>>;
}

/** A stop further than this from the verified geometry means the geometry or the stop is wrong. */
export const MAX_STOP_OFFSET_M = 150;

const R = 6_371_000;
const RAD = Math.PI / 180;

/** Local metres projection around a reference latitude; accurate to well under 1% at city scale. */
function toXY(p: LngLat, cosLat: number): [number, number] {
  return [p[0] * RAD * R * cosLat, p[1] * RAD * R];
}

export interface Projection {
  along_m: number;
  distance_m: number;
  segment: number;
}

/**
 * Best projection of `p` onto each segment of the line whose along-distance falls in [minAlong, maxAlong].
 * Returns one candidate per segment so callers can choose between overlapping legs of a route.
 */
export function projectCandidates(
  line: LngLat[], cum: number[], p: LngLat, minAlong = -Infinity, maxAlong = Infinity,
): Projection[] {
  const cosLat = Math.cos(p[1] * RAD);
  const [px, py] = toXY(p, cosLat);
  const out: Projection[] = [];
  for (let i = 1; i < line.length; i++) {
    const segStart = cum[i - 1]!;
    const segEnd = cum[i]!;
    if (segEnd < minAlong || segStart > maxAlong) continue;
    const [ax, ay] = toXY(line[i - 1]!, cosLat);
    const [bx, by] = toXY(line[i]!, cosLat);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    const segLen = segEnd - segStart;
    // Clamp to the part of the segment inside the window.
    const tMin = segLen > 0 ? Math.max(0, (minAlong - segStart) / segLen) : 0;
    const tMax = segLen > 0 ? Math.min(1, (maxAlong - segStart) / segLen) : 1;
    t = Math.min(tMax, Math.max(tMin, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    out.push({ along_m: segStart + t * segLen, distance_m: Math.hypot(px - cx, py - cy), segment: i - 1 });
  }
  return out;
}

export function cumulative(line: LngLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1]! + haversine(line[i - 1]!, line[i]!));
  return cum;
}

/** Why a route cannot be used for matching/ETA yet. Empty list = ready. */
export function routeProblems({ route, stops }: RouteConfigInput): string[] {
  const problems: string[] = [];
  if (!route.college_stop_id) problems.push('Route has no GEU/GEHU endpoint');
  if (route.geometry_status !== 'verified' || !route.geometry || route.geometry.length < 2) {
    problems.push(route.geometry_status === 'candidate' ? 'Route geometry awaits admin approval' : 'Route geometry not configured');
  }
  const unverified = route.stop_ids
    .map((id) => stops.get(id))
    .filter((s) => !s || s.status !== 'verified' || !s.location);
  if (unverified.length) {
    problems.push(`${unverified.length} of ${route.stop_ids.length} stops lack verified coordinates`);
  }
  if (problems.length === 0) {
    try {
      buildRoutePlan({ route, stops }, 'TO_COLLEGE');
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  return problems;
}

/**
 * Orients the verified geometry for `direction` and places every stop along it. Stops are placed in
 * sequence (each at or after the previous one), so a stop visited twice, or a road travelled in both
 * directions, gets the right position for each visit. Throws if the route is not ready.
 */
export function buildRoutePlan({ route, stops }: RouteConfigInput, direction: TripDirection): DirectedRoutePlan {
  if (!route.geometry || route.geometry.length < 2 || route.geometry_status !== 'verified') {
    throw new Error('Route geometry not verified');
  }
  const line = direction === 'TO_COLLEGE' ? route.geometry.slice() : route.geometry.slice().reverse();
  const ids = direction === 'TO_COLLEGE' ? route.stop_ids.slice() : route.stop_ids.slice().reverse();
  const cum = cumulative(line);
  const length = cum[cum.length - 1]!;

  let prevAlong = 0;
  const planStops: PlanStop[] = ids.map((id, seq) => {
    const s = stops.get(id);
    if (!s || s.status !== 'verified' || !s.location) throw new Error(`Stop ${id} has no verified coordinates`);
    const candidates = projectCandidates(line, cum, s.location, prevAlong);
    // Nearest placement that keeps stop order; ties favour the earliest occurrence.
    let best: Projection | undefined;
    for (const c of candidates) {
      if (!best || c.distance_m < best.distance_m - 1) best = c;
    }
    if (!best || best.distance_m > MAX_STOP_OFFSET_M) {
      throw new Error(`Stop "${s.name}" is ${best ? Math.round(best.distance_m) : '?'} m from the route geometry, or out of order`);
    }
    prevAlong = best.along_m;
    return { stop_id: id, name: s.name, seq, location: s.location, geofence_radius_m: s.geofence_radius_m, along_m: best.along_m };
  });

  return { route_id: route.id, route_version: route.version, direction, line, cum, length_m: length, stops: planStops };
}
