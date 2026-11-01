import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { assessFix, parseDriverLocation, type FixGateState } from './fix';
import { estimateRouteEta, freshnessOf, formatAge } from './freshness';
import { pointAlongLine } from './geo';
import { buildRoutePlan, routeProblems, type RouteConfigInput } from './routePlan';
import {
  DEFAULT_DEPARTURE_CONFIG, mapDepartureSlots, parseSchedule, parseShiftTiming, zonedTimeToUtc,
} from './schedule';
import { advanceProgress, initialProgress, type ProgressEvent, type ProgressState } from './tripProgress';
import type { LocationFix, PublicStop } from './trackingTypes';
import type { LngLat } from './types';

const HEADER = 'S.No.,Reg. No.,Bus No.,Shift Timing,Driver Name,Contact No.,Route,Seats';

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes and line breaks inside quotes', () => {
    const rows = parseCsv('a,b\r\n"x, y","he said ""hi""\nnext line"\n\n');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'he said "hi"\nnext line']]);
  });
  it('rejects an unterminated quote instead of guessing', () => {
    expect(() => parseCsv('a,"b')).toThrow();
  });
});

describe('parseShiftTiming', () => {
  it('reads both shifts in order, including "No Service" and missing spaces', () => {
    expect(parseShiftTiming('7.00 AM   11.00 AM').entries.map((e) => e.time)).toEqual(['07:00', '11:00']);
    expect(parseShiftTiming('6.45 AM  10.45AM').entries.map((e) => e.time)).toEqual(['06:45', '10:45']);
    const ns = parseShiftTiming('6.10 AM             No Service').entries;
    expect(ns[0]!.time).toBe('06:10');
    expect(ns[1]).toMatchObject({ time: null, no_service: true });
    expect(parseShiftTiming('12.30 PM').entries[0]!.time).toBe('12:30');
  });
});

describe('parseSchedule (synthetic)', () => {
  const csv = [
    HEADER,
    '1,UK07PA0001,18,7.00 AM   11.00 AM,Driver A,9000000001,Clock Tower- ISBT- Geu,41',
    '2, uk07 pa 0001 ,19,6.45 AM  10.45AM,Driver B ,9000000002,"Clock Tower- ISBT- Geu\n",45',
    '3,UK07PA0003,18,6.10 AM   No Service,,123,Prem Nagar- Premnagar- Garhi Cant- X- Garhi Cant- GEU,abc',
    '4,UK07PA0004,20,7.00 AM,Driver D,9000000004,Clock Tower- ISBT,50',
  ].join('\n');
  const s = parseSchedule(csv);
  const codes = (record: number | null) => s.issues.filter((i) => i.record === record).map((i) => i.code);

  it('keeps every record and the original cell text', () => {
    expect(s.records).toHaveLength(4);
    expect(s.buses).toHaveLength(4);
    expect(s.records[1]!.raw['Reg. No.']).toBe(' uk07 pa 0001 ');
  });
  it('normalises registration but reports duplicates instead of dropping them', () => {
    expect(s.buses[1]!.registration_number).toBe('UK07PA0001');
    expect(s.buses[0]!.id).not.toBe(s.buses[1]!.id);
    expect(codes(2)).toContain('duplicate_registration');
    expect(codes(3)).toContain('duplicate_bus_number');
  });
  it('treats a multi-line route cell as the same route', () => {
    expect(s.buses[0]!.route_id).toBe(s.buses[1]!.route_id);
  });
  it('reports bad values without inventing replacements', () => {
    expect(s.buses[2]!.seats).toBeNull();
    expect(s.buses[2]!.driver_name).toBeNull();
    expect(codes(3)).toEqual(expect.arrayContaining(['bad_seats', 'missing_driver', 'unusual_contact', 'repeated_stop']));
    expect(codes(4)).toContain('no_college_endpoint');
  });
  it('suggests but never merges spelling variants', () => {
    expect(s.issues.some((i) => i.code === 'possible_duplicate_stop' && i.message.includes('Premnagar'))).toBe(true);
    expect(s.stops.map((x) => x.id)).toEqual(expect.arrayContaining(['stop-prem-nagar', 'stop-premnagar']));
    const merged = parseSchedule(csv, { stopAliases: { 'stop-premnagar': 'stop-prem-nagar' } });
    expect(merged.stops.map((x) => x.id)).not.toContain('stop-premnagar');
  });
  it('produces stable ids across imports', () => {
    expect(parseSchedule(csv).routes.map((r) => r.id)).toEqual(s.routes.map((r) => r.id));
  });
});

