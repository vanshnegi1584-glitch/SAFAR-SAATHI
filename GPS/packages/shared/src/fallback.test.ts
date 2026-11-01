import { describe, expect, it } from 'vitest';
import { findFallbackRoute } from './fallback';
import { BUSES, CAMPUS, ROUTES, STOPS, TRIPS } from './mock/data';
import type { FleetSnapshot } from './source';

const snap = (endedTripIds: string[]): FleetSnapshot => ({
  routes: ROUTES,
  stops: STOPS,
  buses: BUSES,
  trips: TRIPS.map((t) => (endedTripIds.includes(t.id) ? { ...t, end_time: new Date().toISOString() } : t)),
});

// Student lives near Ballupur (Prem Nagar route) but is assigned to the Rajpur route.
const base = {
  studentId: 'stu-1',
  defaultRouteId: 'r-rajpur',
  home: [77.999, 30.3225] as [number, number],
  boardingPoint: CAMPUS,
};

describe('findFallbackRoute', () => {
  it('returns null while the last bus on the default route has not ended', () => {
    expect(findFallbackRoute({ ...base, snapshot: snap([]), paxByBus: {} })).toBeNull();
  });

  it('suggests the nearest stop on another route with free seats', () => {
    const s = findFallbackRoute({ ...base, snapshot: snap(['t-402']), paxByBus: {} });
    expect(s?.stop_name).toBe('Ballupur Chowk');
    expect(s?.route_id).toBe('r-premnagar');
    expect(s?.available_seats).toBeGreaterThan(0);
  });

  it('skips routes whose buses are full', () => {
    const s = findFallbackRoute({ ...base, snapshot: snap(['t-402']), paxByBus: { 'B-403': 40, 'B-404': 52 } });
    expect(s?.route_id).toBe('r-raipur');
  });

  it('never suggests the campus boarding point itself', () => {
    const s = findFallbackRoute({ ...base, home: CAMPUS, snapshot: snap(['t-402']), paxByBus: {} });
    expect(s?.stop_name).not.toBe('Graphic Era Campus');
  });
});
