import type { ScheduledDeparture } from './alternatives';
import { displayPeople, displaySeats } from './freshness';
import type { BusSeatsEvent, TripDirection, TripSummary } from './trackingTypes';

/**
 * "Bus 18 is full — leaving now. Next: Bus 9 opens for boarding." When a bus's fresh reading says it
 * is full, find the bus that takes over the same route and direction: another bus boarding now, else
 * one on the same departure time, else the next departure time.
 */

/** Full by a fresh reading: no seat free, or as many people on board as the bus has seats. */
export function isFull(e: BusSeatsEvent | undefined, serverNowMs: number): boolean {
  const seats = displaySeats(e, serverNowMs);
  if (seats && seats.free === 0) return true;
  const people = displayPeople(e, serverNowMs);
  return !!people && e!.capacity !== null && people.count >= e!.capacity;
}

export interface NextBus {
  bus_id: string;
  /** boarding: on the road, not yet left its first stop. same_time: timetabled at the same departure time. later: the next time. */
  kind: 'boarding' | 'same_time' | 'later';
  trip_id?: string;
  slot_id?: string;
  departs_at?: number;
}

export interface FullBusAlert {
  bus_id: string;
  trip_id: string;
  route_id: string;
  direction: TripDirection;
  people: number | null;
  capacity: number | null;
  /** Still at its first stop: it should leave now. Otherwise it is already on its way and takes no one more. */
  leaving: boolean;
  next: NextBus | null;
}

const open = (t: TripSummary) => t.status !== 'completed' && t.status !== 'cancelled';
/** Departures within this much of the full bus's time count as the same departure. */
const SAME_TIME_MS = 5 * 60_000;

export function fullBusAlerts(input: {
  trips: TripSummary[];
  seats: Record<string, BusSeatsEvent>;
  scheduled?: ScheduledDeparture[];
  now: number;
}): FullBusAlert[] {
  const { trips, seats, now } = input;
  const full = (busId: string) => isFull(seats[busId], now);
  const alerts: FullBusAlert[] = [];
  for (const t of trips.filter(open)) {
    if (!full(t.bus_id)) continue;
    const sameWay = (x: { bus_id: string; route_id: string; direction: TripDirection }) =>
      x.bus_id !== t.bus_id && x.route_id === t.route_id && x.direction === t.direction && !full(x.bus_id);

    let next: NextBus | null = null;
    const boarding = trips.filter((x) => open(x) && sameWay(x) && !x.departed_at)
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))[0];
    if (boarding) next = { bus_id: boarding.bus_id, kind: 'boarding', trip_id: boarding.id, ...(boarding.slot_id ? { slot_id: boarding.slot_id } : {}) };
    else {
      const onRoad = new Set(trips.filter(open).map((x) => `${x.bus_id}|${x.slot_id}`));
      const mine = t.scheduled_departure ? Date.parse(t.scheduled_departure) : now;
      const d = (input.scheduled ?? [])
        .filter((s) => sameWay(s) && !onRoad.has(`${s.bus_id}|${s.slot_id}`) && s.departs_at >= Math.min(mine, now) - SAME_TIME_MS)
        .sort((a, b) => a.departs_at - b.departs_at)[0];
      if (d) next = { bus_id: d.bus_id, kind: Math.abs(d.departs_at - mine) <= SAME_TIME_MS ? 'same_time' : 'later', slot_id: d.slot_id, departs_at: d.departs_at };
    }
    const e = seats[t.bus_id]!;
    alerts.push({
      bus_id: t.bus_id, trip_id: t.id, route_id: t.route_id, direction: t.direction,
      people: displayPeople(e, now)?.count ?? null, capacity: e.capacity, leaving: !t.departed_at, next,
    });
  }
  return alerts;
}