const realCsv = fileURLToPath(new URL('../../../data/SafarSaathi_Bus_Schedule.csv', import.meta.url));
describe.skipIf(!existsSync(realCsv))('parseSchedule (real SafarSaathi CSV)', () => {
  const s = parseSchedule(readFileSync(realCsv, 'utf8'));
  it('parses all 97 buses with no errors', () => {
    expect(s.buses).toHaveLength(97);
    expect(s.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('every route ends at a GEU/GEHU endpoint, in CSV (TO_COLLEGE) order', () => {
    for (const r of s.routes) expect(r.college_stop_id).toBe(r.stop_ids.at(-1));
  });
  it('keeps "No Service" as unavailable, not as a time', () => {
    const bus = s.buses.find((b) => b.registration_number === 'UK07PA5871')!;
    expect(bus.shift.map((e) => e.no_service)).toEqual([false, true]);
  });
});

describe('mapDepartureSlots', () => {
  const shift = (text: string) => parseShiftTiming(text).entries;
  const buses = [
    { id: 'a', shift: shift('7.00 AM 11.00 AM') },
    { id: 'b', shift: shift('6.45 AM 10.45 AM') },
    { id: 'c', shift: shift('6.10 AM No Service') },
  ];
  const m = mapDepartureSlots(buses, DEFAULT_DEPARTURE_CONFIG, { 'a|pm-1600': 'confirmed' });
  const get = (bus: string, slot: string) => m.find((x) => x.bus_id === bus && x.slot_id === slot)!.status;
  it('matches, flags conflicts, and never assigns afternoon slots implicitly', () => {
    expect(get('a', 'am-0700')).toBe('matched');
    expect(get('b', 'am-0700')).toBe('conflict');
    expect(get('c', 'am-1100')).toBe('no_service');
    expect(get('b', 'pm-1300')).toBe('unconfirmed');
    expect(get('a', 'pm-1600')).toBe('confirmed');
  });
  it('converts Asia/Kolkata wall time to UTC', () => {
    expect(zonedTimeToUtc('2026-10-31', '07:00', 'Asia/Kolkata').toISOString()).toBe('2026-10-31T01:30:00.000Z');
  });
});

// A ~3 km test route heading east then north. Stops: start, mid, college.
const GEOM: LngLat[] = [[78.0, 30.30], [78.02, 30.30], [78.02, 30.31]];
const stop = (id: string, location: LngLat, status: PublicStop['status'] = 'verified'): PublicStop =>
  ({ id, name: id, location, status, geofence_radius_m: 50, is_college_endpoint: id === 'college' });
function config(overrides: Partial<RouteConfigInput['route']> = {}, stops = [stop('start', GEOM[0]!), stop('mid', GEOM[1]!), stop('college', GEOM[2]!)]): RouteConfigInput {
  return {
    route: { id: 'r1', version: 1, stop_ids: ['start', 'mid', 'college'], college_stop_id: 'college', geometry: GEOM, geometry_status: 'verified', ...overrides },
    stops: new Map(stops.map((s) => [s.id, s])),
  };
}

describe('route plan', () => {
  it('requires verified geometry and stop coordinates', () => {
    expect(routeProblems(config({ geometry: null, geometry_status: 'missing' }))).toContain('Route geometry not configured');
    expect(routeProblems(config({}, [stop('start', GEOM[0]!), stop('mid', GEOM[1]!, 'candidate'), stop('college', GEOM[2]!)])))
      .toContain('1 of 3 stops lack verified coordinates');
    expect(routeProblems(config())).toEqual([]);
  });
  it('reverses stops and geometry for FROM_COLLEGE without looking at the map', () => {
    const to = buildRoutePlan(config(), 'TO_COLLEGE');
    const from = buildRoutePlan(config(), 'FROM_COLLEGE');
    expect(to.stops.map((s) => s.stop_id)).toEqual(['start', 'mid', 'college']);
    expect(from.stops.map((s) => s.stop_id)).toEqual(['college', 'mid', 'start']);
    expect(from.stops[0]!.along_m).toBeCloseTo(0, 0);
    expect(from.length_m).toBeCloseTo(to.length_m, 3);
  });
  it('places a repeated stop at each of its visits on an out-and-back route', () => {
    const geom: LngLat[] = [[78.0, 30.30], [78.01, 30.30], [78.0, 30.30005], [78.0, 30.31]];
    const plan = buildRoutePlan({
      route: { id: 'r2', version: 1, stop_ids: ['a', 'b', 'a', 'college'], college_stop_id: 'college', geometry: geom, geometry_status: 'verified' },
      stops: new Map([stop('a', geom[0]!), stop('b', geom[1]!), stop('college', geom[3]!)].map((s) => [s.id, s])),
    }, 'TO_COLLEGE');
    const [a1, b, a2] = plan.stops;
    expect(a1!.along_m).toBeLessThan(b!.along_m);
    expect(a2!.along_m).toBeGreaterThan(b!.along_m + 900);
  });
});

function fixAt(p: LngLat, t: number, seq: number, extra: Partial<LocationFix> = {}): LocationFix {
  return { latitude: p[1], longitude: p[0], accuracy_m: 5, speed_mps: 8, heading_deg: null, measured_at: t, sequence: seq, source: 'driver_device', ...extra };
}

function drive(planDir: 'TO_COLLEGE' | 'FROM_COLLEGE', points: LngLat[], stepMs = 2000) {
  const plan = buildRoutePlan(config(), planDir);
  let st: ProgressState = initialProgress();
  const events: ProgressEvent[] = [];
  let last = null as ReturnType<typeof advanceProgress> | null;
  points.forEach((p, i) => {
    last = advanceProgress(plan, st, fixAt(p, 1_000_000 + i * stepMs, i), true);
    st = last.state;
    events.push(...last.events);
  });
  return { plan, st, events, last: last! };
}

describe('advanceProgress', () => {
  const plan = buildRoutePlan(config(), 'TO_COLLEGE');
  const along = (m: number) => pointAlongLine(plan.line, m);
  const path = (from: number, to: number, step = 16) => {
    const out: LngLat[] = [];
    for (let m = from; m <= to; m += step) out.push(along(m));
    return out;
  };

  it('tracks next stop, departure and a single final arrival', () => {
    const pts = [...path(0, plan.length_m), ...Array(4).fill(along(plan.length_m))];
    const { events, st, last } = drive('TO_COLLEGE', pts);
    expect(events.filter((e) => e.type === 'departed')).toHaveLength(1);
    const arrivals = events.filter((e): e is Extract<ProgressEvent, { type: 'arrived' }> => e.type === 'arrived');
    expect(arrivals.at(-1)).toMatchObject({ final: true });
    expect(arrivals.filter((a) => a.final)).toHaveLength(1);
    expect(st.arrived_at).not.toBeNull();
    expect(last.progress.remaining_to_destination_m).toBe(0);
  });

  it('does not arrive while just passing near the destination earlier in the trip', () => {
    // FROM_COLLEGE: the bus starts at the college; sitting there must not "arrive" at the far end.
    const { events, last } = drive('FROM_COLLEGE', Array(5).fill(GEOM[2]!));
    expect(events.some((e) => e.type === 'arrived')).toBe(false);
    expect(last.progress.next_stop_id).toBe('college');
  });

  it('ignores a single wild reading and reports a sustained deviation once', () => {
    const offRoad: LngLat = [78.01, 30.305]; // ~550 m north of the first leg
    const start = path(0, 400, 40);
    const r = drive('TO_COLLEGE', [...start, offRoad, ...path(440, 520, 40)]);
    expect(r.events.some((e) => e.type === 'deviation')).toBe(false);
    const d = drive('TO_COLLEGE', [...start, offRoad, offRoad, offRoad, offRoad, along(440)]);
    const devs = d.events.filter((e) => e.type === 'deviation');
    expect(devs.map((e) => (e as { resolved: boolean }).resolved)).toEqual([false, true]);
  });

  it('never moves next stop backwards because of jitter', () => {
    const pts = path(0, 1200, 40);
    const jitter = [...pts, along(1160), along(1190), along(1150)];
    const { st } = drive('TO_COLLEGE', jitter);
    expect(st.max_along_m).toBeGreaterThan(1150);
  });

  it('low-accuracy fixes are shown but do not advance progress', () => {
    let st = initialProgress();
    st = advanceProgress(plan, st, fixAt(along(100), 0, 1), true).state;
    const r = advanceProgress(plan, st, fixAt(along(900), 2000, 2, { accuracy_m: 300 }), false);
    expect(r.state.along_m).toBeCloseTo(100, 0);
  });
});

describe('assessFix', () => {
  const now = 10_000_000;
  const base = (seq: number, t: number, p: LngLat = [78.0, 30.3], acc = 5) => fixAt(p, t, seq, { accuracy_m: acc });
  const empty: FixGateState = { last: null, pendingJumps: [] };

  it('rejects future, too-old and out-of-order fixes', () => {
    expect(assessFix(base(1, now + 60_000), empty, now).verdict).toMatchObject({ accept: false, reason: 'timestamp_in_future' });
    expect(assessFix(base(1, now - 3_600_000), empty, now).verdict).toMatchObject({ accept: false, reason: 'too_old' });
    const s1 = assessFix(base(5, now - 1000), empty, now).state;
    expect(assessFix(base(5, now), s1, now).verdict).toMatchObject({ accept: false, reason: 'out_of_order' });
    expect(assessFix(base(6, now - 2000), s1, now).verdict).toMatchObject({ accept: false, reason: 'out_of_order' });
  });
  it('marks backlog fixes as history-only, not live', () => {
    expect(assessFix(base(1, now - 120_000), empty, now).verdict).toMatchObject({ accept: true, live: false });
  });
  it('rejects a jump, but accepts once several consistent fixes show the old fix was wrong', () => {
    let s = assessFix(base(1, now - 10_000), empty, now).state;
    const far: LngLat = [78.1, 30.3]; // ~9.6 km away
    for (let i = 0; i < 2; i++) {
      const r = assessFix(base(2 + i, now - 8000 + i * 2000, far), s, now);
      expect(r.verdict).toMatchObject({ accept: false, reason: 'implausible_jump' });
      s = r.state;
    }
    expect(assessFix(base(4, now - 4000, far), s, now).verdict).toMatchObject({ accept: true, reset: true });
  });
  it('accepts poor accuracy but does not use it for matching', () => {
    expect(assessFix(base(1, now, [78, 30.3], 80), empty, now).verdict).toMatchObject({ accept: true, quality: 'poor', usableForMatching: false });
  });
});

describe('parseDriverLocation', () => {
  const ok = { busId: 'bus-uk07pa1696', tripId: 'abc', latitude: 30.3, longitude: 78.0, accuracyMeters: 5, speedMetersPerSecond: -1, headingDegrees: -1, timestamp: '2026-10-31T01:30:00Z', sequence: 3, source: 'driver_device' };
  it('accepts a valid payload and nulls unknown speed/heading', () => {
    const r = parseDriverLocation(ok);
    expect(r.ok && r.value.speedMetersPerSecond).toBeNull();
    expect(r.ok && r.value.measured_at).toBe(Date.parse('2026-10-31T01:30:00Z'));
  });
  it.each([
    { latitude: 91 }, { longitude: 'x' }, { latitude: 0, longitude: 0 }, { sequence: -1 }, { sequence: 1.5 },
    { source: 'phone' }, { timestamp: 'yesterday' }, { busId: 'a b' }, { accuracyMeters: 0 },
  ])('rejects %o', (bad) => {
    expect(parseDriverLocation({ ...ok, ...bad }).ok).toBe(false);
  });
});

describe('freshness and ETA', () => {
  it('uses the configured thresholds', () => {
    expect(freshnessOf(null, 0, 'active')).toBe('WAITING_FOR_GPS');
    expect(freshnessOf(0, 5000, 'active')).toBe('LIVE');
    expect(freshnessOf(0, 5001, 'active')).toBe('DELAYED');
    expect(freshnessOf(0, 15_001, 'active')).toBe('STALE');
    expect(freshnessOf(0, 1000, 'completed')).toBe('TRIP_ENDED');
    expect(formatAge(2000)).toBe('Last updated 2 seconds ago');
  });
  const base = { routeReady: true, freshness: 'LIVE' as const, arrived: false, remainingToDestinationM: 5000, remainingToNextStopM: 1000, speedMps: null, stationarySinceMs: null, nowMs: 0 };
  it('uses a transparent baseline without history', () => {
    const e = estimateRouteEta(base);
    expect(e).toMatchObject({ status: 'ok', basis: 'baseline', destination_seconds: 1000 });
  });
  it('refuses to estimate without verified route, with stale GPS, or a long stop', () => {
    expect(estimateRouteEta({ ...base, routeReady: false }).status).toBe('unavailable');
    expect(estimateRouteEta({ ...base, freshness: 'STALE' }).status).toBe('stale');
    expect(estimateRouteEta({ ...base, stationarySinceMs: -100_000 }).status).toBe('stationary');
  });
});
