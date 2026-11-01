import { pointAlongLine, polylineLength, type LngLat, type TrackingServerEvents } from '@transitlink/shared';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTrackingServer, type TrackingServer } from '../src/app';
import { DevAuthenticator } from '../src/auth';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db';
import { createTestDb, createUser, hasMigrations } from './pgliteDb';

// Full stack on a real Postgres engine (PGlite): CSV import → admin configures a route → driver starts
// a trip and streams GPS over Socket.IO → students receive (or don't) the live bus.

const ADMIN = '00000000-0000-0000-0000-00000000000a';
const DRIVER = '00000000-0000-0000-0000-00000000000d';
const OTHER_DRIVER = '00000000-0000-0000-0000-00000000000e';
const STUDENT = '00000000-0000-0000-0000-000000000051';
const OTHER_STUDENT = '00000000-0000-0000-0000-000000000052';

// Synthetic test data only — not real stop coordinates or phone numbers.
const CSV = [
  'S.No.,Reg. No.,Bus No.,Shift Timing,Driver Name,Contact No.,Route,Seats',
  '1,UK07PA0001,18,7.00 AM   11.00 AM,Test Driver,9000000001,Alpha- Beta- Geu,41',
  '2,UK07PA0002,19,6.45 AM  10.45AM,Other Driver,9000000002,Gamma- Geu,45',
].join('\n');
// ~2.9 km test road: east then north.
const GEOM: LngLat[] = [[78.0, 30.30], [78.02, 30.30], [78.02, 30.31]];

type Client = Socket<TrackingServerEvents>;

