import { useQueryClient } from '@tanstack/react-query';
import type { DigitalToken, TelemetryUpdate } from '@transitlink/shared';
import { useEffect } from 'react';
import { getDataSource, MOCK_STUDENT_ID } from '@/lib/dataSource';
import { motionFor } from '@/lib/motionRegistry';
import { notifyNow } from '@/lib/notify';
import { keys, upsertToken } from '@/lib/queries';
import { useSession } from '@/store/session';

/** Socket events → Zustand (telemetry, SOS, fallback) and React Query (tokens, snapshot). */
export function RealtimeBridge() {
  const qc = useQueryClient();

  useEffect(() => {
    const src = getDataSource();
    const s = useSession.getState;

    const feed = (list: TelemetryUpdate[]) => {
      const now = performance.now();
      const byBus = new Map<string, TelemetryUpdate[]>();
      for (const u of list) byBus.set(u.bus_id, [...(byBus.get(u.bus_id) ?? []), u]);
      byBus.forEach((us, busId) => motionFor(busId).push(us, now));
      s().applyTelemetry(list);
    };

    const showFallback = async (routeId: string) => {
      const { role, routeId: myRoute, stopId } = s();
      if (role !== 'student' || routeId !== myRoute || !myRoute) return;
      const snap = qc.getQueryData<{ stops: { id: string; location: [number, number] }[] }>(keys.snapshot);
      const home = snap?.stops.find((x) => x.id === stopId)?.location;
      if (!home) return;
      const suggestion = await src.getFallbackSuggestion(MOCK_STUDENT_ID, myRoute, home);
      s().setFallback(suggestion);
      await notifyNow(
        'Last bus has left',
        suggestion ? `Take ${suggestion.route_name} — get off at ${suggestion.stop_name}` : 'No alternative route has seats right now.',
      );
    };

    const offs = [
      src.on('telemetry:update', (u) => feed([u])),
      src.on('telemetry:batch', feed),
      src.on('sos:alert', (a) => s().setSos(a.bus_id, a)),
      src.on('sos:cleared', ({ bus_id }) => s().setSos(bus_id, null)),
      src.on('token:update', (t: DigitalToken) => {
        const prev = qc.getQueryData<DigitalToken[]>(keys.tokens)?.find((x) => x.id === t.id);
        qc.setQueryData<DigitalToken[]>(keys.tokens, (list) => (list ? upsertToken(list, t) : list));
        if (t.student_id === MOCK_STUDENT_ID && t.status === 'called' && prev?.status !== 'called') {
          void notifyNow("It's your turn", 'Head to the bus now — your queue token has been called.');
        }
      }),
      src.on('trip:last_bus_departed', ({ route_id }) => {
        void qc.invalidateQueries({ queryKey: keys.snapshot });
        void showFallback(route_id);
      }),
      src.on('fallback:suggestion', (f) => s().setFallback(f)), // live mode: server-computed
    ];
    src.connect();
    return () => {
      offs.forEach((off) => off());
      src.disconnect();
    };
  }, [qc]);

  return null;
}
