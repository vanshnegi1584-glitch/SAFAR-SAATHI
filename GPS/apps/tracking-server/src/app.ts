import type { TrackingClientEvents, TrackingServerEvents } from '@transitlink/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { isStaff, type Authenticator, type Principal } from './auth';
import type { ServerConfig } from './config';
import type { Db } from './db';
import { createHttpApp } from './http';
import { Repo } from './repo';
import { SeatPoller } from './seats';
import { Tracker, type Broadcast } from './tracker';

type Io = Server<TrackingClientEvents, TrackingServerEvents, Record<string, never>, { me: Principal }>;

export interface TrackingServer {
  http: HttpServer;
  io: Io;
  tracker: Tracker;
  repo: Repo;
  seats: SeatPoller;
  close(): Promise<void>;
}

/** Builds the HTTP + Socket.IO server. `now` is injectable for tests. */
export async function createTrackingServer(db: Db, auth: Authenticator, cfg: ServerConfig, now: () => number = Date.now): Promise<TrackingServer> {
  const repo = new Repo(db);
  let io: Io;
  const broadcast: Broadcast = (rooms, event, ...args) => io.to(rooms).emit(event, ...args);
  const tracker = new Tracker(repo, broadcast, cfg, now);
  await tracker.load();
  const seats = new SeatPoller(repo, broadcast, cfg.seatSources, now);

  const app = createHttpApp({
    db, repo, tracker, seats, auth, cfg,
    onStudentRouteChanged: (studentId, routeId) => {
      void io.in(`user:${studentId}`).fetchSockets().then((sockets) => {
        for (const s of sockets) {
          for (const room of s.rooms) if (room.startsWith('route:')) s.leave(room);
          s.join(`route:${routeId}`);
        }
      });
    },
  });
  const http = createServer(app);
  io = new Server(http, { cors: { origin: cfg.corsOrigins }, pingInterval: 10_000, pingTimeout: 8_000 });

  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
      const me = await auth.verify(token);
      if (!me) return next(new Error('unauthenticated'));
      socket.data.me = me;
      next();
    } catch {
      next(new Error('auth_failed'));
    }
  });

  io.on('connection', async (socket: Socket<TrackingClientEvents, TrackingServerEvents, Record<string, never>, { me: Principal }>) => {
    const me = socket.data.me;
    await socket.join(`user:${me.userId}`);
    // Rooms are decided here, server-side; clients cannot join rooms by name.
    if (isStaff(me)) await socket.join('dispatch');
    if (me.role === 'student') {
      const r = await repo.studentRoute(me.userId);
      if (r) await socket.join(`route:${r.route_id}`);
    }
    if (me.role === 'driver') {
      const busId = await repo.driverBusId(me.userId);
      if (busId) await socket.join(`bus:${busId}`);
    }

    socket.on('driver:location', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const a = await tracker.ingest(me, payload);
        reply(a);
        if (!a.ok) socket.emit('tracking:error', { code: a.reason ?? 'rejected', message: `Location not accepted: ${a.reason}` });
      } catch (e) {
        console.error('[socket] ingest failed', e);
        reply({ ok: false, accepted: false, reason: 'server_error' });
      }
    });

    socket.on('track:subscribe', async ({ route_id } = { route_id: '' }, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      let allowed = isStaff(me);
      if (!allowed && me.role === 'student') allowed = (await repo.studentRoute(me.userId))?.route_id === route_id;
      if (!allowed && me.role === 'driver') {
        const busId = await repo.driverBusId(me.userId);
        allowed = !!busId && (await repo.bus(busId))?.route_id === route_id;
      }
      if (!allowed) return reply({ ok: false, error: 'not_allowed' });
      await socket.join(`route:${route_id}`);
      reply({ ok: true });
    });

    socket.on('track:unsubscribe', ({ route_id } = { route_id: '' }) => void socket.leave(`route:${route_id}`));
  });

  return {
    http, io, tracker, repo, seats,
    close: async () => {
      seats.stop();
      await tracker.flush();
      await new Promise<void>((r) => io.close(() => r()));
    },
  };
}
