import { haversine } from './geo';
import type { FleetSnapshot } from './source';
import type { FallbackSuggestion, LngLat } from './types';

export interface FallbackInput {
  studentId: string;
  defaultRouteId: string;
  home: LngLat;
  snapshot: FleetSnapshot;
  /** Latest fused passenger count per bus. Missing = assume empty. */
  paxByBus: Record<string, number>;
  /** Where students board in the afternoon; stops this close to it are not useful drop-offs. */
  boardingPoint?: LngLat;
  boardingExclusionMeters?: number;
}

/**
 * Client-side mirror of `find_fallback_route` (Blueprint §2.2), used by the mock source and as a
 * reference for the PostGIS version:
 *   1. Only applies if the default route's last bus (is_last_bus) has ended.
 *   2. Consider stops on every OTHER active route.
 *   3. Pick the stop nearest the student's home (ST_Distance ≈ haversine).
 *   4. Only routes with an un-ended trip that still has free seats.
 */
export function findFallbackRoute(input: FallbackInput): FallbackSuggestion | null {
  const { snapshot, paxByBus, home, defaultRouteId, boardingPoint, boardingExclusionMeters = 150 } = input;

  const lastBusGone = snapshot.trips.some(
    (t) => t.route_id === defaultRouteId && t.is_last_bus && t.end_time !== null,
  );
  if (!lastBusGone) return null;

  let best: FallbackSuggestion | null = null;
  for (const route of snapshot.routes) {
    if (route.id === defaultRouteId || !route.is_active) continue;

    // Trip on this route with the most free seats.
    let trip: { id: string; seats: number } | null = null;
    for (const t of snapshot.trips) {
      if (t.route_id !== route.id || t.end_time !== null) continue;
      const bus = snapshot.buses.find((b) => b.id === t.bus_id);
      if (!bus) continue;
      const seats = bus.max_capacity - (paxByBus[bus.id] ?? 0);
      if (seats > 0 && (!trip || seats > trip.seats)) trip = { id: t.id, seats };
    }
    if (!trip) continue;

    for (const stop of snapshot.stops) {
      if (stop.route_id !== route.id) continue;
      if (boardingPoint && haversine(stop.location, boardingPoint) < boardingExclusionMeters) continue;
      const d = haversine(stop.location, home);
      if (!best || d < best.distance_meters) {
        best = {
          student_id: input.studentId,
          route_id: route.id,
          route_name: route.name,
          stop_id: stop.id,
          stop_name: stop.stop_name,
          distance_meters: Math.round(d),
          trip_id: trip.id,
          available_seats: trip.seats,
        };
      }
    }
  }
  return best;
}
