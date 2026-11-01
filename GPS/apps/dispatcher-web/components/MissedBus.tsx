'use client';

import {
  findAlternatives, type Alternative, type BusLocationEvent, type LngLat, type ScheduledDeparture, type TrackingSnapshot,
  type TripDirection, type TripSummary,
} from '@transitlink/shared';
import { useMemo, useState } from 'react';

const TZ = 'Asia/Kolkata';
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
const minutes = (s: number) => {
  const m = Math.round(Math.abs(s) / 60);
  return Math.abs(s) < 60 ? '< 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};
const distance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const routeName = (name: string | undefined, d: TripDirection) =>
  !name || d === 'TO_COLLEGE' ? name : name.split(' → ').reverse().join(' → ');

/**
 * "Missed your bus?" — pick where you are going; every bus that still gets you there (on the road now
 * or departing later today), where to board it, your walk there and whether you will make it.
 */
export function MissedBus({ snap, trips, latest, now, scheduled, fullBusIds, me, onAskLocation, onPick, picked }: {
  snap: TrackingSnapshot | null;
  trips: TripSummary[];
  latest: Record<string, BusLocationEvent>;
  now: number;
  scheduled: ScheduledDeparture[];
  /** Buses full right now: they cannot be boarded, so they are not offered. */
  fullBusIds: Set<string>;
  me: LngLat | null;
  onAskLocation: () => void;
  onPick: (alt: Alternative | null) => void;
  picked: Alternative | null;
}) {
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState('');

  // Stops a bus can actually take you to: on a route that is ready, with a known position.
  const destinations = useMemo(() => {
    const ids = new Set((snap?.routes ?? []).filter((r) => r.ready).flatMap((r) => r.stop_ids));
    return (snap?.stops ?? []).filter((s) => ids.has(s.id) && s.location).sort((a, b) => a.name.localeCompare(b.name));
  }, [snap]);

  const { options: found, too_far_along: tooFar } = useMemo(() => (destination && me && snap
    ? findAlternatives({ destination_stop_id: destination, me, now, routes: snap.routes, stops: snap.stops, trips, latest, scheduled })
    : { options: [], too_far_along: [] }), [destination, me, now, snap, trips, latest, scheduled]);
  // A bus on the road that is full cannot take you, however well the times work out.
  const alternatives = found.filter((a) => !(a.kind === 'live' && fullBusIds.has(a.bus_id)));
  const fullOnes = found.filter((a) => a.kind === 'live' && fullBusIds.has(a.bus_id));
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? alternatives : alternatives.slice(0, 5);
  const fleetNo = (busId: string) => snap?.buses.find((b) => b.id === busId)?.fleet_number ?? busId;
  const destinationName = destinations.find((s) => s.id === destination)?.name;
  const key = (a: Alternative) => `${a.kind}|${a.bus_id}|${a.slot_id ?? a.trip_id}`;

  if (!open) {
    return (
      <button className="w-full border-b border-slate-100 px-4 py-2 text-left text-xs font-medium text-violet-800 hover:bg-violet-50" onClick={() => setOpen(true)}>
        Missed your bus? Find another bus that goes your way →
      </button>
    );
  }
  return (
    <div className="border-b border-slate-100 bg-violet-50/50 px-4 py-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-violet-900">Missed your bus?</span>
        <button className="text-slate-500 hover:text-slate-800" onClick={() => { setOpen(false); onPick(null); }}>Close</button>
      </div>
      <label className="flex items-center gap-2">
        <span className="shrink-0 text-slate-600">Going to</span>
        <select className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1" value={destination}
          onChange={(e) => { setDestination(e.target.value); onPick(null); }}>
          <option value="">Choose a stop…</option>
          {destinations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {!me && <p className="mt-2 text-slate-600">To work out your walk to each bus, <button className="text-blue-700 underline" onClick={onAskLocation}>show my location</button>.</p>}
      {me && destination && alternatives.length === 0 && (
        <p className="mt-2 text-slate-600">No bus you can still board passes within 2 km of {destinationName} today.</p>
      )}
      {fullOnes.length > 0 && (
        <p className="mt-2 font-medium text-red-700">Full, no seats: {fullOnes.map((a) => `Bus ${fleetNo(a.bus_id)}`).join(', ')}.</p>
      )}
      {tooFar.length > 0 && (
        <p className="mt-2 text-slate-600">
          Already too far along to catch: {tooFar.map((t) => `Bus ${fleetNo(t.bus_id)} (reaches ${t.drop.name} at ${clock(t.drop.arrive_at)})`).join(', ')}
          {' '}— no stop left to board it before it gets there.
        </p>
      )}
      <ul className="mt-2 space-y-2">
        {shown.map((a) => {
          const bus = snap?.buses.find((b) => b.id === a.bus_id);
          const route = snap?.routes.find((r) => r.id === a.route_id);
          const selected = picked && key(picked) === key(a);
          const trip = a.trip_id ? trips.find((t) => t.id === a.trip_id) : undefined;
          const slotAt = a.departs_at ?? (trip?.scheduled_departure ? Date.parse(trip.scheduled_departure) : null);
          const slotLabel = slotAt !== null ? clock(slotAt) : null;
          return (
            <li key={key(a)} className={`rounded border bg-white p-2 ${selected ? 'border-violet-500 ring-1 ring-violet-300' : 'border-slate-200'} ${a.catchable ? '' : 'opacity-70'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-900">Bus {bus?.fleet_number ?? a.bus_id}
                  <span className="font-normal text-slate-500"> · {a.direction === 'TO_COLLEGE' ? 'Arrival' : 'Departure'}{slotLabel ? ` ${slotLabel}` : ''}</span>
                </span>
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${a.catchable ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'}`}>
                  {a.catchable ? 'You can catch it' : 'Too late'}
                </span>
              </div>
              <div className="text-slate-500">{routeName(route?.name, a.direction)} · {a.kind === 'live' ? 'on the road now' : `leaves at ${clock(a.departs_at!)}`}</div>
              <div className="mt-1 space-y-0.5 tabular-nums text-slate-700">
                <div>Walk {distance(a.board.walk_m)} (~{minutes(a.board.walk_s)}) to <b>{a.board.name}</b></div>
                <div>Bus reaches {a.board.name} at {clock(a.board.bus_at)} (in {minutes((a.board.bus_at - now) / 1000)})</div>
                <div className={a.catchable ? 'text-green-700' : 'text-red-700'}>
                  {a.catchable ? `You'd have about ${minutes(a.slack_s)} to spare` : `You'd be about ${minutes(a.slack_s)} too late`}
                </div>
                <div>Gets you to <b>{a.drop.name}</b> at {clock(a.drop.arrive_at)}
                  {a.drop.from_destination_m > 100 ? <span className="text-amber-700"> · {distance(a.drop.from_destination_m)} from {destinationName}</span> : null}
                </div>
              </div>
              <button className="mt-1 text-blue-700 underline" onClick={() => onPick(selected ? null : a)}>{selected ? 'Hide on map' : 'Show on map'}</button>
            </li>
          );
        })}
      </ul>
      {alternatives.length > shown.length && (
        <button className="mt-2 text-blue-700 underline" onClick={() => setShowAll(true)}>Show {alternatives.length - shown.length} more</button>
      )}
      {alternatives.length > 0 && (
        <p className="mt-2 text-[11px] text-slate-500">
          Estimates: walking at ~4.3 km/h on streets about 1.3× the straight line, with a 1-minute margin; buses on the road use their live speed,
          buses not yet left an average 20 km/h. Your location stays in this browser.
        </p>
      )}
    </div>
  );
}
