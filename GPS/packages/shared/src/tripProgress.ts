import { haversine } from './geo';
import { projectCandidates, type DirectedRoutePlan, type PlanStop } from './routePlan';
import type { LocationFix, RouteProgress } from './trackingTypes';
import type { LngLat } from './types';

// Route matching and arrival detection for one trip. The trip's direction is fixed when it starts and
// is never inferred from GPS; GPS only moves the bus forward/backward along the directed plan.

export interface ProgressPolicy {
  /** Minimum corridor half-width around the route, metres; widened by reported accuracy. */
  corridorMinM: number;
  corridorMaxM: number;
  /** How far back along the route a fix may place the bus (GPS jitter, short reversing). */
  maxBacktrackM: number;
  /** Used to bound forward progress between fixes. */
  maxSpeedMps: number;
  /** Consecutive usable off-corridor fixes before a deviation is reported. */
  deviationFixes: number;
  /** Consecutive qualifying fixes inside a stop geofence to count as arrived... */
  arrivalFixes: number;
  /** ...or this long inside it with at least two qualifying fixes. */
  arrivalDwellMs: number;
  /** Bus must be this far past the first stop's geofence to count as departed. */
  departureMarginM: number;
}

export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = {
  corridorMinM: 40,
  corridorMaxM: 150,
  maxBacktrackM: 60,
  maxSpeedMps: 30,
  deviationFixes: 3,
  arrivalFixes: 3,
  arrivalDwellMs: 10_000,
  departureMarginM: 20,
};

export interface ProgressState {
  /** Latest matched position along the route. */
  along_m: number | null;
  /** Furthest progress so far — next-stop and "passed" decisions use this so they never flap backwards. */
  max_along_m: number;
  last_matched_at: number | null;
  off_route_count: number;
  deviating: boolean;
  departed_at: number | null;
  arrived_at: number | null;
  /** Stop seqs already reported as arrived (repeated stops have distinct seqs). */
  arrived_seqs: number[];
  /** Geofence dwell tracking for the stop currently being approached. */
  inside: { seq: number; count: number; since: number } | null;
}

export const initialProgress = (): ProgressState => ({
  along_m: null, max_along_m: 0, last_matched_at: null, off_route_count: 0, deviating: false,
  departed_at: null, arrived_at: null, arrived_seqs: [], inside: null,
});

export type ProgressEvent =
  | { type: 'departed'; at: number }
  | { type: 'arrived'; stop: PlanStop; final: boolean; at: number }
  | { type: 'deviation'; distance_m: number; resolved: boolean; at: number };

export interface ProgressStep {
  state: ProgressState;
  progress: RouteProgress;
  events: ProgressEvent[];
}

function nextStopAfter(plan: DirectedRoutePlan, maxAlong: number, arrived: number[]): PlanStop | null {
  for (const s of plan.stops) {
    if (arrived.includes(s.seq)) continue;
    // A stop counts as passed once the bus is clearly beyond its geofence.
    if (s.along_m + s.geofence_radius_m < maxAlong) continue;
    return s;
  }
  return null;
}

function progressFor(plan: DirectedRoutePlan, st: ProgressState, distance: number, onRoute: boolean): RouteProgress {
  const along = st.along_m ?? 0;
  const next = nextStopAfter(plan, st.max_along_m, st.arrived_seqs);
  return {
    on_route: onRoute,
    distance_from_route_m: Math.round(distance),
    along_m: Math.round(along),
    progress: plan.length_m > 0 ? Math.min(1, Math.max(0, st.max_along_m / plan.length_m)) : 0,
    next_stop_id: next?.stop_id ?? null,
    next_stop_name: next?.name ?? null,
    remaining_to_next_stop_m: next ? Math.max(0, Math.round(next.along_m - along)) : null,
    remaining_to_destination_m: Math.max(0, Math.round(plan.length_m - along)),
  };
}

/**
 * Advances trip progress with one accepted fix. `usable` is false for low-accuracy fixes: they are
 * reported (distance from route) but do not move progress, trigger arrival, or count toward deviation.
 */
