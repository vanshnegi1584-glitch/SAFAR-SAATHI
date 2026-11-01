import { haversine, type DriverLocationPayload, type LocationAck, type TrackingClient } from '@transitlink/shared';
import * as Location from 'expo-location';

// Driver GPS: acquires high-accuracy fixes while a trip is open and publishes them to the tracking
// server. It reports exactly what is happening — permission, services, accuracy, delivery — and never
// claims to be tracking when it is not.

export type GpsState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'denied'; canAskAgain: boolean }
  | { kind: 'services_off' }
  | { kind: 'approximate_only' }
  | { kind: 'acquiring' }
  | { kind: 'tracking' }
  | { kind: 'error'; message: string };

export interface GpsStats {
  lastFixAt: number | null;
  lastAccuracyM: number | null;
  lastSentAt: number | null;
  lastAck: LocationAck | null;
  queued: number;
  sent: number;
  rejected: number;
}

export interface PublisherOptions {
  /** Publish interval while moving. */
  movingIntervalMs: number;
  /** Publish interval while parked (saves battery and data; the server still sees the bus as live). */
  stationaryIntervalMs: number;
  /** Fixes kept while offline (≈30 min at 2 s); the server ignores anything older anyway. */
  maxQueue: number;
}

const DEFAULTS: PublisherOptions = { movingIntervalMs: 2000, stationaryIntervalMs: 5000, maxQueue: 900 };

export function toPayload(loc: Location.LocationObject, trip: { id: string; bus_id: string }): DriverLocationPayload {
  const c = loc.coords;
  return {
    busId: trip.bus_id,
    tripId: trip.id,
    latitude: c.latitude,
    longitude: c.longitude,
    accuracyMeters: c.accuracy ?? null,
    speedMetersPerSecond: c.speed ?? null,
    headingDegrees: c.heading ?? null,
    timestamp: new Date(loc.timestamp).toISOString(),
    // The fix's own timestamp (ms) is strictly increasing per device and survives app restarts and the
    // foreground/background hand-off, unlike an in-memory counter.
    sequence: Math.round(loc.timestamp),
    source: 'driver_device',
  };
}

/** Checks services and permission, asking once if allowed. Returns the blocking state, or null if OK. */
export async function ensureForegroundLocation(): Promise<GpsState | null> {
  if (!(await Location.hasServicesEnabledAsync())) return { kind: 'services_off' };
  let perm = await Location.getForegroundPermissionsAsync();
  if (!perm.granted && perm.canAskAgain) perm = await Location.requestForegroundPermissionsAsync();
  if (!perm.granted) return { kind: 'denied', canAskAgain: perm.canAskAgain };
  // Approximate location (Android "coarse", iOS "reduced") is ~1–3 km: useless for tracking a bus.
  if (perm.android?.accuracy === 'coarse' || perm.ios?.accuracy === 'reduced') return { kind: 'approximate_only' };
  return null;
}

export class GpsPublisher {
  private sub: Location.LocationSubscription | null = null;
  private queue: DriverLocationPayload[] = [];
  private pending: DriverLocationPayload | null = null;
  private lastSent: DriverLocationPayload | null = null;
  private flushing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: PublisherOptions;
  stats: GpsStats = { lastFixAt: null, lastAccuracyM: null, lastSentAt: null, lastAck: null, queued: 0, sent: 0, rejected: 0 };

  constructor(
    private readonly client: TrackingClient,
    private readonly trip: { id: string; bus_id: string },
    private readonly onChange: (state: GpsState, stats: GpsStats) => void,
    opts: Partial<PublisherOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  private state: GpsState = { kind: 'idle' };
  private emit(state: GpsState = this.state) {
    this.state = state;
    this.stats = { ...this.stats, queued: this.queue.length };
    this.onChange(state, this.stats);
  }

  async start(): Promise<GpsState> {
    this.emit({ kind: 'requesting' });
    const blocked = await ensureForegroundLocation();
    if (blocked) {
      this.emit(blocked);
      return blocked;
    }
    this.emit({ kind: 'acquiring' });
    try {
      this.sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0, mayShowUserSettingsDialog: true },
        (loc) => this.onFix(loc),
        (reason) => this.emit({ kind: 'error', message: String(reason) }),
      );
    } catch (e) {
      this.emit({ kind: 'error', message: (e as Error).message });
      return this.state;
    }
    // Drives publishing and retries independently of how often the OS delivers fixes.
    this.timer = setInterval(() => void this.tick(), 500);
    return this.state;
  }

  stop(): void {
    this.sub?.remove();
    this.sub = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit({ kind: 'idle' });
  }

  private onFix(loc: Location.LocationObject) {
    this.pending = toPayload(loc, this.trip);
    this.stats = { ...this.stats, lastFixAt: loc.timestamp, lastAccuracyM: loc.coords.accuracy ?? null };
    if (this.state.kind !== 'tracking') this.emit({ kind: 'tracking' });
    void this.tick();
  }

  private isStationary(p: DriverLocationPayload): boolean {
    const last = this.lastSent;
    if (!last) return false;
    const moved = haversine([last.longitude, last.latitude], [p.longitude, p.latitude]);
    return (p.speedMetersPerSecond ?? 0) < 0.5 && moved < Math.max(5, p.accuracyMeters ?? 5);
  }

  private async tick() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // Backlog first, in order: the server rejects anything older than what it already accepted.
      if (this.queue.length && this.client.connected) {
        const batch = this.queue.slice(0, 200);
        try {
          const { acks } = await this.client.postLocations(batch);
          this.queue.splice(0, batch.length);
          this.stats.sent += acks.filter((a) => a.accepted).length;
          this.stats.rejected += acks.filter((a) => !a.accepted).length;
        } catch {
          return; // still offline; try again next tick
        }
      }
      const p = this.pending;
      if (!p) return;
      const interval = this.isStationary(p) ? this.opts.stationaryIntervalMs : this.opts.movingIntervalMs;
      if (this.stats.lastSentAt !== null && Date.now() - this.stats.lastSentAt < interval) return;
      this.pending = null;
      this.lastSent = p;
      this.stats.lastSentAt = Date.now();
      const ack = this.queue.length ? null : await this.client.sendLocation(p);
      if (!ack) {
        this.queue.push(p);
        if (this.queue.length > this.opts.maxQueue) this.queue.shift();
      } else {
        this.stats.lastAck = ack;
        if (ack.accepted) this.stats.sent++;
        else this.stats.rejected++;
      }
    } finally {
      this.flushing = false;
      this.emit();
    }
  }
}
