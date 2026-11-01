import type { BusSeatsEvent, PeopleSource, PublicBus, SeatSource } from '@transitlink/shared';
import type { Repo } from './repo';
import { roomsFor, type Broadcast } from './tracker';

// Reads free seats from each bus's on-board vision fusion service (ai_face/vision/service.py,
// `GET /fusion`) and relays them to the same rooms as that bus's location. The vision service decides
// camera vs. IR; this side only checks the answer is for the right bus, fresh, and consistent with the
// schedule — anything doubtful is published as "unavailable" rather than as a number.

export interface SeatPollerOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Re-send an unchanged reading this often so clients can tell it is still current. */
  heartbeatMs: number;
}

const DEFAULTS: SeatPollerOptions = { intervalMs: 2000, timeoutMs: 1500, heartbeatMs: 5000 };
const SOURCES: SeatSource[] = ['camera', 'ir', 'unavailable'];
const PEOPLE_SOURCES: PeopleSource[] = ['ir', 'camera', 'unavailable'];
const BUS_CACHE_MS = 60_000;

/** The part of the vision service's /fusion response this module relies on. */
interface FusionResponse {
  bus_id: string;
  seats_free: number | null;
  capacity: number;
  source: SeatSource;
  reason: string;
  recalibration_required: boolean;
  people_on_board: number | null;
  people_source: PeopleSource;
}

export function parseFusion(body: unknown): FusionResponse | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (typeof b.bus_id !== 'string' || !int(b.capacity) || (b.capacity as number) < 1) return null;
  if (b.seats_free !== null && !(int(b.seats_free) && (b.seats_free as number) <= (b.capacity as number))) return null;
  if (!SOURCES.includes(b.source as SeatSource)) return null;
  if (b.source !== 'unavailable' && b.seats_free === null) return null;
  // Older vision services send no people fields (treated as unavailable); bad values never pass as numbers.
  const peopleOk = int(b.people_on_board) && (b.people_on_board as number) <= 2 * (b.capacity as number)
    && PEOPLE_SOURCES.includes(b.people_source as PeopleSource) && b.people_source !== 'unavailable';
  return {
    bus_id: b.bus_id,
    seats_free: b.seats_free as number | null,
    capacity: b.capacity as number,
    source: b.source as SeatSource,
    reason: typeof b.reason === 'string' ? b.reason.slice(0, 60) : 'unknown',
    recalibration_required: b.recalibration_required === true,
    people_on_board: peopleOk ? (b.people_on_board as number) : null,
    people_source: peopleOk ? (b.people_source as PeopleSource) : 'unavailable',
  };
}

export class SeatPoller {
  private readonly opts: SeatPollerOptions;
  private latest = new Map<string, BusSeatsEvent>();
  private lastSent = new Map<string, number>();
  private buses = new Map<string, { bus: PublicBus | null; until: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly repo: Repo,
    private readonly broadcast: Broadcast,
    /** Our bus id (e.g. bus-uk07pa1696) → base URL of that bus's vision service. */
    private readonly sources: Record<string, string>,
    private readonly now: () => number = Date.now,
    opts: Partial<SeatPollerOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get configured(): number {
    return Object.keys(this.sources).length;
  }

  start(): void {
    if (this.timer || this.configured === 0) return;
    this.timer = setInterval(() => void this.pollOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  events(): BusSeatsEvent[] {
    const now = this.now();
    return [...this.latest.values()].map((e) => ({ ...e, server_time: now }));
  }

  private async bus(busId: string): Promise<PublicBus | null> {
    const hit = this.buses.get(busId);
    if (hit && hit.until > this.now()) return hit.bus;
    const bus = await this.repo.bus(busId);
    this.buses.set(busId, { bus, until: this.now() + BUS_CACHE_MS });
    return bus;
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return; // a slow service must not pile up overlapping polls
    this.polling = true;
    try {
      await Promise.all(Object.entries(this.sources).map(([busId, url]) => this.pollBus(busId, url)));
    } finally {
      this.polling = false;
    }
  }

  private async pollBus(busId: string, baseUrl: string): Promise<void> {
    const bus = await this.bus(busId).catch(() => null);
    const base = { bus_id: busId, route_id: bus?.route_id ?? null, capacity: bus?.seats ?? null };
    const unavailable = (reason: string, recal = false): BusSeatsEvent => ({
      ...base, seats_free: null, source: 'unavailable', reason, recalibration_required: recal,
      people_on_board: null, people_source: 'unavailable',
      received_at: this.now(), server_time: this.now(),
    });

    let event: BusSeatsEvent;
    if (!bus) {
      event = unavailable('unknown_bus');
    } else {
      let fusion: FusionResponse | null = null;
      let failure = 'unreachable';
      try {
        const res = await fetch(new URL('/fusion', baseUrl), { signal: AbortSignal.timeout(this.opts.timeoutMs) });
        if (res.ok) {
          fusion = parseFusion(await res.json());
          failure = 'invalid_response';
        }
      } catch {
        // timeout or connection refused: reported as unreachable below
      }
      if (!fusion) event = unavailable(failure);
      // The vision service is configured by fleet number ("18"); a wrong URL must not mislabel a bus.
      else if (fusion.bus_id !== bus.fleet_number) event = unavailable('bus_mismatch');
      // Its capacity must match the schedule, or "N free" means nothing.
      else if (bus.seats !== null && fusion.capacity !== bus.seats) event = unavailable('capacity_mismatch', fusion.recalibration_required);
      else {
        event = {
          ...base, seats_free: fusion.source === 'unavailable' ? null : fusion.seats_free, source: fusion.source,
          reason: fusion.reason, recalibration_required: fusion.recalibration_required,
          people_on_board: fusion.people_on_board, people_source: fusion.people_source,
          received_at: this.now(), server_time: this.now(),
        };
      }
    }

    const prev = this.latest.get(busId);
    this.latest.set(busId, event);
    const changed = !prev || prev.seats_free !== event.seats_free || prev.source !== event.source
      || prev.reason !== event.reason || prev.recalibration_required !== event.recalibration_required
      || prev.people_on_board !== event.people_on_board || prev.people_source !== event.people_source;
    const due = this.now() - (this.lastSent.get(busId) ?? 0) >= this.opts.heartbeatMs;
    if (changed || due) {
      this.lastSent.set(busId, this.now());
      const rooms = event.route_id ? roomsFor({ route_id: event.route_id, bus_id: busId }) : ['dispatch', `bus:${busId}`];
      this.broadcast(rooms, 'bus:seats', event);
    }
  }
}

/** SEAT_SOURCES='{"bus-uk07pa1696":"http://10.0.0.21:8000"}' → validated map. */
export function parseSeatSources(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SEAT_SOURCES must be JSON: {"bus-<registration>": "http://host:port"}');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('SEAT_SOURCES must be a JSON object');
  const out: Record<string, string> = {};
  for (const [busId, url] of Object.entries(parsed)) {
    if (!/^bus-[a-z0-9-]+$/.test(busId)) throw new Error(`SEAT_SOURCES: "${busId}" is not a bus id like bus-uk07pa1696`);
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error(`SEAT_SOURCES: URL for ${busId} must start with http:// or https://`);
    out[busId] = url;
  }
  return out;
}
