import { describe, expect, it } from 'vitest';
import { fullBusAlerts, isFull } from './fullBus';
import type { BusSeatsEvent, TripSummary } from './trackingTypes';

const NOW = Date.UTC(2026, 10, 1, 10, 25); // 3:55 PM IST
const AT_4PM = Date.UTC(2026, 10, 1, 10, 30);
const AT_6PM = Date.UTC(2026, 10, 1, 12, 30);

const seats = (bus_id: string, people: number | null, capacity = 41, extra: Partial<BusSeatsEvent> = {}): BusSeatsEvent => ({
  bus_id, route_id: 'clock-tower', seats_free: null, capacity, source: 'unavailable', reason: 'normal', recalibration_required: false,
  people_on_board: people, people_source: people === null ? 'unavailable' : 'camera', received_at: NOW - 2000, server_time: NOW, ...extra,
});
const trip = (id: string, bus_id: string, extra: Partial<TripSummary> = {}): TripSummary => ({
  id, bus_id, route_id: 'clock-tower', route_version: 1, direction: 'FROM_COLLEGE', status: 'active', slot_id: 'pm-1600',
  scheduled_departure: new Date(AT_4PM).toISOString(), started_at: new Date(NOW - 600_000).toISOString(), first_fix_at: null,
  departed_at: null, arrived_at: null, completed_at: null, route_ready: true, route_problems: [], ...extra,
} as TripSummary);
const sched = (bus_id: string, departs_at: number, slot_id: string, route_id = 'clock-tower') =>
  ({ bus_id, route_id, direction: 'FROM_COLLEGE' as const, slot_id, departs_at });

describe('isFull', () => {
  it('is full when people on board reach the seats, or no seat is free', () => {
    expect(isFull(seats('b18', 41), NOW)).toBe(true);
    expect(isFull(seats('b18', 40), NOW)).toBe(false);
    expect(isFull(seats('b18', null, 41, { seats_free: 0, source: 'camera' }), NOW)).toBe(true);
  });
  it('never on an old or missing reading', () => {
    expect(isFull(seats('b18', 41, 41, { received_at: NOW - 60_000 }), NOW)).toBe(false);
    expect(isFull(undefined, NOW)).toBe(false);
  });
});

describe('fullBusAlerts', () => {
  it('a full bus at campus is leaving, and another bus already boarding there opens next', () => {
    const alerts = fullBusAlerts({ now: NOW, trips: [trip('t18', 'b18'), trip('t9', 'b9')], seats: { b18: seats('b18', 41), b9: seats('b9', 12) } });
    expect(alerts).toEqual([expect.objectContaining({ bus_id: 'b18', leaving: true, people: 41, capacity: 41, next: { bus_id: 'b9', kind: 'boarding', trip_id: 't9', slot_id: 'pm-1600' } })]);
  });

  it('otherwise the bus timetabled for the same departure time, then the next time', () => {
    const scheduled = [sched('b10', AT_6PM, 'pm-1800'), sched('b9', AT_4PM, 'pm-1600'), sched('b22', AT_4PM, 'pm-1600', 'ongc')];
    const [same] = fullBusAlerts({ now: NOW, trips: [trip('t18', 'b18')], seats: { b18: seats('b18', 41) }, scheduled });
    expect(same!.next).toEqual({ bus_id: 'b9', kind: 'same_time', slot_id: 'pm-1600', departs_at: AT_4PM });
    const [later] = fullBusAlerts({ now: NOW, trips: [trip('t18', 'b18')], seats: { b18: seats('b18', 41) }, scheduled: scheduled.filter((s) => s.bus_id !== 'b9') });
    expect(later!.next).toEqual({ bus_id: 'b10', kind: 'later', slot_id: 'pm-1800', departs_at: AT_6PM });
  });

  it('skips buses that are full too, other routes and the other direction', () => {
    const alerts = fullBusAlerts({
      now: NOW,
      trips: [trip('t18', 'b18'), trip('t9', 'b9'), trip('t10', 'b10', { direction: 'TO_COLLEGE' }), trip('t22', 'b22', { route_id: 'ongc' })],
      seats: { b18: seats('b18', 41), b9: seats('b9', 41) },
    });
    expect(alerts.map((a) => [a.bus_id, a.next])).toEqual([['b18', null], ['b9', null]]);
  });

  it('a full bus already on its way is not "leaving", and a bus with room raises nothing', () => {
    const [a] = fullBusAlerts({ now: NOW, trips: [trip('t18', 'b18', { departed_at: new Date(NOW - 60_000).toISOString() })], seats: { b18: seats('b18', 41) } });
    expect(a!.leaving).toBe(false);
    expect(fullBusAlerts({ now: NOW, trips: [trip('t18', 'b18')], seats: { b18: seats('b18', 30) } })).toEqual([]);
  });
});
