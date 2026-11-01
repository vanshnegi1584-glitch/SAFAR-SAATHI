import { haversine } from './geo';
import { buildRoutePlan, type DirectedRoutePlan, type PlanStop } from './routePlan';
import type { BusLocationEvent, PublicRoute, PublicStop, TripDirection, TripSummary } from './trackingTypes';
import type { LngLat } from './types';

/**
 * "I missed my bus — what else gets me there?" For a destination stop and the student's own location,
 * every bus whose route passes the destination (or a stop near it) in the direction it travels:
 * buses already on the road, and departures that have not left yet. For each: the stop where the
 * student can still board, the walk to it, when the bus reaches it, and when it gets them there.
 *
 * Everything here is an estimate: walking uses a straight line stretched by a detour factor at a
 * steady pace, and buses not yet on the road use a typical speed.
 */

export interface AlternativeOptions {
  /** Walking pace, m/s (1.2 ≈ 4.3 km/h). */
  walk_mps: number;
  /** Street distance ÷ straight-line distance for walking. */
  walk_detour: number;
  /** A stop this close to the destination still counts as getting the student there. */
  drop_radius_m: number;
  /** Arrive at the stop at least this long before the bus. */
  margin_s: number;
  /** Bus speed when a trip has no live estimate yet (a departure not yet started), m/s. */
  default_bus_mps: number;
}

export const DEFAULT_ALTERNATIVE_OPTIONS: AlternativeOptions = {
  walk_mps: 1.2, walk_detour: 1.3, drop_radius_m: 2000, margin_s: 60, default_bus_mps: 5.5,
};

/** A departure from the timetable that has not started yet, e.g. bus 42 on the 4:00 PM slot. */
export interface ScheduledDeparture {
  bus_id: string;
  route_id: string;
  direction: TripDirection;
  slot_id: string;
  departs_at: number; // epoch ms, from the first stop of that direction
}

export interface AlternativeInput {
  destination_stop_id: string;
  me: LngLat;
  now: number; // server epoch ms
  routes: PublicRoute[];
  stops: PublicStop[];
  trips: TripSummary[];
  latest: Record<string, BusLocationEvent>;
  scheduled?: ScheduledDeparture[];
  options?: Partial<AlternativeOptions>;
}

export interface AlternativeStop { stop_id: string; name: string; location: LngLat }

export interface Alternative {
  kind: 'live' | 'scheduled';
  bus_id: string;
  route_id: string;
  direction: TripDirection;
  trip_id?: string;
  slot_id?: string;
  /** When the bus leaves its first stop (scheduled departures only). */
  departs_at?: number;
  /** Where the bus is now (live only). */
  bus_location?: LngLat;
  /** Stop to board at, the walk to it, and when the bus gets there. */
  board: AlternativeStop & { walk_m: number; walk_s: number; bus_at: number };
  /** Stop to get off at, how far it is from the destination, and when the bus gets there. */
  drop: AlternativeStop & { from_destination_m: number; arrive_at: number };
  /** Can the student walk to the boarding stop in time? */
  catchable: boolean;
  /** Spare time at the stop before the bus comes (catchable), or how late they would be (not). */
  slack_s: number;
}

const stopOf = (s: PlanStop): AlternativeStop => ({ stop_id: s.stop_id, name: s.name, location: s.location });

/** Earliest-reachable choice: the boarding stop with the shortest walk that still beats the bus. */
function chooseBoarding(
  me: LngLat, now: number, candidates: { stop: PlanStop; bus_at: number }[], o: AlternativeOptions,
) {
  const scored = candidates.map(({ stop, bus_at }) => {
    const walk_m = haversine(me, stop.location) * o.walk_detour;
    const walk_s = walk_m / o.walk_mps;
    return { stop, bus_at, walk_m, walk_s, slack_s: (bus_at - now) / 1000 - walk_s - o.margin_s };
  });
  const ok = scored.filter((c) => c.slack_s >= 0).sort((a, b) => a.walk_m - b.walk_m);
  if (ok[0]) return { ...ok[0], catchable: true };
  // None reachable in time: report the stop where the student would miss the bus by the least.
  const best = scored.sort((a, b) => b.slack_s - a.slack_s)[0];
  return best ? { ...best, catchable: false } : null;
}

/** A bus on the road heading to the destination with no stop left to board it at before it gets there. */
export interface TooFarAlong {
  bus_id: string;
  trip_id: string;
  route_id: string;
  direction: TripDirection;
  bus_location: LngLat;
  drop: AlternativeStop & { arrive_at: number };
}

