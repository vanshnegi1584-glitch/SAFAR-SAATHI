import type { BusSeatsEvent, TrackingServerEvents } from '@transitlink/shared';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTrackingServer, type TrackingServer } from '../src/app';
import { DevAuthenticator } from '../src/auth';
import { loadConfig } from '../src/config';
import { importSchedule } from '../src/importer';
import { parseFusion, parseSeatSources } from '../src/seats';
import { createTestDb, createUser, hasMigrations } from './pgliteDb';

// Seat counts from the on-board vision service (ai_face/vision/service.py) relayed to students.
// The fake below returns the exact key set of that service's GET /fusion response.

const STUDENT = '00000000-0000-0000-0000-000000000061';
const OTHER = '00000000-0000-0000-0000-000000000062';
const CSV = [
  'S.No.,Reg. No.,Bus No.,Shift Timing,Driver Name,Contact No.,Route,Seats',
  '1,UK07PA0001,18,7.00 AM   11.00 AM,A,9000000001,Alpha- Geu,41',
  '2,UK07PA0002,19,7.00 AM   11.00 AM,B,9000000002,Gamma- Geu,45',
].join('\n');

const fusionBody = (over: Record<string, unknown> = {}) => ({
  bus_id: '18', timestamp: Date.now() / 1000, seats_free: 5, capacity: 41, source: 'camera',
  expected_empty: 4, visual_empty_seats: 5, visual_seats_total: 41, visual_unknown_seats: 0, visual_seats_mapped: 41,
  deviation: 1, recalibration_required: false, motion: 'stationary', reason: 'normal', cameras: 1, ...over,
});

describe('parseFusion / parseSeatSources', () => {
  it('accepts the vision service response and rejects inconsistent ones', () => {
    expect(parseFusion(fusionBody())).toMatchObject({ seats_free: 5, source: 'camera' });
    expect(parseFusion(fusionBody({ seats_free: null, source: 'unavailable', reason: 'stale_or_missing_data' }))).toMatchObject({ seats_free: null });
    expect(parseFusion(fusionBody({ seats_free: 50 }))).toBeNull(); // more free than capacity
    expect(parseFusion(fusionBody({ seats_free: null, source: 'ir' }))).toBeNull();
    expect(parseFusion(fusionBody({ source: 'guess' }))).toBeNull();
    expect(parseFusion('nope')).toBeNull();
  });
  it('relays the anonymous people count, and never a doubtful one', () => {
    expect(parseFusion(fusionBody({ people_on_board: 12, people_source: 'camera' })))
      .toMatchObject({ people_on_board: 12, people_source: 'camera' });
    expect(parseFusion(fusionBody({ people_on_board: 30, people_source: 'ir' }))).toMatchObject({ people_on_board: 30, people_source: 'ir' });
    // Older vision services have no people fields: seats still parse, people are unavailable.
    expect(parseFusion(fusionBody())).toMatchObject({ seats_free: 5, people_on_board: null, people_source: 'unavailable' });
    for (const bad of [{ people_on_board: -1, people_source: 'camera' }, { people_on_board: 2.5, people_source: 'ir' },
      { people_on_board: 83, people_source: 'ir' }, { people_on_board: 4, people_source: 'face' },
      { people_on_board: 4, people_source: 'unavailable' }]) {
      expect(parseFusion(fusionBody(bad))).toMatchObject({ seats_free: 5, people_on_board: null, people_source: 'unavailable' });
    }
  });
  it('validates SEAT_SOURCES', () => {
    expect(parseSeatSources('{"bus-uk07pa0001":"http://10.0.0.5:8000"}')).toEqual({ 'bus-uk07pa0001': 'http://10.0.0.5:8000' });
    expect(() => parseSeatSources('{"18":"http://x"}')).toThrow(/bus id/);
    expect(() => parseSeatSources('{"bus-a":"ftp://x"}')).toThrow(/http/);
    expect(parseSeatSources(undefined)).toEqual({});
  });
});

