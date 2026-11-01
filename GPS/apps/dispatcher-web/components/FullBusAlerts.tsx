'use client';

import type { FullBusAlert, TrackingSnapshot } from '@transitlink/shared';
import { useEffect, useRef, useState } from 'react';

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
const routeName = (name: string | undefined, toCollege: boolean) =>
  !name || toCollege ? name : name.split(' → ').reverse().join(' → ');

/**
 * "Bus 18 is full — leaving now. Next: Bus 9 is boarding." One line per full bus with the bus that
 * takes over its route; a newly full bus is highlighted for its first 15 seconds so the change is noticed.
 */
export function FullBusAlerts({ alerts, snap, now, onShowBus }: {
  alerts: FullBusAlert[];
  snap: TrackingSnapshot | null;
  now: number;
  onShowBus: (busId: string) => void;
}) {
  const firstSeen = useRef(new Map<string, number>());
  const [, rerender] = useState(0);
  useEffect(() => {
    const live = new Set(alerts.map((a) => a.trip_id));
    let added = false;
    for (const a of alerts) if (!firstSeen.current.has(a.trip_id)) { firstSeen.current.set(a.trip_id, Date.now()); added = true; }
    for (const id of firstSeen.current.keys()) if (!live.has(id)) firstSeen.current.delete(id); // full again later = new alert
    if (added) rerender((n) => n + 1);
  }, [alerts]);

  if (alerts.length === 0) return null;
  const fleet = (busId: string) => snap?.buses.find((b) => b.id === busId)?.fleet_number ?? busId;
  return (
    <div className="space-y-2 border-b border-red-100 bg-red-50 px-4 py-3 text-xs" role="status" aria-live="polite">
      {alerts.map((a) => {
        const route = routeName(snap?.routes.find((r) => r.id === a.route_id)?.name, a.direction === 'TO_COLLEGE');
        const fresh = Date.now() - (firstSeen.current.get(a.trip_id) ?? 0) < 15_000;
        const n = a.next;
        return (
          <div key={a.trip_id} className={`rounded border border-red-200 bg-white p-2 ${fresh ? 'animate-pulse ring-2 ring-red-400' : ''}`}>
            <div className="font-semibold text-red-800">
              Bus {fleet(a.bus_id)} is full{a.people !== null && a.capacity !== null ? ` (${a.people}/${a.capacity})` : ''}
              {a.leaving ? ' — leaving now' : ' — no seats until someone gets off'}
            </div>
            <div className="text-slate-500">{route}</div>
            <div className="mt-1 text-slate-800">
              {!n ? 'No other bus on this route is running or timetabled for later today.'
                : n.kind === 'boarding' ? <>Next: <b>Bus {fleet(n.bus_id)}</b> is boarding now.</>
                  : n.kind === 'same_time' ? <>Next: <b>Bus {fleet(n.bus_id)}</b> opens for boarding — departs {clock(n.departs_at!)}.</>
                    : <>Next bus: <b>Bus {fleet(n.bus_id)}</b> at {clock(n.departs_at!)}{n.departs_at! > now ? '' : ' (due now)'}.</>}
              {n && <button className="ml-2 text-blue-700 underline" onClick={() => onShowBus(n.bus_id)}>Show</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