export function advanceProgress(
  plan: DirectedRoutePlan, prev: ProgressState, fix: LocationFix, usable: boolean,
  policy: ProgressPolicy = DEFAULT_PROGRESS_POLICY,
): ProgressStep {
  const p: LngLat = [fix.longitude, fix.latitude];
  const acc = fix.accuracy_m ?? policy.corridorMaxM;
  const corridor = Math.min(policy.corridorMaxM, Math.max(policy.corridorMinM, 2 * acc));
  const events: ProgressEvent[] = [];
  const st: ProgressState = { ...prev, arrived_seqs: prev.arrived_seqs.slice() };

  // Search window: from a little behind the last position to as far as the bus could have driven.
  let minAlong = 0;
  let maxAlong = plan.length_m;
  let expected = 0;
  if (prev.along_m !== null && prev.last_matched_at !== null) {
    const dt = Math.max(0, (fix.measured_at - prev.last_matched_at) / 1000);
    minAlong = Math.max(0, prev.along_m - policy.maxBacktrackM);
    maxAlong = Math.min(plan.length_m, prev.along_m + policy.maxSpeedMps * dt + corridor + 50);
    expected = prev.along_m + (fix.speed_mps ?? 0) * dt;
  }
  const candidates = projectCandidates(plan.line, plan.cum, p, minAlong, maxAlong);
  const allCandidates = prev.along_m === null ? candidates : projectCandidates(plan.line, plan.cum, p);
  const nearestAnywhere = Math.min(...allCandidates.map((c) => c.distance_m));

  // Among in-corridor candidates prefer the one consistent with expected progress; this resolves
  // overlapping legs (same road both ways, repeated stops) and nearby parallel roads.
  let best: { along_m: number; distance_m: number } | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c.distance_m > corridor) continue;
    const score = prev.along_m === null
      ? c.distance_m + 0.001 * c.along_m // first fix: nearest, earliest occurrence on ties
      : c.distance_m + 0.2 * Math.abs(c.along_m - expected);
    if (score < bestScore) { bestScore = score; best = c; }
  }

  if (!usable) {
    return { state: st, progress: progressFor(plan, st, nearestAnywhere, !st.deviating), events };
  }

  if (!best) {
    st.off_route_count = prev.off_route_count + 1;
    if (!prev.deviating && st.off_route_count >= policy.deviationFixes) {
      st.deviating = true;
      events.push({ type: 'deviation', distance_m: Math.round(nearestAnywhere), resolved: false, at: fix.measured_at });
    }
    st.inside = null;
    return { state: st, progress: progressFor(plan, st, nearestAnywhere, false), events };
  }

  if (prev.deviating) events.push({ type: 'deviation', distance_m: Math.round(best.distance_m), resolved: true, at: fix.measured_at });
  st.off_route_count = 0;
  st.deviating = false;
  st.along_m = best.along_m;
  st.max_along_m = Math.max(prev.max_along_m, best.along_m);
  st.last_matched_at = fix.measured_at;

  // Departure from the starting stop.
  const first = plan.stops[0];
  if (st.departed_at === null && first && st.max_along_m > first.along_m + first.geofence_radius_m + policy.departureMarginM) {
    st.departed_at = fix.measured_at;
    events.push({ type: 'departed', at: fix.measured_at });
  }

  // Arrival at the next stop: inside its geofence, accuracy compatible with the radius, progress
  // consistent with having reached it, and sustained (consecutive fixes or dwell time).
  const target = nextStopAfter(plan, st.max_along_m, st.arrived_seqs);
  if (target && st.arrived_at === null) {
    const isFinal = target.seq === plan.stops.length - 1;
    const qualifies =
      haversine(p, target.location) <= target.geofence_radius_m &&
      acc <= Math.max(target.geofence_radius_m, 30) &&
      st.max_along_m >= target.along_m - target.geofence_radius_m - acc;
    // The first stop of the trip is where the bus starts; don't announce "arrived" there.
    if (qualifies && target.seq > 0) {
      const inside = prev.inside && prev.inside.seq === target.seq
        ? { seq: target.seq, count: prev.inside.count + 1, since: prev.inside.since }
        : { seq: target.seq, count: 1, since: fix.measured_at };
      st.inside = inside;
      const dwellOk = inside.count >= 2 && fix.measured_at - inside.since >= policy.arrivalDwellMs;
      if (inside.count >= policy.arrivalFixes || dwellOk) {
        st.arrived_seqs.push(target.seq);
        st.inside = null;
        if (isFinal) st.arrived_at = fix.measured_at;
        events.push({ type: 'arrived', stop: target, final: isFinal, at: fix.measured_at });
      }
    } else {
      st.inside = null;
    }
  }

  return { state: st, progress: progressFor(plan, st, best.distance_m, true), events };
}