describe.skipIf(!hasMigrations)('seat relay end-to-end', () => {
  let server: TrackingServer;
  let fake: Server;
  let url: string;
  let body: Record<string, unknown> | 'down' = fusionBody();
  const sockets: Socket[] = [];

  beforeAll(async () => {
    fake = createServer((_req, res) => {
      if (body === 'down') return void res.writeHead(503).end();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise<void>((r) => fake.listen(0, r));
    const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    const { db } = await createTestDb();
    await createUser(db, STUDENT, 'student');
    await createUser(db, OTHER, 'student');
    const imp = await importSchedule(db, CSV);
    expect(imp.buses_upserted).toBe(2);
    const routes = (await db.query<{ id: string; stop_ids: string[] }>('select id, stop_ids from public.campus_routes')).rows;
    const alpha = routes.find((r) => r.stop_ids[0] === 'stop-alpha')!.id;
    const gamma = routes.find((r) => r.stop_ids[0] === 'stop-gamma')!.id;
    await db.query('insert into public.campus_student_routes (student_id, route_id) values ($1, $2), ($3, $4)', [STUDENT, alpha, OTHER, gamma]);

    const cfg = { ...loadConfig({ DEV_AUTH: '1' }), corsOrigins: [], seatSources: { 'bus-uk07pa0001': fakeUrl } };
    server = await createTrackingServer(db, new DevAuthenticator(db), cfg);
    await new Promise<void>((r) => server.http.listen(0, r));
    url = `http://127.0.0.1:${(server.http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await server?.close();
    fake?.close();
  });

  const socket = (id: string) => new Promise<Socket<TrackingServerEvents>>((resolve, reject) => {
    const s: Socket<TrackingServerEvents> = connect(url, { transports: ['websocket'], auth: { token: `dev:${id}` }, reconnection: false });
    sockets.push(s as Socket);
    s.on('connect', () => setTimeout(() => resolve(s), 50)); // let the server finish joining rooms
    s.on('connect_error', reject);
  });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('relays seats to students on the bus route only, and never passes doubtful numbers', async () => {
    const mine: BusSeatsEvent[] = [];
    const theirs: BusSeatsEvent[] = [];
    (await socket(STUDENT)).on('bus:seats', (e) => mine.push(e));
    (await socket(OTHER)).on('bus:seats', (e) => theirs.push(e));

    await server.seats.pollOnce();
    await settle();
    expect(mine.at(-1)).toMatchObject({ bus_id: 'bus-uk07pa0001', seats_free: 5, capacity: 41, source: 'camera', reason: 'normal' });
    expect(theirs).toHaveLength(0);

    // Unchanged reading within the heartbeat window: not re-sent.
    await server.seats.pollOnce();
    await settle();
    expect(mine).toHaveLength(1);

    // Vision service configured for a different capacity than the schedule says → no number.
    body = fusionBody({ capacity: 40, seats_free: 3 });
    await server.seats.pollOnce();
    await settle();
    expect(mine.at(-1)).toMatchObject({ seats_free: null, source: 'unavailable', reason: 'capacity_mismatch' });

    // URL pointing at another bus's service.
    body = fusionBody({ bus_id: '19' });
    await server.seats.pollOnce();
    await settle();
    expect(mine.at(-1)).toMatchObject({ seats_free: null, reason: 'bus_mismatch' });

    // Sensors stale on the bus side.
    body = fusionBody({ seats_free: null, source: 'unavailable', reason: 'stale_or_missing_data' });
    await server.seats.pollOnce();
    await settle();
    expect(mine.at(-1)).toMatchObject({ seats_free: null, reason: 'stale_or_missing_data' });

    // Service down.
    body = 'down';
    await server.seats.pollOnce();
    await settle();
    expect(mine.at(-1)).toMatchObject({ seats_free: null, reason: 'unreachable' });

    // IR-sourced reading recovers, and shows in the student's snapshot (not the other student's).
    body = fusionBody({ source: 'ir', seats_free: 7, motion: 'moving' });
    await server.seats.pollOnce();
    await settle();
    expect(mine.at(-1)).toMatchObject({ seats_free: 7, source: 'ir' });
    const snap = async (id: string) => (await fetch(`${url}/api/tracking/snapshot`, { headers: { Authorization: `Bearer dev:${id}` } })).json();
    expect((await snap(STUDENT)).seats).toEqual([expect.objectContaining({ seats_free: 7 })]);
    expect((await snap(OTHER)).seats).toEqual([]);
  });
});
