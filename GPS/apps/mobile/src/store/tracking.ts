import type {
  BusArrivedEvent, BusLocationEvent, BusSeatsEvent, ConnectionState, Me, RouteDeviationEvent, TrackingSnapshot, TripSummary,
} from '@transitlink/shared';
import { create } from 'zustand';

// Live tracking state for the signed-in user. Bus positions only ever come from server events.

interface TrackingState {
  me: Me | null;
  snapshot: TrackingSnapshot | null;
  trips: Record<string, TripSummary>;
  latest: Record<string, BusLocationEvent>;
  /** Free seats per bus from the on-board vision service. */
  seats: Record<string, BusSeatsEvent>;
  /** server clock − device clock, ms; ages are computed in server time so a wrong phone clock can't hide staleness. */
  clockOffsetMs: number;
  connection: ConnectionState;
  lastArrival: BusArrivedEvent | null;
  deviation: Record<string, RouteDeviationEvent>;

  setMe: (me: Me | null) => void;
  setSnapshot: (s: TrackingSnapshot) => void;
  applyLocation: (e: BusLocationEvent) => void;
  applyTrip: (t: TripSummary) => void;
  applySeats: (e: BusSeatsEvent) => void;
  setConnection: (c: ConnectionState) => void;
  setArrival: (a: BusArrivedEvent) => void;
  setDeviation: (d: RouteDeviationEvent) => void;
  reset: () => void;
}

const offsetFrom = (serverTime: number, prev: number | null) => {
  const sample = serverTime - Date.now();
  return prev === null ? sample : 0.8 * prev + 0.2 * sample;
};

const empty = { me: null, snapshot: null, trips: {}, latest: {}, seats: {}, clockOffsetMs: 0, connection: 'disconnected' as const, lastArrival: null, deviation: {} };

export const useTracking = create<TrackingState>((set) => ({
  ...empty,

  setMe: (me) => set({ me }),
  setSnapshot: (s) =>
    set({
      snapshot: s,
      trips: Object.fromEntries(s.trips.map((t) => [t.id, t])),
      latest: Object.fromEntries(s.latest.map((l) => [l.bus_id, l])),
      seats: Object.fromEntries((s.seats ?? []).map((e) => [e.bus_id, e])),
      clockOffsetMs: offsetFrom(s.server_time, null),
    }),
  applySeats: (e) => set((st) => ({ seats: { ...st.seats, [e.bus_id]: e } })),
  applyLocation: (e) =>
    set((st) => {
      const prev = st.latest[e.bus_id];
      // Drop out-of-order events (e.g. after a reconnect replays an older state).
      if (prev && prev.trip_id === e.trip_id && e.sequence <= prev.sequence) return st;
      return { latest: { ...st.latest, [e.bus_id]: e }, clockOffsetMs: offsetFrom(e.server_time, st.clockOffsetMs) };
    }),
  applyTrip: (t) =>
    set((st) => {
      const trips = { ...st.trips, [t.id]: t };
      const latest = { ...st.latest };
      if (t.status === 'completed' || t.status === 'cancelled') {
        if (latest[t.bus_id]?.trip_id === t.id) delete latest[t.bus_id];
      }
      return { trips, latest };
    }),
  setConnection: (connection) => set({ connection }),
  setArrival: (lastArrival) => set({ lastArrival }),
  setDeviation: (d) => set((st) => ({ deviation: { ...st.deviation, [d.trip_id]: d } })),
  reset: () => set(empty),
}));

export const serverNow = () => Date.now() + useTracking.getState().clockOffsetMs;
