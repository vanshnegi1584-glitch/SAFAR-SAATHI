import type { FallbackSuggestion, SosAlert, TelemetryUpdate } from '@transitlink/shared';
import { create } from 'zustand';

export type Role = 'student' | 'driver';

interface SessionState {
  role: Role | null;
  // Student profile (live mode: users.default_route_id / home_location from the backend)
  routeId: string | null;
  stopId: string | null;
  /** Fallback trip + drop-off stop the student chose instead of their default route. */
  overrideTripId: string | null;
  overrideStopId: string | null;
  fallback: FallbackSuggestion | null;
  // Driver
  busId: string | null;

  latest: Record<string, TelemetryUpdate>;
  sos: Record<string, SosAlert>;

  setStudent: (routeId: string, stopId: string) => void;
  setDriver: (busId: string) => void;
  signOut: () => void;
  applyTelemetry: (updates: TelemetryUpdate[]) => void;
  setFallback: (f: FallbackSuggestion | null) => void;
  followTrip: (tripId: string | null, stopId?: string | null) => void;
  setSos: (busId: string, alert: SosAlert | null) => void;
}

export const useSession = create<SessionState>((set) => ({
  role: null,
  routeId: null,
  stopId: null,
  overrideTripId: null,
  overrideStopId: null,
  fallback: null,
  busId: null,
  latest: {},
  sos: {},

  setStudent: (routeId, stopId) =>
    set({ role: 'student', routeId, stopId, overrideTripId: null, overrideStopId: null, fallback: null }),
  setDriver: (busId) => set({ role: 'driver', busId }),
  signOut: () =>
    set({ role: null, routeId: null, stopId: null, busId: null, overrideTripId: null, overrideStopId: null, fallback: null }),
  applyTelemetry: (updates) =>
    set((s) => {
      const latest = { ...s.latest };
      for (const u of updates) {
        const prev = latest[u.bus_id];
        if (!prev || u.timestamp > prev.timestamp) latest[u.bus_id] = u;
      }
      return { latest };
    }),
  setFallback: (fallback) => set({ fallback }),
  followTrip: (overrideTripId, overrideStopId = null) => set({ overrideTripId, overrideStopId, fallback: null }),
  setSos: (busId, alert) =>
    set((s) => {
      const { [busId]: _, ...rest } = s.sos;
      return { sos: alert ? { ...rest, [busId]: alert } : rest };
    }),
}));
