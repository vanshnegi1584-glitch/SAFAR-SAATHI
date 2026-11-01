import { Emitter } from '../emitter';
import { haversine, pointAlongLine, polylineLength } from '../geo';
import type { FleetSnapshot, TransitDataSource } from '../source';
import { normalizeMqtt } from '../telemetry';
import type {
  ActiveTrip, DigitalToken, FallbackSuggestion, LngLat, MqttTelemetryPayload, Route, ServerToClientEvents, Stop, TelemetryUpdate, TokenStatus,
} from '../types';
import { findFallbackRoute } from '../fallback';
import { BUSES, CAMPUS, ROUTES, STOPS, STUDENT_NAMES, TRIPS } from './data';

export interface MockOptions {
  tickMs?: number;
  /** Simulated distance multiplier so movement is visible in a demo. */
  timeScale?: number;
  /** Bus that periodically loses GSM and bulk-publishes on reconnect (Blueprint §6). */
  partitionBusId?: string | null;
  seed?: number;
  /** Simulate a dispatcher calling/boarding tokens (for the mobile app, which has no dispatcher UI). */
  autoDispatch?: boolean;
}

interface SimBus {
  busId: string;
  tripId: string;
  line: LngLat[];
  length: number;
  along: number;
  dir: 1 | -1;
  speedKmh: number;
  dwell: number;
  lastStopId: string | null;
  inCount: number;
  outCount: number;
  capacity: number;
  sos: boolean;
  buffered: TelemetryUpdate[];
}

