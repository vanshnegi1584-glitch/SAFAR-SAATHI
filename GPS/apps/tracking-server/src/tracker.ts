import {
  advanceProgress, assessFix, buildRoutePlan, effectiveFixTime, estimateRouteEta, freshnessOf, haversine,
  initialProgress, localDate, mapDepartureSlots, parseDriverLocation, routeProblems, slotRuns, zonedTimeToUtc,
  type BusLocationEvent, type DirectedRoutePlan, type FixGateState, type LngLat, type LocationAck, type LocationFix,
  type ProgressState, type RouteProgress, type TrackingServerEvents, type TripDirection, type TripSummary,
} from '@transitlink/shared';
import { isStaff, type Principal } from './auth';
import type { ServerConfig } from './config';
import { HttpError } from './errors';
import { tripSummary, type Repo, type RouteSnapshot, type TripRow } from './repo';

export type Broadcast = <E extends keyof TrackingServerEvents>(
  rooms: string[], event: E, ...args: Parameters<TrackingServerEvents[E]>
) => void;

/** Who receives a trip's events: dispatchers, students on the route, and the bus's driver. */
export const roomsFor = (t: { route_id: string; bus_id: string }) => ['dispatch', `route:${t.route_id}`, `bus:${t.bus_id}`];

interface LiveTrip {
  row: TripRow;
  summary: TripSummary;
  plan: DirectedRoutePlan | null;
  gate: FixGateState;
  progress: ProgressState;
  routeProgress: RouteProgress | null;
  last: BusLocationEvent | null;
  speedEma: number | null;
  stationarySince: number | null;
  stationaryAnchor: LngLat | null;
  notified: 'live' | 'stale' | 'offline';
  /** Assignment re-check cache: driver id → valid until (ms). */
  authOkUntil: number;
  /** Serialises DB writes per trip so history and trip state stay in order. */
  persist: Promise<void>;
}

const ASSIGNMENT_RECHECK_MS = 60_000;
const AUTO_COMPLETE_AFTER_ARRIVAL_MS = 15 * 60_000;

export class Tracker {
  private trips = new Map<string, LiveTrip>();
  private tripByBus = new Map<string, string>();
  private latencies: number[] = [];

