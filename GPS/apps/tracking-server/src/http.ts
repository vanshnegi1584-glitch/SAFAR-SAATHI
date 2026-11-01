import {
  mapDepartureSlots, type LngLat, type PublicStop, type TrackingSnapshot,
} from '@transitlink/shared';
import express, { type NextFunction, type Request, type Response } from 'express';
import { bearer, isStaff, type Authenticator, type Principal } from './auth';
import type { ServerConfig } from './config';
import type { Db } from './db';
import { HttpError } from './errors';
import { geocodeStop, routeThroughStops } from './geocode';
import { importSchedule } from './importer';
import type { Repo } from './repo';
import type { SeatPoller } from './seats';
import type { Tracker } from './tracker';

type Handler = (req: Request, res: Response, me: Principal) => Promise<unknown>;

const isLngLat = (v: unknown): v is LngLat =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
  Math.abs(v[0] as number) <= 180 && Math.abs(v[1] as number) <= 90;

export interface HttpDeps {
  db: Db;
  repo: Repo;
  tracker: Tracker;
  seats: SeatPoller;
  auth: Authenticator;
  cfg: ServerConfig;
  /** Moves a student's open sockets to their new route room. */
  onStudentRouteChanged: (studentId: string, routeId: string) => void;
}

export function createHttpApp({ db, repo, tracker, seats, auth, cfg, onStudentRouteChanged }: HttpDeps) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && cfg.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }));

  const route = (roles: Principal['role'][] | 'any', fn: Handler) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const me = await auth.verify(bearer(req.headers.authorization));
        if (!me) throw new HttpError(401, 'unauthenticated', 'Sign in required');
        if (roles !== 'any' && !roles.includes(me.role)) throw new HttpError(403, 'forbidden', 'Not allowed for your role');
        const out = await fn(req, res, me);
        if (!res.headersSent) out === undefined ? res.sendStatus(204) : res.json(out);
      } catch (e) {
        next(e);
      }
    };
  const staff: Principal['role'][] = ['admin', 'operator'];

  app.get('/health', (_req, res) => void res.json({ ok: true, open_trips: tracker.openTrips().length }));

  app.get('/api/me', route('any', async (_req, _res, me) => ({
    user_id: me.userId,
    role: me.role,
    student_route: me.role === 'student' ? await repo.studentRoute(me.userId) : null,
    driver_bus_id: me.role === 'driver' ? await repo.driverBusId(me.userId) : null,
  })));

  /** Role-filtered: students only receive trips/positions for their own route. */
  app.get('/api/tracking/snapshot', route('any', async (_req, _res, me): Promise<TrackingSnapshot> => {
    const [routes, stops, buses] = await Promise.all([repo.routes(), repo.stops(), repo.buses()]);
    let visibleRoutes: Set<string> | 'all' = new Set();
    if (isStaff(me)) visibleRoutes = 'all';
    else if (me.role === 'student') {
      const r = await repo.studentRoute(me.userId);
      if (r) visibleRoutes.add(r.route_id);
    } else if (me.role === 'driver') {
      const busId = await repo.driverBusId(me.userId);
      const bus = buses.find((b) => b.id === busId);
      if (bus?.route_id) visibleRoutes.add(bus.route_id);
    }
    const visible = (routeId: string) => visibleRoutes === 'all' || visibleRoutes.has(routeId);
    return {
      routes, buses,
      stops: stops.map(({ location_source: _s, ...s }) => s),
      trips: tracker.openTrips().filter((t) => visible(t.route_id)),
      latest: tracker.latest().filter((l) => visible(l.route_id)),
      seats: seats.events().filter((s) => visibleRoutes === 'all' || (s.route_id !== null && visible(s.route_id))),
      server_time: Date.now(),
    };
  }));

  // ---- student ---------------------------------------------------------------------------------
  app.put('/api/students/me/route', route(['student'], async (req, _res, me) => {
    const { route_id, stop_id } = req.body ?? {};
    const routes = await repo.routes();
    const r = routes.find((x) => x.id === route_id);
    if (!r) throw new HttpError(400, 'bad_route', 'Unknown or inactive route');
    if (stop_id != null && !r.stop_ids.includes(stop_id)) throw new HttpError(400, 'bad_stop', 'Stop is not on that route');
    await repo.setStudentRoute(me.userId, r.id, stop_id ?? null);
    onStudentRouteChanged(me.userId, r.id);
    return { route_id: r.id, stop_id: stop_id ?? null };
  }));

  // ---- driver ----------------------------------------------------------------------------------
  app.get('/api/driver/me', route(['driver'], async (_req, _res, me) => {
    const busId = await repo.driverBusId(me.userId);
    if (!busId) return { bus: null, route: null, slots: [], open_trip: null };
    const bus = await repo.bus(busId);
    const route = (await repo.routes()).find((r) => r.id === bus?.route_id) ?? null;
    const [slots, shifts, decisions] = await Promise.all([repo.slots(), repo.busShifts([busId]), repo.slotDecisions()]);
    const mapping = mapDepartureSlots(
      [{ id: busId, shift: shifts.map((s) => ({ index: s.shift_index, raw: s.raw, time: s.local_time, no_service: s.no_service })) }],
      { timezone: cfg.timezone, slots: slots.map((s) => ({ ...s, time: s.local_time })) },
      decisions,
    );
    return {
      bus, route,
      slots: slots.map((s) => ({ ...s, ...mapping.find((m) => m.slot_id === s.id)! })),
      open_trip: tracker.tripForBus(busId),
    };
  }));

  app.post('/api/driver/trips', route(['driver'], async (req, res, me) => {
    const trip = await tracker.startTrip(me, req.body ?? {});
    res.status(201);
    return trip;
  }));

  app.post('/api/driver/trips/:id/end', route(['driver', 'admin', 'operator'], (req, _res, me) => tracker.endTrip(me, req.params.id!)));

  /** Batch upload — used by background tracking and to flush fixes queued while offline. */
  app.post('/api/driver/locations', route(['driver'], async (req, _res, me) => {
    const fixes = (req.body as { fixes?: unknown[] })?.fixes;
    if (!Array.isArray(fixes) || fixes.length === 0 || fixes.length > 500) {
      throw new HttpError(400, 'bad_batch', 'fixes must be a non-empty array of at most 500 items');
    }
    const acks = [];
    for (const f of fixes) acks.push(await tracker.ingest(me, f)); // in order: sequence checks depend on it
    return { acks };
  }));

  // ---- admin -----------------------------------------------------------------------------------
  app.post('/api/admin/schedule/import', route(['admin'], async (req, _res, me) => {
    if (typeof req.body !== 'string' || !req.body.trim()) throw new HttpError(400, 'bad_csv', 'Send the CSV as text/csv');
    const aliases = typeof req.query.aliases === 'string' ? JSON.parse(req.query.aliases) : undefined;
    return importSchedule(db, req.body, { fileName: String(req.query.file_name ?? 'upload.csv'), importedBy: me.userId, stopAliases: aliases });
  }));

  app.get('/api/admin/schedule/report', route(staff, async () => {
    const { rows } = await db.query('select id, file_name, file_sha256, record_count, issues, imported_at from public.campus_schedule_imports order by imported_at desc limit 1');
    return rows[0] ?? null;
  }));

  app.get('/api/admin/slots', route(staff, async () => {
    const [buses, slots, shifts, decisions] = await Promise.all([repo.buses(), repo.slots(), repo.busShifts(), repo.slotDecisions()]);
    const byBus = new Map<string, { index: number; raw: string; time: string | null; no_service: boolean }[]>();
    for (const s of shifts) byBus.set(s.bus_id, [...(byBus.get(s.bus_id) ?? []), { index: s.shift_index, raw: s.raw, time: s.local_time, no_service: s.no_service }]);
    return {
      timezone: cfg.timezone,
      slots,
      mapping: mapDepartureSlots(buses.map((b) => ({ id: b.id, shift: byBus.get(b.id) ?? [] })), { timezone: cfg.timezone, slots: slots.map((s) => ({ ...s, time: s.local_time })) }, decisions),
    };
  }));

  app.put('/api/admin/slots/:busId/:slotId', route(staff, async (req, _res, me) => {
    const { decision, note } = req.body ?? {};
    if (decision !== 'confirmed' && decision !== 'cancelled' && decision !== null) throw new HttpError(400, 'bad_decision', 'decision must be confirmed, cancelled or null');
    await repo.setSlotDecision(req.params.busId!, req.params.slotId!, decision, typeof note === 'string' ? note.slice(0, 500) : null, me.userId);
  }));

  app.get('/api/admin/stops', route(['admin'], () => repo.stops()));

  app.post('/api/admin/stops/:id/geocode', route(['admin'], async (req) => {
    const stop = (await repo.stops()).find((s) => s.id === req.params.id);
    if (!stop) throw new HttpError(404, 'no_stop', 'Unknown stop');
    return { stop_id: stop.id, candidates: await geocodeStop(stop.name, cfg) };
  }));

  app.put('/api/admin/stops/:id', route(['admin'], async (req, _res, me) => {
    const { location, status, source, geofence_radius_m } = req.body ?? {};
    const statuses: PublicStop['status'][] = ['unverified', 'candidate', 'verified'];
    if (!statuses.includes(status)) throw new HttpError(400, 'bad_status', 'status must be unverified, candidate or verified');
    if (location !== null && !isLngLat(location)) throw new HttpError(400, 'bad_location', 'location must be [lng, lat] or null');
    if (status !== 'unverified' && location === null) throw new HttpError(400, 'bad_location', 'A candidate or verified stop needs a location');
    if (geofence_radius_m != null && !(Number.isInteger(geofence_radius_m) && geofence_radius_m >= 15 && geofence_radius_m <= 500)) {
      throw new HttpError(400, 'bad_radius', 'geofence_radius_m must be 15–500');
    }
    const stop = await repo.setStopLocation(req.params.id!, { location, status, source: typeof source === 'string' ? source.slice(0, 200) : 'manual-map', radius: geofence_radius_m ?? undefined }, me.userId);
    if (!stop) throw new HttpError(404, 'no_stop', 'Unknown stop');
    return stop;
  }));

  /** Proposes road geometry through the verified stops; nothing is saved. */
  app.post('/api/admin/routes/:id/geometry/suggest', route(['admin'], async (req) => {
    const snap = await repo.routeConfig(req.params.id!);
    if (!snap) throw new HttpError(404, 'no_route', 'Unknown route');
    const byId = new Map(snap.stops.map((s) => [s.id, s]));
    const pts = snap.route.stop_ids.map((id) => byId.get(id));
    if (pts.some((s) => !s || s.status !== 'verified' || !s.location)) {
      throw new HttpError(409, 'stops_unverified', 'Verify every stop on this route before generating geometry');
    }
    return routeThroughStops(pts.map((s) => s!.location!), cfg);
  }));

  app.put('/api/admin/routes/:id/geometry', route(['admin'], async (req, _res, me) => {
    const { geometry, status, source } = req.body ?? {};
    if (geometry !== null && !(Array.isArray(geometry) && geometry.length >= 2 && geometry.length <= 20_000 && geometry.every(isLngLat))) {
      throw new HttpError(400, 'bad_geometry', 'geometry must be an array of at least two [lng, lat] points, or null');
    }
    if (!['missing', 'candidate', 'verified'].includes(status) || (status === 'missing') !== (geometry === null)) {
      throw new HttpError(400, 'bad_status', 'status must match geometry (missing ⇔ null)');
    }
    if (!(await repo.setRouteGeometry(req.params.id!, geometry, status, typeof source === 'string' ? source.slice(0, 200) : null, me.userId))) {
      throw new HttpError(404, 'no_route', 'Unknown route');
    }
    return (await repo.routes()).find((r) => r.id === req.params.id) ?? null;
  }));

  app.put('/api/admin/drivers/:userId/assignment', route(['admin'], async (req, _res, me) => {
    const { bus_id } = req.body ?? {};
    const { rows } = await db.query<{ role: string }>('select role from public.profiles where id = $1', [req.params.userId]);
    if (rows[0]?.role !== 'driver') throw new HttpError(400, 'not_driver', 'That user is not a driver');
    if (bus_id !== null && !(await repo.bus(bus_id))?.is_active) throw new HttpError(400, 'bad_bus', 'Unknown or inactive bus');
    await repo.setDriverAssignment(req.params.userId!, bus_id, me.userId);
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof SyntaxError) return void res.status(400).json({ error: 'bad_json', message: 'Malformed request body' });
    console.error('[http]', err);
    res.status(500).json({ error: 'internal', message: 'Internal server error' });
  });

  return app;
}
