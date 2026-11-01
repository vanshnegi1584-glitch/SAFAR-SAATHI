import { describe, expect, it } from 'vitest';
import { findAlternatives } from './alternatives';
import { haversine } from './geo';
import { buildRoutePlan } from './routePlan';
import type { BusLocationEvent, PublicRoute, PublicStop, TripSummary } from './trackingTypes';
import type { LngLat } from './types';

// A straight east-west road: A (first stop) ... G (college) about 9.6 km apart.
const LAT = 30.3;
const at = (lng: number, north_m = 0): LngLat => [lng, LAT + north_m / 111_000];
const stop = (id: string, lng: number, extra: Partial<PublicStop> = {}): PublicStop =>
  ({ id, name: id, location: at(lng), status: 'verified', geofence_radius_m: 60, is_college_endpoint: id === 'G', ...extra });
const STOPS = [stop('A', 78.0), stop('B', 78.03), stop('C', 78.06), stop('D', 78.09), stop('G', 78.1),
  stop('X', 78.03 + 0.0084), /* ~800 m east of B, on no route */ stop('FAR', 77.95) /* 4.8 km west of A */];
const ROUTE: PublicRoute = {
  id: 'r1', version: 1, name: 'A → G', stop_ids: ['A', 'B', 'C', 'D', 'G'], college_stop_id: 'G',
  geometry: Array.from({ length: 11 }, (_, i) => at(78 + i * 0.01)), geometry_status: 'verified', ready: true, problems: [],
} as PublicRoute;
const NOW = Date.UTC(2026, 10, 1, 7, 30); // 1:00 PM IST
const SPEED = 7;
const plan = buildRoutePlan({ route: ROUTE, stops: new Map(STOPS.map((s) => [s.id, s])) }, 'FROM_COLLEGE');
const along = (id: string) => plan.stops.find((s) => s.stop_id === id)!.along_m;

/** A departure (college → A) running now, `busAlong` metres from the college. */
function live(busAlong: number) {
  const trip = { id: 't1', bus_id: 'bus-1', route_id: 'r1', route_version: 1, direction: 'FROM_COLLEGE', status: 'active', slot_id: 'pm-1300' } as TripSummary;
  const remaining = plan.length_m - busAlong;
  const ev = {
    bus_id: 'bus-1', trip_id: 't1', location: at(78.1 - busAlong / 96_000),
    route: { along_m: busAlong, remaining_to_destination_m: remaining },
    eta: { status: 'ok', destination_seconds: remaining / SPEED, computed_at: NOW },
  } as unknown as BusLocationEvent;
  return { trips: [trip], latest: { 'bus-1': ev } };
}
const base = { routes: [ROUTE], stops: STOPS, now: NOW };
const options = (input: Parameters<typeof findAlternatives>[0]) => findAlternatives(input).options;

describe('findAlternatives', () => {
  it('finds a live bus the student can still walk to, and when it gets them there', () => {
    const [alt, ...rest] = options({ ...base, ...live(500), destination_stop_id: 'B', me: at(78.06, 100) });
    expect(rest).toHaveLength(0);
    expect(alt).toMatchObject({ kind: 'live', bus_id: 'bus-1', catchable: true, board: { stop_id: 'C' }, drop: { stop_id: 'B', from_destination_m: 0 } });
    expect(alt!.board.walk_m).toBeCloseTo(100 * 1.3, -1); // 100 m straight line, stretched for streets
    expect(alt!.drop.arrive_at).toBeCloseTo(NOW + ((along('B') - 500) / SPEED) * 1000, -2);
    expect(alt!.slack_s).toBeGreaterThan(0);
  });

  it('never suggests boarding at the stop the student is going to', () => {
    // Standing at C and going to C: the only sensible boarding stops are before C, i.e. D.
    const [alt] = options({ ...base, ...live(100), destination_stop_id: 'C', me: at(78.06) });
    expect(alt!.board.stop_id).toBe('D');
    expect(alt!.drop.stop_id).toBe('C');
  });

  it('a bus with no stop left to board before the destination is reported as too far along, not as an option', () => {
    // Bus between C and B, going to B: no stop to board at before B.
    const r = findAlternatives({ ...base, ...live(along('C') + 200), destination_stop_id: 'B', me: at(78.06) });
    expect(r.options).toEqual([]);
    expect(r.too_far_along).toMatchObject([{ bus_id: 'bus-1', drop: { stop_id: 'B' } }]);
  });

  it('ignores a bus that has already passed the destination', () => {
    expect(options({ ...base, ...live(along('B') + 500), destination_stop_id: 'B', me: at(78.06) })).toEqual([]);
  });

  it('a bus that only passes near the destination drops the student at the closest stop, within 2 km', () => {
    const [alt] = options({ ...base, ...live(500), destination_stop_id: 'X', me: at(78.06, 100) });
    expect(alt!.drop.stop_id).toBe('B');
    expect(alt!.drop.from_destination_m).toBeCloseTo(haversine(at(78.03), at(78.0384)), 0);
    expect(options({ ...base, ...live(500), destination_stop_id: 'FAR', me: at(78.06) })).toEqual([]);
  });

  it('says plainly when the student is too far away to catch a bus', () => {
    const [alt] = options({ ...base, ...live(500), destination_stop_id: 'A', me: at(78.0, 3000) });
    expect(alt!.catchable).toBe(false);
    expect(alt!.slack_s).toBeLessThan(0);
  });

  it('lists departures that have not left yet, and puts catchable ones first', () => {
    const later = NOW + 3 * 3600_000;
    const alts = options({
      ...base, ...live(500), destination_stop_id: 'B', me: at(78.0, 3000), // too far for the live bus
      scheduled: [
        { bus_id: 'bus-2', route_id: 'r1', direction: 'FROM_COLLEGE', slot_id: 'pm-1600', departs_at: later },
        { bus_id: 'bus-3', route_id: 'r1', direction: 'FROM_COLLEGE', slot_id: 'pm-1300', departs_at: NOW - 60_000 }, // already left
      ],
    });
    expect(alts.map((a) => [a.kind, a.bus_id, a.catchable])).toEqual([['scheduled', 'bus-2', true], ['live', 'bus-1', false]]);
    expect(alts[0]).toMatchObject({ departs_at: later, slot_id: 'pm-1600', drop: { stop_id: 'B' } });
  });

  it('a run already on the road is not listed twice, but later runs of the same bus are', () => {
    const alts = options({ ...base, ...live(500), destination_stop_id: 'B', me: at(78.06),
      scheduled: [
        { bus_id: 'bus-1', route_id: 'r1', direction: 'FROM_COLLEGE', slot_id: 'pm-1300', departs_at: NOW + 60_000 }, // the live run
        { bus_id: 'bus-1', route_id: 'r1', direction: 'FROM_COLLEGE', slot_id: 'pm-1600', departs_at: NOW + 3 * 3_600_000 },
      ] });
    expect(alts.map((a) => [a.kind, a.slot_id])).toEqual([['live', 'pm-1300'], ['scheduled', 'pm-1600']]);
  });
});