/** Deterministic PRNG so demos and tests are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MockTransitSource implements TransitDataSource {
  readonly kind = 'mock' as const;
  private readonly events = new Emitter<ServerToClientEvents>();
  private readonly opts: Required<MockOptions>;
  private readonly rand: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private sims: SimBus[];
  private tokens: DigitalToken[] = [];
  private nextTokenId = 1;
  // Per-instance copies so road geometry from Google can replace the straight-line mock data.
  private routes: Route[] = ROUTES.map((r) => ({ ...r }));
  private stops: Stop[] = STOPS.map((s) => ({ ...s }));
  private trips: ActiveTrip[] = TRIPS.map((t) => ({ ...t }));

  constructor(opts: MockOptions = {}) {
    this.opts = { tickMs: 2000, timeScale: 6, partitionBusId: 'B-404', seed: 42, autoDispatch: false, ...opts };
    this.rand = mulberry32(this.opts.seed);
    this.sims = this.trips.map((trip, i) => {
      const route = this.routes.find((r) => r.id === trip.route_id)!;
      const bus = BUSES.find((b) => b.id === trip.bus_id)!;
      const length = polylineLength(route.polyline);
      const inCount = 10 + Math.floor(this.rand() * 25);
      return {
        busId: bus.id, tripId: trip.id, line: route.polyline, length,
        along: (length * (i + 1)) / (this.trips.length + 1), dir: 1, speedKmh: 25,
        dwell: 0, lastStopId: null, inCount, outCount: 0, capacity: bus.max_capacity,
        sos: false, buffered: [],
      };
    });
    for (const trip of this.trips) {
      const n = 6 + Math.floor(this.rand() * 10);
      for (let k = 0; k < n; k++) this.addToken(trip.id, k < 2 ? 'called' : 'waiting');
    }
  }

  connect(): void {
    if (this.timer) return;
    this.step(); // emit an initial position immediately
    this.timer = setInterval(() => this.step(), this.opts.tickMs);
  }

  disconnect(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  on<E extends keyof ServerToClientEvents>(event: E, handler: ServerToClientEvents[E]) {
    return this.events.on(event, handler);
  }

  async getSnapshot(): Promise<FleetSnapshot> {
    return { routes: this.routes, stops: this.stops, buses: BUSES, trips: this.trips };
  }

  async getFallbackSuggestion(studentId: string, defaultRouteId: string, home: LngLat): Promise<FallbackSuggestion | null> {
    const paxByBus = Object.fromEntries(this.sims.map((s) => [s.busId, s.inCount - s.outCount]));
    return findFallbackRoute({
      studentId, defaultRouteId, home, paxByBus, boardingPoint: CAMPUS,
      snapshot: await this.getSnapshot(),
    });
  }

  /**
   * §6 "Last Bus Departure": a geofence exit from campus by a trip flagged is_last_bus ends that
   * trip and notifies students (the backend would also send FCM pushes here).
   */
  async reportGeofenceEvent(e: { bus_id: string; region_id: string; event: 'enter' | 'exit'; timestamp: number }): Promise<void> {
    if (e.region_id !== 'campus' || e.event !== 'exit') return;
    const trip = this.trips.find((t) => t.bus_id === e.bus_id && t.end_time === null);
    if (trip?.is_last_bus) this.endTrip(trip.id);
  }

  /** Demo helper: marks a trip as departed/ended. */
  endTrip(tripId: string): void {
    const trip = this.trips.find((t) => t.id === tripId);
    if (!trip || trip.end_time !== null) return;
    this.trips = this.trips.map((t) => (t.id === tripId ? { ...t, end_time: new Date().toISOString() } : t));
    if (trip.is_last_bus) this.events.emit('trip:last_bus_departed', { route_id: trip.route_id, trip_id: trip.id });
  }

  /**
   * Swap a route's straight-line mock path for a road-following one (e.g. from Google Routes).
   * Buses keep their relative progress, so they move onto the road instead of restarting.
   */
  setRouteGeometry(routeId: string, polyline: LngLat[], stopLocations: Record<string, LngLat> = {}): void {
    if (polyline.length < 2) return;
    this.routes = this.routes.map((r) => (r.id === routeId ? { ...r, polyline } : r));
    this.stops = this.stops.map((s) => (stopLocations[s.id] ? { ...s, location: stopLocations[s.id]! } : s));
    const length = polylineLength(polyline);
    for (const sim of this.sims) {
      if (this.trips.find((t) => t.id === sim.tripId)?.route_id !== routeId) continue;
      sim.along = (sim.along / sim.length) * length;
      sim.line = polyline;
      sim.length = length;
    }
  }

  async getTokens(): Promise<DigitalToken[]> {
    return this.tokens.map((t) => ({ ...t }));
  }

  async updateTokenStatus(tokenId: string, status: TokenStatus): Promise<DigitalToken> {
    const t = this.tokens.find((x) => x.id === tokenId);
    if (!t) throw new Error(`token ${tokenId} not found`);
    t.status = status;
    this.events.emit('token:update', { ...t });
    return { ...t };
  }

  async joinQueue(studentId: string, tripId: string): Promise<DigitalToken> {
    const existing = this.tokens.find(
      (t) => t.student_id === studentId && t.trip_id === tripId && (t.status === 'waiting' || t.status === 'called'),
    );
    if (existing) return { ...existing }; // idempotent: double-tap must not create two tokens
    return { ...this.addToken(tripId, 'waiting', studentId) };
  }

  async raiseSos(busId: string): Promise<void> {
    const sim = this.sims.find((s) => s.busId === busId);
    if (sim) sim.sos = true;
  }

  async clearSos(busId: string): Promise<void> {
    const sim = this.sims.find((s) => s.busId === busId);
    if (sim) sim.sos = false;
    this.events.emit('sos:cleared', { bus_id: busId });
  }

  private addToken(tripId: string, status: TokenStatus, studentId?: string): DigitalToken {
    const pos = this.tokens.filter((t) => t.trip_id === tripId).length + 1;
    const n = this.nextTokenId++;
    const token: DigitalToken = {
      id: `tok-${n}`,
      student_id: studentId ?? `stu-${n}`,
      student_name: studentId ? 'You' : STUDENT_NAMES[n % STUDENT_NAMES.length],
      trip_id: tripId,
      queue_position: pos,
      status,
      created_at: new Date().toISOString(),
    };
    this.tokens.push(token);
    this.events.emit('token:update', { ...token });
    return token;
  }

  private step(): void {
    this.tick++;
    const ts = Math.floor(Date.now() / 1000);
    for (const sim of this.sims) {
      this.advance(sim);
      const payload = this.toMqtt(sim, ts);
      const update = normalizeMqtt(payload, sim.tripId);

      if (sim.busId === this.opts.partitionBusId && this.isPartitioned()) {
        sim.buffered.push(update); // ESP32 queues locally while GSM is down
        continue;
      }
      if (sim.buffered.length) {
        this.events.emit('telemetry:batch', [...sim.buffered, update]);
        sim.buffered = [];
      } else {
        this.events.emit('telemetry:update', update);
      }
      if (sim.sos) {
        this.events.emit('sos:alert', { bus_id: sim.busId, trip_id: sim.tripId, location: update.location, raised_at: ts });
      }
    }
    if (this.tick % 4 === 0) {
      const trip = this.trips[Math.floor(this.rand() * this.trips.length)]!;
      this.addToken(trip.id, 'waiting');
    }
    if (this.opts.autoDispatch && this.tick % 3 === 0) this.dispatchStep();
  }

  /** Per trip: board the earliest called token, then call the next waiting one. */
  private dispatchStep(): void {
    for (const trip of this.trips) {
      const list = this.tokens
        .filter((t) => t.trip_id === trip.id)
        .sort((a, b) => a.queue_position - b.queue_position);
      const called = list.find((t) => t.status === 'called');
      if (called) void this.updateTokenStatus(called.id, 'boarded');
      const waiting = list.find((t) => t.status === 'waiting');
      if (waiting) void this.updateTokenStatus(waiting.id, 'called');
    }
  }

  /** Offline for 10 ticks out of every 45. */
  private isPartitioned(): boolean {
    const phase = this.tick % 45;
    return phase >= 20 && phase < 30;
  }

  private advance(sim: SimBus): void {
    if (sim.dwell > 0) {
      sim.dwell--;
      sim.speedKmh = 0;
      return;
    }
    const target = 22 + this.rand() * 20;
    sim.speedKmh = sim.speedKmh + (target - sim.speedKmh) * 0.4;
    const meters = (sim.speedKmh / 3.6) * (this.opts.tickMs / 1000) * this.opts.timeScale;
    sim.along += meters * sim.dir;
    if (sim.along >= sim.length) { sim.along = sim.length; sim.dir = -1; }
    if (sim.along <= 0) { sim.along = 0; sim.dir = 1; }

    const pos = pointAlongLine(sim.line, sim.along);
    const route = this.trips.find((t) => t.id === sim.tripId)!.route_id;
    const stop = this.stops.find(
      (s) => s.route_id === route && s.id !== sim.lastStopId && haversine(s.location, pos) < s.geofence_radius_meters * 3,
    );
    if (stop) {
      sim.lastStopId = stop.id;
      sim.dwell = 2;
      const current = sim.inCount - sim.outCount;
      const out = Math.floor(this.rand() * Math.min(current, 12));
      const inn = Math.floor(this.rand() * Math.max(0, Math.min(sim.capacity - current + out, 14)));
      sim.outCount += out;
      sim.inCount += inn;
    }
  }

  private toMqtt(sim: SimBus, ts: number): MqttTelemetryPayload {
    const [lon, lat] = pointAlongLine(sim.line, sim.along);
    return {
      bus_id: sim.busId,
      timestamp: ts,
      gps: { lat, lon, speed: Math.round(sim.speedKmh * 10) / 10, sats: 6 + Math.floor(this.rand() * 5) },
      pax: { in_count: sim.inCount, out_count: sim.outCount, net_current: sim.inCount - sim.outCount },
      sos_active: sim.sos,
    };
  }
}