  constructor(
    private readonly repo: Repo,
    private readonly broadcast: Broadcast,
    private readonly cfg: ServerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** Restores open trips after a restart, including the last accepted fix and route progress. */
  async load(): Promise<void> {
    for (const row of await this.repo.openTrips()) {
      const t = this.register(row);
      const fix = await this.repo.lastFix(row.id);
      if (fix) {
        t.gate = { last: fix, pendingJumps: [] };
        if (t.plan) {
          const step = advanceProgress(t.plan, initialProgress(), fix, true, this.cfg.progress);
          t.progress = step.state;
          t.routeProgress = step.progress;
        }
        // Restored positions are history, not live: shown as stale until a new fix arrives.
        t.last = this.buildEvent(t, fix, fix.measured_at);
        t.notified = 'offline';
      }
    }
  }

  private register(row: TripRow): LiveTrip {
    const snap = row.route_snapshot;
    const stops = new Map(snap.stops.map((s) => [s.id, s]));
    const problems = routeProblems({ route: snap.route, stops });
    const plan = problems.length === 0 ? buildRoutePlan({ route: snap.route, stops }, row.direction) : null;
    const t: LiveTrip = {
      row, plan, summary: tripSummary(row, plan !== null, problems),
      gate: { last: null, pendingJumps: [] }, progress: initialProgress(), routeProgress: null, last: null,
      speedEma: null, stationarySince: null, stationaryAnchor: null, notified: 'live', authOkUntil: 0,
      persist: Promise.resolve(),
    };
    this.trips.set(row.id, t);
    this.tripByBus.set(row.bus_id, row.id);
    return t;
  }

  openTrips(): TripSummary[] {
    return [...this.trips.values()].map((t) => t.summary);
  }

  latest(): BusLocationEvent[] {
    return [...this.trips.values()].flatMap((t) => (t.last ? [{ ...t.last, server_time: this.now() }] : []));
  }

  tripForBus(busId: string): TripSummary | null {
    const id = this.tripByBus.get(busId);
    return id ? this.trips.get(id)?.summary ?? null : null;
  }

  // ---- trip lifecycle -------------------------------------------------------------------------

  async startTrip(driver: Principal, input: { direction?: unknown; slot_id?: unknown }): Promise<TripSummary> {
    if (driver.role !== 'driver') throw new HttpError(403, 'not_driver', 'Only drivers can start trips');
    const direction = input.direction as TripDirection;
    if (direction !== 'TO_COLLEGE' && direction !== 'FROM_COLLEGE') {
      throw new HttpError(400, 'bad_direction', 'direction must be TO_COLLEGE or FROM_COLLEGE');
    }
    const busId = await this.repo.driverBusId(driver.userId);
    if (!busId) throw new HttpError(403, 'no_assignment', 'No bus is assigned to your account. Ask the transport office.');
    const bus = await this.repo.bus(busId);
    if (!bus?.is_active || !bus.route_id) throw new HttpError(409, 'bus_inactive', 'Your assigned bus has no active route');

    const open = this.tripForBus(busId);
    if (open) {
      if (open.direction === direction && this.trips.get(open.id)?.row.driver_id === driver.userId) return open; // idempotent retry
      throw new HttpError(409, 'trip_already_open', 'This bus already has an open trip. End it first.');
    }

    let slotId: string | null = null;
    let scheduled: Date | null = null;
    if (input.slot_id != null) {
      const slot = (await this.repo.slots()).find((s) => s.id === input.slot_id);
      if (!slot) throw new HttpError(400, 'bad_slot', 'Unknown departure slot');
      if (slot.direction !== direction) throw new HttpError(400, 'slot_direction', `Slot ${slot.id} is a ${slot.direction} departure`);
      const shifts = await this.repo.busShifts([busId]);
      const mapping = mapDepartureSlots(
        [{ id: busId, shift: shifts.map((s) => ({ index: s.shift_index, raw: s.raw, time: s.local_time, no_service: s.no_service })) }],
        { timezone: this.cfg.timezone, slots: [{ ...slot, time: slot.local_time }] },
        await this.repo.slotDecisions(),
      )[0]!;
      if (!slotRuns(mapping.status)) {
        throw new HttpError(409, 'slot_not_confirmed', `This bus is not confirmed for ${slot.label} (${mapping.note}). Start without a slot or ask an admin.`);
      }
      slotId = slot.id;
      scheduled = zonedTimeToUtc(localDate(new Date(this.now()), this.cfg.timezone), slot.local_time, this.cfg.timezone);
    }

    const snapshot = await this.repo.routeConfig(bus.route_id);
    if (!snapshot) throw new HttpError(409, 'route_missing', 'Route configuration not found');
    let row: TripRow;
    try {
      row = await this.repo.insertTrip({
        bus_id: busId, route_id: bus.route_id, route_version: snapshot.route.version, route_snapshot: snapshot,
        direction, slot_id: slotId, scheduled_departure: scheduled, driver_id: driver.userId,
      });
    } catch (e) {
      if (/campus_one_open_trip_per_bus/.test((e as Error).message)) throw new HttpError(409, 'trip_already_open', 'This bus already has an open trip');
      throw e;
    }
    const t = this.register(row);
    t.authOkUntil = this.now() + ASSIGNMENT_RECHECK_MS;
    this.broadcast(roomsFor(row), 'trip:started', t.summary);
    return t.summary;
  }

  async endTrip(by: Principal, tripId: string, reason = 'ended_by_driver'): Promise<TripSummary> {
    const t = this.trips.get(tripId);
    if (!t) throw new HttpError(404, 'trip_not_open', 'Trip is not open');
    if (!isStaff(by) && t.row.driver_id !== by.userId) throw new HttpError(403, 'not_your_trip', 'You can only end your own trip');
    return this.finish(t, reason);
  }

  private async finish(t: LiveTrip, reason: string): Promise<TripSummary> {
    const nowIso = new Date(this.now()).toISOString();
    t.summary = { ...t.summary, status: t.summary.first_fix_at ? 'completed' : 'cancelled', completed_at: nowIso };
    this.trips.delete(t.row.id);
    this.tripByBus.delete(t.row.bus_id);
    await t.persist;
    await this.repo.updateTrip(t.row.id, t.summary, t.gate.last?.sequence ?? null, reason);
    this.broadcast(roomsFor(t.row), 'trip:ended', t.summary);
    return t.summary;
  }

  // ---- telemetry ingest -----------------------------------------------------------------------

  async ingest(by: Principal, raw: unknown): Promise<LocationAck> {
    const parsed = parseDriverLocation(raw);
    if (!parsed.ok) return { ok: false, accepted: false, reason: `invalid: ${parsed.error}` };
    const p = parsed.value;
    const t = this.trips.get(p.tripId);
    if (!t) return { ok: false, accepted: false, reason: 'trip_not_active' };

    // Authorisation is decided by the server's trip record, never by ids in the payload.
    if (by.role !== 'driver' || t.row.driver_id !== by.userId || t.row.bus_id !== p.busId) {
      return { ok: false, accepted: false, reason: 'not_authorised_for_bus' };
    }
    if (p.source !== 'driver_device') return { ok: false, accepted: false, reason: 'source_not_allowed' };
    const now = this.now();
    if (t.authOkUntil < now) {
      if ((await this.repo.driverBusId(by.userId)) !== t.row.bus_id) return { ok: false, accepted: false, reason: 'assignment_revoked' };
      t.authOkUntil = now + ASSIGNMENT_RECHECK_MS;
    }

    const fix: LocationFix = {
      latitude: p.latitude, longitude: p.longitude, accuracy_m: p.accuracyMeters, speed_mps: p.speedMetersPerSecond,
      heading_deg: p.headingDegrees, measured_at: p.measured_at, sequence: p.sequence, source: p.source,
    };
    const { verdict, state } = assessFix(fix, t.gate, now, this.cfg.fix);
    if (!verdict.accept) return { ok: true, accepted: false, reason: verdict.reason, sequence: fix.sequence };
    t.gate = state;
    this.latencies.push(now - fix.measured_at);

    const before = JSON.stringify(t.summary);
    if (!t.summary.first_fix_at) t.summary = { ...t.summary, first_fix_at: new Date(fix.measured_at).toISOString(), status: 'active' };
    this.updateMotion(t, fix, verdict.quality !== 'poor');

    if (t.plan) {
      const step = advanceProgress(t.plan, t.progress, fix, verdict.usableForMatching, this.cfg.progress);
      t.progress = step.state;
      t.routeProgress = step.progress;
      for (const ev of step.events) {
        const at = new Date(ev.at).toISOString();
        if (ev.type === 'departed') t.summary = { ...t.summary, departed_at: at };
        if (ev.type === 'arrived') {
          if (ev.final) t.summary = { ...t.summary, status: 'arrived', arrived_at: at };
          this.broadcast(roomsFor(t.row), 'bus:arrived', {
            bus_id: t.row.bus_id, trip_id: t.row.id, stop_id: ev.stop.stop_id, stop_name: ev.stop.name, final: ev.final, at: ev.at,
          });
        }
        if (ev.type === 'deviation') {
          this.broadcast(roomsFor(t.row), 'route:deviation', {
            bus_id: t.row.bus_id, trip_id: t.row.id, distance_from_route_m: ev.distance_m, resolved: ev.resolved, at: ev.at,
          });
        }
      }
    }

    const event = this.buildEvent(t, fix, now, verdict.quality);
    if (verdict.live) {
      t.last = event;
      t.notified = 'live';
      this.broadcast(roomsFor(t.row), 'bus:location', event);
    }
    const changed = JSON.stringify(t.summary) !== before;
    if (changed) this.broadcast(roomsFor(t.row), 'trip:updated', t.summary);

    // Broadcast first, then persist: storage latency never delays live delivery.
    const summary = t.summary;
    t.persist = t.persist
      .then(() => this.repo.saveFix(event, fix, verdict.live))
      .then(() => (changed ? this.repo.updateTrip(t.row.id, summary, fix.sequence) : undefined))
      .catch((e) => console.error(`[tracker] failed to persist fix for trip ${t.row.id}:`, (e as Error).message));
    return { ok: true, accepted: true, sequence: fix.sequence };
  }

  private updateMotion(t: LiveTrip, fix: LocationFix, reliable: boolean) {
    const pos: LngLat = [fix.longitude, fix.latitude];
    if (reliable && fix.speed_mps !== null) t.speedEma = t.speedEma === null ? fix.speed_mps : 0.3 * fix.speed_mps + 0.7 * t.speedEma;
    if (!reliable) return;
    if (!t.stationaryAnchor || haversine(t.stationaryAnchor, pos) > 25) {
      t.stationaryAnchor = pos;
      t.stationarySince = (fix.speed_mps ?? 0) < 0.7 ? fix.measured_at : null;
    } else if (t.stationarySince === null) {
      t.stationarySince = fix.measured_at;
    }
  }

  private buildEvent(t: LiveTrip, fix: LocationFix, receivedAt: number, quality?: BusLocationEvent['quality']): BusLocationEvent {
    const now = this.now();
    // No progress until the first fix inside the route corridor has been matched.
    const route = t.progress.along_m !== null ? t.routeProgress : null;
    const freshness = freshnessOf(Math.min(fix.measured_at, receivedAt), now, t.summary.status, this.cfg.freshness);
    return {
      bus_id: t.row.bus_id, trip_id: t.row.id, route_id: t.row.route_id, direction: t.row.direction, source: fix.source,
      location: [fix.longitude, fix.latitude], accuracy_m: fix.accuracy_m, speed_mps: fix.speed_mps, heading_deg: fix.heading_deg,
      quality: quality ?? 'poor', measured_at: fix.measured_at, received_at: receivedAt, sequence: fix.sequence,
      route,
      eta: estimateRouteEta({
        routeReady: t.plan !== null,
        freshness,
        arrived: t.summary.status === 'arrived',
        remainingToDestinationM: route?.remaining_to_destination_m ?? null,
        remainingToNextStopM: route?.remaining_to_next_stop_m ?? null,
        speedMps: t.speedEma,
        stationarySinceMs: t.stationarySince,
        nowMs: now,
      }, this.cfg.eta),
      server_time: now,
    };
  }

  // ---- background -----------------------------------------------------------------------------

  /** Emits bus:stale / bus:offline once per transition, and closes long-arrived trips. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const t of [...this.trips.values()]) {
      if (t.summary.status === 'arrived' && t.summary.arrived_at && now - Date.parse(t.summary.arrived_at) > AUTO_COMPLETE_AFTER_ARRIVAL_MS) {
        await this.finish(t, 'auto_completed_after_arrival');
        continue;
      }
      if (!t.last) continue;
      const age = now - effectiveFixTime(t.last);
      const payload = { bus_id: t.row.bus_id, trip_id: t.row.id, last_measured_at: t.last.measured_at, server_time: now };
      if (age > this.cfg.freshness.offlineAfterSec * 1000 && t.notified !== 'offline') {
        t.notified = 'offline';
        this.broadcast(roomsFor(t.row), 'bus:offline', payload);
      } else if (age > this.cfg.freshness.delayedMaxSec * 1000 && t.notified === 'live') {
        t.notified = 'stale';
        this.broadcast(roomsFor(t.row), 'bus:stale', payload);
      }
    }
  }

  /** Measurement → server receipt delay of accepted fixes since the last call. */
  takeLatencyStats(): { count: number; p50: number; p95: number; max: number } | null {
    if (this.latencies.length === 0) return null;
    const s = this.latencies.sort((a, b) => a - b);
    this.latencies = [];
    const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))]!;
    return { count: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]! };
  }

  /** Waits for queued DB writes (tests, graceful shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.trips.values()].map((t) => t.persist));
  }
}

export type { RouteSnapshot };
