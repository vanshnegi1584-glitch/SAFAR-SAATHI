'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { DigitalToken, TelemetryUpdate } from '@transitlink/shared';
import { useEffect } from 'react';
import { getDataSource } from '@/lib/dataSource';
import { motionFor } from '@/lib/motionRegistry';
import { keys, upsertToken } from '@/lib/queries';
import { useFleetStore } from '@/store/fleetStore';

/** Wires socket events into Zustand (high-frequency telemetry) and React Query (tokens). */
export function RealtimeBridge() {
  const qc = useQueryClient();

  useEffect(() => {
    const src = getDataSource();
    const { applyTelemetry, raiseSos, clearSos } = useFleetStore.getState();

    const feed = (list: TelemetryUpdate[], batch: boolean) => {
      const now = performance.now();
      const byBus = new Map<string, TelemetryUpdate[]>();
      for (const u of list) byBus.set(u.bus_id, [...(byBus.get(u.bus_id) ?? []), u]);
      byBus.forEach((us, busId) => motionFor(busId).push(us, now));
      applyTelemetry(list, batch);
      for (const u of list) if (!u.sos_active && useFleetStore.getState().sos[u.bus_id]) clearSos(u.bus_id);
    };

    const offs = [
      src.on('telemetry:update', (u) => feed([u], false)),
      src.on('telemetry:batch', (us) => feed(us, true)),
      src.on('sos:alert', raiseSos),
      src.on('sos:cleared', ({ bus_id }) => clearSos(bus_id)),
      src.on('trip:last_bus_departed', () => qc.invalidateQueries({ queryKey: keys.snapshot })),
      src.on('token:update', (t: DigitalToken) =>
        qc.setQueryData<DigitalToken[]>(keys.tokens, (list) => (list ? upsertToken(list, t) : list)),
      ),
    ];
    src.connect();
    return () => {
      offs.forEach((off) => off());
      src.disconnect();
    };
  }, [qc]);

  return null;
}
