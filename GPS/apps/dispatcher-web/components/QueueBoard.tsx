'use client';

import { busLabel, groupTokensByTrip, nextToCall, type DigitalToken, type TokenStatus } from '@transitlink/shared';
import { apiProblem, useSnapshot, useTokens, useUpdateTokenStatus } from '@/lib/queries';
import { useFleetStore } from '@/store/fleetStore';
import { CapacityBar } from './CapacityBar';

const STATUS_STYLE: Record<TokenStatus, string> = {
  waiting: 'bg-slate-100 text-slate-700',
  called: 'bg-blue-100 text-blue-800',
  boarded: 'bg-green-100 text-green-800',
  expired: 'bg-amber-100 text-amber-800',
  cancelled: 'bg-slate-100 text-slate-400 line-through',
};

function TokenCard({ token, onSet }: { token: DigitalToken; onSet: (s: TokenStatus) => void }) {
  return (
    <li className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="w-8 text-sm font-semibold tabular-nums text-slate-400">#{token.queue_position}</span>
        <div>
          <div className="text-sm font-medium">{token.student_name ?? token.student_id}</div>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${STATUS_STYLE[token.status]}`}>{token.status}</span>
        </div>
      </div>
      <div className="flex gap-1">
        {token.status === 'waiting' && (
          <button onClick={() => onSet('called')} className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700">Call</button>
        )}
        {token.status === 'called' && (
          <>
            <button onClick={() => onSet('boarded')} className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700">Boarded</button>
            <button onClick={() => onSet('expired')} className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50" title="Student did not show up">No-show</button>
          </>
        )}
      </div>
    </li>
  );
}

export function QueueBoard() {
  const { data: snap, error: snapError } = useSnapshot();
  const { data: tokens, isLoading, error: tokensError } = useTokens();
  const latest = useFleetStore((s) => s.latest);
  const update = useUpdateTokenStatus();

  const error = snapError ?? tokensError;
  if (error) return <div className="p-6 text-sm text-amber-800">{apiProblem(error)}</div>;
  if (isLoading || !snap || !tokens) return <div className="p-6 text-sm text-slate-500">Loading queues…</div>;

  const byTrip = groupTokensByTrip(tokens);
  const trips = [...snap.trips].sort((a, b) => a.start_time.localeCompare(b.start_time));

  return (
    <div className="flex h-full gap-4 overflow-x-auto p-4">
      {trips.map((trip) => {
        const bus = snap.buses.find((b) => b.id === trip.bus_id)!;
        const route = snap.routes.find((r) => r.id === trip.route_id);
        const list = byTrip.get(trip.id) ?? [];
        const pax = latest[bus.id]?.current_pax_count ?? 0;
        const free = Math.max(0, bus.max_capacity - pax);
        const toCall = nextToCall(list, free);
        const active = list.filter((t) => t.status === 'called' || t.status === 'waiting');
        const done = list.length - active.length;

        return (
          <section key={trip.id} className="flex w-80 shrink-0 flex-col rounded-lg bg-slate-100">
            <header className="space-y-2 border-b border-slate-200 p-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full" style={{ background: route?.color }} />
                    <h2 className="font-semibold">{route?.name}</h2>
                  </div>
                  <p className="text-xs text-slate-500">
                    {busLabel(bus, bus.id)} · departs {new Date(trip.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                {trip.is_last_bus && <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">LAST BUS</span>}
              </div>
              <CapacityBar pax={pax} capacity={bus.max_capacity} />
              <div className="flex items-center justify-between text-xs text-slate-600">
                <span>{active.filter((t) => t.status === 'waiting').length} waiting · {free} seats free</span>
                <button
                  disabled={toCall.length === 0}
                  onClick={() => toCall.forEach((t) => update.mutate({ id: t.id, status: 'called' }))}
                  className="rounded bg-slate-900 px-2 py-1 font-medium text-white disabled:opacity-30"
                  title="Call as many waiting students as there are free seats"
                >
                  Call next {toCall.length}
                </button>
              </div>
            </header>
            <ul className="flex-1 space-y-2 overflow-y-auto p-3">
              {active.length === 0 && <li className="text-center text-xs text-slate-400">No one in queue</li>}
              {active.map((t) => (
                <TokenCard key={t.id} token={t} onSet={(status) => update.mutate({ id: t.id, status })} />
              ))}
            </ul>
            {done > 0 && <footer className="border-t border-slate-200 px-3 py-2 text-xs text-slate-500">{done} boarded / closed</footer>}
          </section>
        );
      })}
    </div>
  );
}
