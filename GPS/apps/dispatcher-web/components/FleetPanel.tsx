'use client';

import { busLabel, isStale } from '@transitlink/shared';
import { apiProblem, useSnapshot } from '@/lib/queries';
import { useNow } from '@/lib/useNow';
import { useFleetStore } from '@/store/fleetStore';
import { CapacityBar } from './CapacityBar';

function Badge({ tone, children }: { tone: 'green' | 'slate' | 'amber' | 'red' | 'blue'; children: string }) {
  const tones = {
    green: 'bg-green-100 text-green-800',
    slate: 'bg-slate-100 text-slate-600',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
    blue: 'bg-blue-100 text-blue-800',
  };
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function FleetPanel() {
  const { data, isLoading, error } = useSnapshot();
  const latest = useFleetStore((s) => s.latest);
  const sos = useFleetStore((s) => s.sos);
  const resyncedAt = useFleetStore((s) => s.resyncedAt);
  const selectedBusId = useFleetStore((s) => s.selectedBusId);
  const selectBus = useFleetStore((s) => s.selectBus);
  const now = useNow();

  if (error) return <div className="p-4 text-sm text-amber-800">{apiProblem(error)}</div>;
  if (isLoading || !data) return <div className="p-4 text-sm text-slate-500">Loading fleet…</div>;

  const routeOf = (busId: string) => {
    const trip = data.trips.find((t) => t.bus_id === busId && !t.end_time);
    return { trip, route: data.routes.find((r) => r.id === trip?.route_id) };
  };

  return (
    <ul className="divide-y divide-slate-100">
      {data.buses.map((bus) => {
        const t = latest[bus.id];
        const { trip, route } = routeOf(bus.id);
        const stale = bus.status === 'active' && isStale(t?.timestamp, now / 1000);
        const justResynced = resyncedAt[bus.id] !== undefined && now - resyncedAt[bus.id]! < 6000;
        return (
          <li key={bus.id}>
            <button
              onClick={() => selectBus(bus.id === selectedBusId ? null : bus.id)}
              className={`w-full px-4 py-3 text-left hover:bg-slate-50 ${bus.id === selectedBusId ? 'bg-blue-50' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {route && <span className="h-3 w-3 rounded-full" style={{ background: route.color }} />}
                  <span className="font-semibold" title={`Vehicle ${bus.registration_number}`}>{busLabel(bus, bus.id)}</span>
                </div>
                <div className="flex gap-1">
                  {sos[bus.id] && <Badge tone="red">SOS</Badge>}
                  {trip?.is_last_bus && <Badge tone="blue">LAST BUS</Badge>}
                  {bus.status === 'maintenance' ? (
                    <Badge tone="slate">Maintenance</Badge>
                  ) : stale ? (
                    <Badge tone="amber">No signal</Badge>
                  ) : justResynced ? (
                    <Badge tone="blue">Resynced</Badge>
                  ) : t && t.speed_kmh < 3 ? (
                    <Badge tone="slate">Stopped</Badge>
                  ) : t ? (
                    <Badge tone="green">Moving</Badge>
                  ) : null}
                </div>
              </div>
              {route && <div className="mt-0.5 text-xs text-slate-500">{route.name}</div>}
              {t && bus.status === 'active' && (
                <div className="mt-2 space-y-1">
                  <CapacityBar pax={t.current_pax_count} capacity={bus.max_capacity} />
                  <div className="flex gap-3 text-[11px] text-slate-500 tabular-nums">
                    <span>{t.speed_kmh.toFixed(0)} km/h</span>
                    <span>{t.sats} sats</span>
                    <span>{Math.max(0, Math.round(now / 1000 - t.timestamp))}s ago</span>
                  </div>
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