describe.skipIf(!hasMigrations)('tracking server end-to-end', () => {
  let db: Db;
  let server: TrackingServer;
  let url: string;
  let clock = Date.now();
  const sockets: Client[] = [];

  const api = async (token: string, method: string, path: string, body?: unknown, type = 'application/json') => {
    const res = await fetch(url + path, {
      method,
      headers: { Authorization: `Bearer dev:${token}`, 'Content-Type': type },
      body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : String(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const socket = (userId: string) => new Promise<Client>((resolve, reject) => {
    const s: Client = connect(url, { transports: ['websocket'], auth: { token: `dev:${userId}` }, reconnection: false });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
  const collect = <E extends keyof TrackingServerEvents>(s: Client, event: E) => {
    const got: Parameters<TrackingServerEvents[E]>[0][] = [];
    s.on(event as never, ((p: never) => got.push(p)) as never);
    return got;
  };
  const sendFix = (s: Client, p: LngLat, seq: number, tripId: string, busId: string, extra: Record<string, unknown> = {}) =>
    new Promise<{ ok: boolean; accepted: boolean; reason?: string }>((resolve) =>
      (s as unknown as Socket).emit('driver:location', {
        busId, tripId, latitude: p[1], longitude: p[0], accuracyMeters: 5, speedMetersPerSecond: 8, headingDegrees: 90,
        timestamp: new Date(clock).toISOString(), sequence: seq, source: 'driver_device', ...extra,
      }, resolve));
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const waitFor = async (cond: () => boolean, ms = 3000) => {
    const until = Date.now() + ms;
    while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  };

  beforeAll(async () => {
    ({ db } = await createTestDb());
    await createUser(db, ADMIN, 'admin');
    await createUser(db, DRIVER, 'driver');
    await createUser(db, OTHER_DRIVER, 'driver');
    await createUser(db, STUDENT, 'student');
    await createUser(db, OTHER_STUDENT, 'student');
    const cfg = { ...loadConfig({ PORT: '0', DEV_AUTH: '1' }), corsOrigins: [] };
    server = await createTrackingServer(db, new DevAuthenticator(db), cfg, () => clock);
    await new Promise<void>((r) => server.http.listen(0, r));
    url = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await server?.close();
  });

  it('runs a full trip with authorised, route-scoped live updates', async () => {
    // --- admin: import schedule, verify stops + geometry, assign the driver
    const imp = await api(ADMIN, 'POST', '/api/admin/schedule/import?file_name=test.csv', CSV, 'text/csv');
    expect(imp.status).toBe(200);
    expect(imp.body).toMatchObject({ records: 2, buses_upserted: 2, routes_active: 2 });

    let snap = (await api(ADMIN, 'GET', '/api/tracking/snapshot')).body;
    const alpha = snap.routes.find((r: { stop_ids: string[] }) => r.stop_ids[0] === 'stop-alpha');
    const gamma = snap.routes.find((r: { stop_ids: string[] }) => r.stop_ids[0] === 'stop-gamma');
    expect(alpha.ready).toBe(false);
    expect(alpha.problems).toContain('Route geometry not configured');

    // Student cannot do admin things.
    expect((await api(STUDENT, 'PUT', '/api/admin/stops/stop-alpha', { location: GEOM[0], status: 'verified' })).status).toBe(403);

    for (const [id, loc] of [['stop-alpha', GEOM[0]], ['stop-beta', GEOM[1]], ['campus-geu', GEOM[2]]] as const) {
      expect((await api(ADMIN, 'PUT', `/api/admin/stops/${id}`, { location: loc, status: 'verified', geofence_radius_m: 50 })).status).toBe(200);
    }
    const geo = await api(ADMIN, 'PUT', `/api/admin/routes/${alpha.id}/geometry`, { geometry: GEOM, status: 'verified', source: 'test' });
    expect(geo.body).toMatchObject({ ready: true, problems: [] });

    const busA = 'bus-uk07pa0001';
    const busB = 'bus-uk07pa0002';
    expect((await api(ADMIN, 'PUT', `/api/admin/drivers/${DRIVER}/assignment`, { bus_id: busA })).status).toBe(204);
    expect((await api(ADMIN, 'PUT', `/api/admin/drivers/${OTHER_DRIVER}/assignment`, { bus_id: busB })).status).toBe(204);

    // --- students choose routes
    expect((await api(STUDENT, 'PUT', '/api/students/me/route', { route_id: alpha.id, stop_id: 'stop-beta' })).status).toBe(200);
    expect((await api(OTHER_STUDENT, 'PUT', '/api/students/me/route', { route_id: gamma.id })).status).toBe(200);

    const student = await socket(STUDENT);
    const otherStudent = await socket(OTHER_STUDENT);
    const driver = await socket(DRIVER);
    const otherDriver = await socket(OTHER_DRIVER);
    const seen = collect(student, 'bus:location');
    const leaked = collect(otherStudent, 'bus:location');
    const arrivals = collect(student, 'bus:arrived');
    const updates = collect(student, 'trip:updated');
    const stale = collect(student, 'bus:stale');
    const offline = collect(student, 'bus:offline');

    // --- slot handling: 7:00 matches the CSV, 1:00 PM is not confirmed for this bus
    const me = (await api(DRIVER, 'GET', '/api/driver/me')).body;
    expect(me.bus.id).toBe(busA);
    expect(me.slots.find((s: { id: string }) => s.id === 'am-0700').status).toBe('matched');
    expect((await api(DRIVER, 'POST', '/api/driver/trips', { direction: 'FROM_COLLEGE', slot_id: 'pm-1300' })).body.error).toBe('slot_not_confirmed');

    const started = await api(DRIVER, 'POST', '/api/driver/trips', { direction: 'TO_COLLEGE', slot_id: 'am-0700' });
    expect(started.status).toBe(201);
    const trip = started.body;
    expect(trip).toMatchObject({ status: 'waiting_for_gps', route_ready: true, direction: 'TO_COLLEGE' });
    expect(trip.scheduled_departure).toMatch(/T01:30:00/); // 07:00 IST

    // Another driver cannot publish for this bus, even with the right ids.
    const spoof = await sendFix(otherDriver, GEOM[0]!, 1, trip.id, busA);
    expect(spoof).toMatchObject({ accepted: false, reason: 'not_authorised_for_bus' });
    expect((await sendFix(driver, [200, 30] as LngLat, 1, trip.id, busA)).reason).toMatch(/^invalid/);

    // --- drive the route: one fix every 2 s at ~16 m/fix, then dwell at the college.
    const line = GEOM;
    let seq = 0;
    const total = polylineLength(line);
    for (let m = 0; m <= total + 39; m += 40) {
      clock += 2000;
      const a = await sendFix(driver, pointAlongLine(line, m), ++seq, trip.id, busA);
      expect(a.accepted).toBe(true);
    }
    for (let i = 0; i < 4; i++) {
      clock += 2000;
      expect(await sendFix(driver, line[2]!, ++seq, trip.id, busA)).toMatchObject({ accepted: true });
    }
    // Duplicate sequence is rejected.
    expect((await sendFix(driver, line[2]!, seq, trip.id, busA)).reason).toBe('out_of_order');
    await waitFor(() => seen.length >= seq);
    await settle();
    const seqs = new Set(seen.map((e) => e.sequence));
    expect(Array.from({ length: seq }, (_, i) => i + 1).filter((n) => !seqs.has(n))).toEqual([]);

    expect(seen.length).toBe(seq);
    expect(leaked).toHaveLength(0);
    const mid = seen[20]!;
    expect(mid.route?.next_stop_id).toBe('stop-beta');
    expect(mid.eta.status).toBe('ok');
    expect(mid.eta.basis).toBe('live_speed_blend');
    expect(seen.at(-1)!.route!.remaining_to_destination_m).toBeLessThan(30);
    expect(arrivals.map((a) => [a.stop_id, a.final])).toEqual([['stop-beta', false], ['campus-geu', true]]);
    expect(updates.at(-1)).toMatchObject({ status: 'arrived' });
    expect(updates.at(-1)!.departed_at).not.toBeNull();

    // --- freshness: no fixes → stale after 15 s, offline after 60 s (one event each)
    clock += 16_000;
    await server.tracker.sweep();
    await server.tracker.sweep();
    clock += 50_000;
    await server.tracker.sweep();
    await settle();
    expect(stale).toHaveLength(1);
    expect(offline).toHaveLength(1);

    // --- end trip; persisted history and trip record
    const ended = await api(DRIVER, 'POST', `/api/driver/trips/${trip.id}/end`);
    expect(ended.body.status).toBe('completed');
    await server.tracker.flush();
    const { rows: hist } = await db.query<{ n: string }>('select count(*) as n from public.campus_bus_locations where trip_id = $1', [trip.id]);
    expect(Number(hist[0]!.n)).toBe(seq);
    const { rows: [row] } = await db.query<{ status: string; arrived_at: Date | null }>('select status, arrived_at from public.campus_trips where id = $1', [trip.id]);
    expect(row).toMatchObject({ status: 'completed' });
    expect(row!.arrived_at).not.toBeNull();

    // Snapshot for the other student never contains route Alpha's trip.
    snap = (await api(OTHER_STUDENT, 'GET', '/api/tracking/snapshot')).body;
    expect(snap.trips).toHaveLength(0);
    expect(JSON.stringify(snap)).not.toContain('9000000001'); // driver phone numbers never leave the server
  });

  it('a trip on an unconfigured route still shows position but no ETA', async () => {
    const driver = await socket(OTHER_DRIVER);
    const trip = (await api(OTHER_DRIVER, 'POST', '/api/driver/trips', { direction: 'TO_COLLEGE' })).body;
    expect(trip.route_ready).toBe(false);
    expect(trip.route_problems.join(' ')).toMatch(/geometry/);
    const got = collect(await socket(ADMIN), 'bus:location');
    clock += 2000;
    await sendFix(driver, [78.05, 30.35], 1, trip.id, 'bus-uk07pa0002');
    await settle();
    expect(got[0]).toMatchObject({ route: null, eta: { status: 'unavailable' } });
  });
});
