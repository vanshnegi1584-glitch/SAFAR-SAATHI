import { create } from 'zustand';
import type { SosAlert, TelemetryUpdate } from '@transitlink/shared';

interface FleetState {
  /** Latest telemetry per bus (by device timestamp, never regresses). */
  latest: Record<string, TelemetryUpdate>;
  sos: Record<string, SosAlert>;
  selectedBusId: string | null;
  /** Bus ids that just delivered a post-outage batch — shown as "resynced" briefly. */
  resyncedAt: Record<string, number>;

  applyTelemetry: (updates: TelemetryUpdate[], fromBatch?: boolean) => void;
  raiseSos: (a: SosAlert) => void;
  clearSos: (busId: string) => void;
  selectBus: (busId: string | null) => void;
}

export const useFleetStore = create<FleetState>((set) => ({
  latest: {},
  sos: {},
  selectedBusId: null,
  resyncedAt: {},

  applyTelemetry: (updates, fromBatch = false) =>
    set((s) => {
      const latest = { ...s.latest };
      const resyncedAt = { ...s.resyncedAt };
      for (const u of updates) {
        const prev = latest[u.bus_id];
        if (!prev || u.timestamp > prev.timestamp) latest[u.bus_id] = u;
        if (fromBatch) resyncedAt[u.bus_id] = Date.now();
      }
      return { latest, resyncedAt };
    }),

  raiseSos: (a) => set((s) => (s.sos[a.bus_id] ? s : { sos: { ...s.sos, [a.bus_id]: a } })),
  clearSos: (busId) =>
    set((s) => {
      const { [busId]: _, ...rest } = s.sos;
      return { sos: rest };
    }),
  selectBus: (busId) => set({ selectedBusId: busId }),
}));