export function findAlternatives(input: AlternativeInput): { options: Alternative[]; too_far_along: TooFarAlong[] } {
  const o = { ...DEFAULT_ALTERNATIVE_OPTIONS, ...input.options };
  const stopById = new Map(input.stops.map((s) => [s.id, s]));
  const destination = stopById.get(input.destination_stop_id);
  if (!destination?.location) return { options: [], too_far_along: [] };
  const out: Alternative[] = [];
  const tooFar: TooFarAlong[] = [];
  const plans = new Map<string, DirectedRoutePlan | null>();
  const planFor = (route: PublicRoute, direction: TripDirection) => {
    const key = `${route.id}|${direction}`;
    if (!plans.has(key)) {
      try { plans.set(key, route.ready ? buildRoutePlan({ route, stops: stopById }, direction) : null); } catch { plans.set(key, null); }
    }
    return plans.get(key)!;
  };
  /** The stop on this plan nearest the destination, if close enough; boarding stops must come before it. */
  const dropOn = (plan: DirectedRoutePlan) => {
    const near = plan.stops
      .map((s) => ({ s, d: haversine(s.location, destination.location!) }))
      .filter(({ d }) => d <= o.drop_radius_m)
      .sort((a, b) => a.d - b.d)[0];
    return near ? { stop: near.s, from_destination_m: near.d } : null;
  };

  // Buses on the road now.
  for (const trip of input.trips) {
    if (trip.status === 'completed' || trip.status === 'cancelled') continue;
    const route = input.routes.find((r) => r.id === trip.route_id);
    const ev = input.latest[trip.bus_id];
    if (!route || route.version !== trip.route_version || !ev || ev.trip_id !== trip.id || !ev.route) continue;
    const plan = planFor(route, trip.direction);
    const drop = plan && dropOn(plan);
    if (!plan || !drop) continue;
    const busAlong = ev.route.along_m;
    if (drop.stop.along_m + drop.stop.geofence_radius_m < busAlong) continue; // already past the destination
    const mps = ev.eta.status === 'ok' && ev.eta.destination_seconds
      ? ev.route.remaining_to_destination_m / ev.eta.destination_seconds : o.default_bus_mps;
    const at = (along: number) => ev.eta.computed_at + (Math.max(0, along - busAlong) / mps) * 1000;
    const candidates = plan.stops
      .filter((s) => s.along_m > busAlong && s.along_m < drop.stop.along_m)
      .map((stop) => ({ stop, bus_at: at(stop.along_m) }));
    const board = chooseBoarding(input.me, input.now, candidates, o);
    if (!board) {
      tooFar.push({ bus_id: trip.bus_id, trip_id: trip.id, route_id: route.id, direction: trip.direction, bus_location: ev.location,
        drop: { ...stopOf(drop.stop), arrive_at: at(drop.stop.along_m) } });
      continue;
    }
    out.push({
      kind: 'live', bus_id: trip.bus_id, route_id: route.id, direction: trip.direction, trip_id: trip.id,
      ...(trip.slot_id ? { slot_id: trip.slot_id } : {}), bus_location: ev.location,
      board: { ...stopOf(board.stop), walk_m: board.walk_m, walk_s: board.walk_s, bus_at: board.bus_at },
      drop: { ...stopOf(drop.stop), from_destination_m: drop.from_destination_m, arrive_at: at(drop.stop.along_m) },
      catchable: board.catchable, slack_s: board.slack_s,
    });
  }

  // Departures that have not left yet; a run already on the road (same bus and slot) is listed above.
  const onRoad = new Set(input.trips.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').map((t) => `${t.bus_id}|${t.slot_id}`));
  for (const d of input.scheduled ?? []) {
    if (d.departs_at < input.now || onRoad.has(`${d.bus_id}|${d.slot_id}`)) continue;
    const route = input.routes.find((r) => r.id === d.route_id);
    const plan = route && planFor(route, d.direction);
    const drop = plan && dropOn(plan);
    if (!plan || !drop) continue;
    const at = (along: number) => d.departs_at + (along / o.default_bus_mps) * 1000;
    const candidates = plan.stops.filter((s) => s.along_m < drop.stop.along_m).map((stop) => ({ stop, bus_at: at(stop.along_m) }));
    const board = chooseBoarding(input.me, input.now, candidates, o);
    if (!board) continue;
    out.push({
      kind: 'scheduled', bus_id: d.bus_id, route_id: d.route_id, direction: d.direction, slot_id: d.slot_id, departs_at: d.departs_at,
      board: { ...stopOf(board.stop), walk_m: board.walk_m, walk_s: board.walk_s, bus_at: board.bus_at },
      drop: { ...stopOf(drop.stop), from_destination_m: drop.from_destination_m, arrive_at: at(drop.stop.along_m) },
      catchable: board.catchable, slack_s: board.slack_s,
    });
  }

  // Catchable first, then whichever gets the student there soonest.
  return {
    options: out.sort((a, b) => Number(b.catchable) - Number(a.catchable) || a.drop.arrive_at - b.drop.arrive_at),
    too_far_along: tooFar,
  };
}
