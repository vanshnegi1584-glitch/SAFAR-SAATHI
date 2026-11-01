'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import {
  bearing, buildRoutePlan, displayPeople, displaySeats, effectiveFixTime, etaSecondsNow, formatAge, formatEtaMinutes, freshnessOf, haversine, MarkerMotion,
  SEATS_MAX_AGE_MS,
  type BusLocationEvent, type BusSeatsEvent, type FreshnessStatus, type LngLat, type PublicRoute, type PublicStop, type RouteDeviationEvent,
  type TrackingSnapshot, type TripSummary,
} from '@transitlink/shared';
import maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import Map, { Layer, NavigationControl, Source, type MapRef } from 'react-map-gl/maplibre';
import { getTracking } from '@/lib/live';
import { busLabel, fullBusAlerts, type Alternative } from '@transitlink/shared';
import { useScheduled } from '@/lib/useScheduled';
import { FullBusAlerts } from './FullBusAlerts';
import { MissedBus } from './MissedBus';
import { useNow } from '@/lib/useNow';

const MAP_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE ?? 'https://tiles.openfreemap.org/styles/liberty';
const COLOR: Record<FreshnessStatus, string> = {
  LIVE: '#16a34a', DELAYED: '#d97706', STALE: '#94a3b8', WAITING_FOR_GPS: '#94a3b8', TRIP_ENDED: '#94a3b8',
};
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const BUS_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="#fff" aria-hidden="true"><path d="M5 4.5C5 3.1 6.1 2 7.5 2h9C17.9 2 19 3.1 19 4.5V16a1 1 0 0 1-1 1h-.5v1.5a1 1 0 0 1-2 0V17h-7v1.5a1 1 0 0 1-2 0V17H6a1 1 0 0 1-1-1V4.5Zm2 1.5v5h10V6H7Zm1 7.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm8 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"/></svg>';

/**
 * A bus on the map, as an HTML marker that MapLibre positions itself (so it shows even when the map's
 * WebGL drawing is paused, e.g. in a background tab): an upright bus badge coloured by freshness, a
 * pointer around it rotated to the direction of travel, and the bus number underneath.
 */
function busMarkerElement(label: string) {
  const el = document.createElement('div');
  el.className = 'relative h-8 w-8';
  el.innerHTML =
    '<div data-arrow class="absolute -inset-[9px] hidden"><div class="mx-auto h-0 w-0 border-x-[7px] border-b-[10px] border-x-transparent border-b-slate-900"></div></div>' +
    `<div data-badge class="absolute inset-0 grid place-items-center rounded-full border-[3px] border-white shadow-md">${BUS_SVG}</div>` +
    '<div data-label class="absolute left-1/2 top-9 -translate-x-1/2 whitespace-nowrap rounded bg-white/90 px-1 text-[11px] font-semibold text-slate-900 shadow"></div>';
  el.querySelector<HTMLElement>('[data-label]')!.textContent = label;
  return el;
}

type MyLocation = { location: LngLat; accuracy: number | null };

/**
 * The viewer's own location, to compare with the bus: asked for only on click, kept in this browser
 * and never sent to the tracking server (the same rule as the student app).
 */
function useMyLocation() {
  const [state, setState] = useState<'off' | 'finding' | 'on' | 'denied' | 'unsupported'>('off');
  const [me, setMe] = useState<MyLocation | null>(null);
  const watch = useRef<number | null>(null);
  const clear = () => {
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
    setMe(null);
  };
  const start = () => {
    if (!('geolocation' in navigator)) return setState('unsupported');
    setState('finding');
    watch.current = navigator.geolocation.watchPosition(
      (p) => { setMe({ location: [p.coords.longitude, p.coords.latitude], accuracy: p.coords.accuracy ?? null }); setState('on'); },
      // Timeouts and "position unavailable" keep watching; only a refusal stops.
      (err) => { if (err.code === err.PERMISSION_DENIED) { clear(); setState('denied'); } },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  };
  const stop = () => { clear(); setState('off'); };
  useEffect(() => () => { if (watch.current !== null) navigator.geolocation.clearWatch(watch.current); }, []);
  return { state, me, start, stop };
}

/** Route names are written for arrivals ("Clock Tower → Geu"); a departure runs them in reverse. */
const tripRouteName = (name: string | undefined, direction: TripSummary['direction']) =>
  !name || direction === 'TO_COLLEGE' ? name : name.split(' → ').reverse().join(' → ');

/** Scheduled slot time in the campus time zone, e.g. "1:00 PM". */
const slotTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();

const formatDistance =(m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

/** Accuracy circle around a point, as a polygon (radius in metres). */
function accuracyCircle([lng, lat]: LngLat, radiusM: number, n = 48): GeoJSON.Polygon {
  const dLat = radiusM / 111_320;
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  const ring = Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)];
  });
  return { type: 'Polygon', coordinates: [ring] };
}

/**
 * The stop on this trip's route nearest to the viewer, the walk to it (straight line) and the bus's
 * ETA there: same verified route plan and speed basis as the student app's ETA to *my* stop.
 */
function towardsMe(trip: TripSummary, e: BusLocationEvent, route: PublicRoute | undefined, stops: PublicStop[], me: LngLat) {
  if (!route?.ready || !e.route || route.version !== trip.route_version) return null;
  try {
    const plan = buildRoutePlan({ route, stops: new globalThis.Map(stops.map((s) => [s.id, s])) }, trip.direction);
    const stop = plan.stops.reduce((a, b) => (haversine(me, b.location) < haversine(me, a.location) ? b : a));
    const walk_m = haversine(me, stop.location);
    if (stop.along_m + stop.geofence_radius_m < e.route.along_m) return { stop, walk_m, passed: true as const };
    const meters = Math.max(0, stop.along_m - e.route.along_m);
    const mps = e.eta.status === 'ok' && e.eta.destination_seconds ? e.route.remaining_to_destination_m / e.eta.destination_seconds : null;
    return { stop, walk_m, passed: false as const, meters, seconds: mps ? meters / mps : null };
  } catch {
    return null;
  }
}

/** Dispatcher view of live GPS: every open trip, its freshness, progress and ETA, from the tracking server. */
export default function GpsFleet() {
  const mapRef = useRef<MapRef>(null);
  const [snap, setSnap] = useState<TrackingSnapshot | null>(null);
  const [trips, setTrips] = useState<Record<string, TripSummary>>({});
  const [latest, setLatest] = useState<Record<string, BusLocationEvent>>({});
  const [deviations, setDeviations] = useState<Record<string, RouteDeviationEvent>>({});
  const [seats, setSeats] = useState<Record<string, BusSeatsEvent>>({});
  const [conn, setConn] = useState('connecting');
  const [offset, setOffset] = useState(0);
  const motions = useRef(new globalThis.Map<string, MarkerMotion>());
  const latestRef = useRef(latest);
  latestRef.current = latest;
  const now = useNow() + offset;
  const mine = useMyLocation();

  const myGeo = useMemo<GeoJSON.FeatureCollection>(() => (mine.me ? {
    type: 'FeatureCollection',
    features: [
      ...(mine.me.accuracy ? [{ type: 'Feature' as const, properties: {}, geometry: accuracyCircle(mine.me.location, mine.me.accuracy) }] : []),
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: mine.me.location } },
    ],
  } : EMPTY), [mine.me]);

  /** Fit the map around the viewer and a bus (or just the viewer). */
  const showBoth = (bus?: LngLat) => {
    if (!mine.me) return;
    const pts = bus ? [mine.me.location, bus] : [mine.me.location];
    const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
    mapRef.current?.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      // Extra room at the bottom so neither point sits under the legend.
      { padding: { top: 80, right: 80, bottom: 170, left: 80 }, maxZoom: 15, duration: 800 });
  };
  // "Missed your bus?" choice: the walk from the viewer to the boarding stop, drawn on the map.
  const [picked, setPicked] = useState<Alternative | null>(null);
  const walkGeo = useMemo<GeoJSON.FeatureCollection>(() => (picked && mine.me ? {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [mine.me.location, picked.board.location] } },
      { type: 'Feature', properties: { label: `Board at ${picked.board.name}` }, geometry: { type: 'Point', coordinates: picked.board.location } },
    ],
  } : EMPTY), [picked, mine.me]);
  const pick = (alt: Alternative | null) => {
    setPicked(alt);
    if (!alt || !mine.me) return;
    const pts = [mine.me.location, alt.board.location, ...(alt.bus_location ? [alt.bus_location] : [])];
    const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
    mapRef.current?.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: { top: 80, right: 80, bottom: 170, left: 80 }, maxZoom: 15, duration: 800 });
  };
  // Zoom to the viewer once, when their first position arrives.
  const placed = useRef(false);
  useEffect(() => {
    if (!mine.me) { placed.current = false; return; }
    if (!placed.current) { placed.current = true; showBoth(); }
  }, [mine.me]); // eslint-disable-line react-hooks/exhaustive-deps

  const motion = (busId: string) => {
    let m = motions.current.get(busId);
    if (!m) motions.current.set(busId, (m = new MarkerMotion()));
    return m;
  };
  // Direction of travel per bus: the phone's heading when it reports one, else the bearing from the
  // previous fix (only after moving > 5 m, so GPS jitter while standing still does not spin it).
  const headings = useRef(new globalThis.Map<string, number>());
  const noteHeading = (e: BusLocationEvent) => {
    if (e.heading_deg !== null) return void headings.current.set(e.bus_id, e.heading_deg);
    const prev = latestRef.current[e.bus_id];
    if (prev && haversine(prev.location, e.location) > 5) headings.current.set(e.bus_id, bearing(prev.location, e.location));
  };

  useEffect(() => {
    const c = getTracking();
    const load = () => c.snapshot().then((s) => {
      setSnap(s);
      setOffset(s.server_time - Date.now());
      setTrips(Object.fromEntries(s.trips.map((t) => [t.id, t])));
      setLatest(Object.fromEntries(s.latest.map((l) => [l.bus_id, l])));
      setSeats(Object.fromEntries((s.seats ?? []).map((e) => [e.bus_id, e])));
      for (const l of s.latest) {
        noteHeading(l);
        motion(l.bus_id).push({ location: l.location, timestamp: l.measured_at / 1000 }, performance.now());
      }
    });
    const upsertTrip = (t: TripSummary) => setTrips((x) => ({ ...x, [t.id]: t }));
    const offs = [
      c.on('connection:state', (s) => { setConn(s); if (s === 'connected') void load(); }),
      c.on('bus:location', (e) => {
        noteHeading(e);
        setLatest((x) => (x[e.bus_id] && x[e.bus_id]!.trip_id === e.trip_id && x[e.bus_id]!.sequence >= e.sequence ? x : { ...x, [e.bus_id]: e }));
        motion(e.bus_id).push({ location: e.location, timestamp: e.measured_at / 1000 }, performance.now());
      }),
      c.on('trip:started', upsertTrip),
      c.on('trip:updated', upsertTrip),
      c.on('trip:ended', (t) => {
        upsertTrip(t);
        setLatest((x) => { const { [t.bus_id]: _, ...rest } = x; return rest; });
      }),
      c.on('route:deviation', (d) => setDeviations((x) => ({ ...x, [d.trip_id]: d }))),
      c.on('bus:seats', (e) => setSeats((x) => ({ ...x, [e.bus_id]: e }))),
    ];
    c.connect();
    return () => { offs.forEach((o) => o()); c.disconnect(); };
  }, []);

  const routesGeo = useMemo<GeoJSON.FeatureCollection>(() => {
    const active = new Set(Object.values(trips).filter((t) => t.status !== 'completed' && t.status !== 'cancelled').map((t) => t.route_id));
    return {
      type: 'FeatureCollection',
      features: (snap?.routes ?? []).filter((r) => r.geometry && active.has(r.id)).map((r) => ({
        type: 'Feature', properties: { id: r.id }, geometry: { type: 'LineString', coordinates: r.geometry! },
      })),
    };
  }, [snap, trips]);

  // Interpolated bus markers, moved each frame without a React re-render. Browsers pause animation
  // frames in background tabs and hidden panes, which froze the buses; a 4-per-second timer keeps them
  // moving when frames stop.
  const markers = useRef(new globalThis.Map<string, { marker: maplibregl.Marker; el: HTMLElement }>());
  useEffect(() => {
    let raf = 0;
    let drawnAt = 0;
    const draw = () => {
      drawnAt = performance.now();
      const map = mapRef.current?.getMap();
      if (!map) return;
      const serverNow = Date.now() + offset;
      const seen = new Set<string>();
      for (const [busId, e] of Object.entries(latestRef.current)) {
        const pos = motion(busId).positionAt(drawnAt);
        if (!pos) continue;
        seen.add(busId);
        const f = freshnessOf(effectiveFixTime(e), serverNow, 'active');
        const bus = snap?.buses.find((b) => b.id === busId);
        const label = busLabel(bus, busId);
        let m = markers.current.get(busId);
        if (!m) {
          const el = busMarkerElement(label);
          m = { el, marker: new maplibregl.Marker({ element: el }).setLngLat(pos).addTo(map) };
          markers.current.set(busId, m);
        }
        m.marker.setLngLat(pos);
        // Kept current: a marker made before the bus list loaded starts with the bus id, not its number.
        const labelEl = m.el.querySelector<HTMLElement>('[data-label]')!;
        if (labelEl.textContent !== label) labelEl.textContent = label;
        m.el.title = `${label} · ${f.replace(/_/g, ' ').toLowerCase()}`;
        m.el.querySelector<HTMLElement>('[data-badge]')!.style.background = COLOR[f];
        const heading = headings.current.get(busId);
        const arrow = m.el.querySelector<HTMLElement>('[data-arrow]')!;
        arrow.classList.toggle('hidden', heading === undefined);
        if (heading !== undefined) arrow.style.transform = `rotate(${heading - map.getBearing()}deg)`;
      }
      for (const [busId, m] of markers.current) {
        if (!seen.has(busId)) { m.marker.remove(); markers.current.delete(busId); }
      }
    };
    const frame = () => { draw(); raf = requestAnimationFrame(frame); };
    raf = requestAnimationFrame(frame);
    const fallback = setInterval(() => { if (performance.now() - drawnAt > 300) draw(); }, 250);
    return () => { cancelAnimationFrame(raf); clearInterval(fallback); };
  }, [snap, offset]);
  useEffect(() => () => { for (const m of markers.current.values()) m.marker.remove(); markers.current.clear(); }, []);

  const open = Object.values(trips).filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
  // Full buses, and which bus takes over each one's route.
  const scheduled = useScheduled(snap, now);
  const fullAlerts = useMemo(() => fullBusAlerts({ trips: open, seats, scheduled, now }), [open, seats, scheduled, now]);
  const fullIds = useMemo(() => new Set(fullAlerts.map((a) => a.bus_id)), [fullAlerts]);
  const showBus = (busId: string) => {
    const e = latest[busId];
    if (e) mapRef.current?.flyTo({ center: e.location, zoom: 15 });
  };

  return (
    <div className="flex h-full">
      <aside className="w-96 shrink-0 overflow-y-auto border-r border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Live GPS · {open.length} open trips</h2>
          <span className={`text-xs ${conn === 'connected' ? 'text-green-700' : 'text-amber-700'}`}>{conn}</span>
        </div>
        <div className="border-b border-slate-100 px-4 py-3 text-xs">
          {mine.state === 'off' || mine.state === 'denied' || mine.state === 'unsupported' ? (
            <button className="rounded bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700" onClick={mine.start}>Show my location</button>
          ) : (
            <div className="flex items-center gap-2">
              <button className="rounded border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-50" onClick={mine.stop}>Hide my location</button>
              {mine.me ? <button className="text-blue-700 underline" onClick={() => showBoth()}>Centre on me</button> : <span className="text-slate-500">Finding your location…</span>}
            </div>
          )}
          <p className="mt-1 text-slate-500">
            {mine.state === 'denied' ? 'Location permission was refused; allow it for this site in the browser to compare.'
              : mine.state === 'unsupported' ? 'This browser cannot share a location.'
                : mine.me ? `You: ±${mine.me.accuracy !== null ? Math.round(mine.me.accuracy) : '?'} m. ` : ''}
            {mine.state !== 'denied' && mine.state !== 'unsupported' && 'Your location stays in this browser and is not sent to the server.'}
          </p>
        </div>
        <FullBusAlerts alerts={fullAlerts} snap={snap} now={now} onShowBus={showBus} />
        <MissedBus snap={snap} trips={Object.values(trips)} latest={latest} now={now} scheduled={scheduled} fullBusIds={fullIds}
          me={mine.me?.location ?? null}
          onAskLocation={mine.start} onPick={pick} picked={picked} />
        {open.length === 0 && <p className="p-4 text-sm text-slate-500">No trips are being tracked. Drivers start a trip in the app.</p>}
        <ul className="divide-y divide-slate-100">
          {open.map((t) => {
            const e = latest[t.bus_id]?.trip_id === t.id ? latest[t.bus_id] : undefined;
            const f = freshnessOf(e ? effectiveFixTime(e) : null, now, t.status);
            const bus = snap?.buses.find((b) => b.id === t.bus_id);
            const route = snap?.routes.find((r) => r.id === t.route_id);
            const dev = deviations[t.id];
            return (
              <li key={t.id} className="cursor-pointer px-4 py-3 text-sm hover:bg-slate-50" onClick={() => e && mapRef.current?.flyTo({ center: e.location, zoom: 15 })}>
                <div className="flex items-center justify-between">
                  <span className="font-semibold" title={bus ? `Vehicle ${bus.registration_number}` : undefined}>{busLabel(bus, t.bus_id)}</span>
                  <span className="flex gap-1">
                    {fullIds.has(t.bus_id) && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-bold text-white">FULL</span>}
                    <span className="rounded px-1.5 py-0.5 text-[11px] font-medium text-white" style={{ background: COLOR[f] }}>{f.replace(/_/g, ' ')}</span>
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${t.direction === 'TO_COLLEGE' ? 'bg-sky-100 text-sky-800' : 'bg-violet-100 text-violet-800'}`}>
                    {t.direction === 'TO_COLLEGE' ? 'Arrival' : 'Departure'}{t.scheduled_departure ? ` ${slotTime(t.scheduled_departure)}` : ''}
                  </span>
                  <span>{tripRouteName(route?.name, t.direction)} · {t.status.replace(/_/g, ' ')}</span>
                </div>
                {e && (
                  <div className="mt-1 space-y-0.5 text-xs tabular-nums text-slate-600">
                    <div>{formatAge(now - effectiveFixTime(e))}{e.accuracy_m !== null ? ` · ±${Math.round(e.accuracy_m)} m` : ''} · {e.quality} fix</div>
                    {e.route ? (
                      <div>Next: {e.route.next_stop_name ?? '—'} · {(e.route.remaining_to_destination_m / 1000).toFixed(1)} km left · ETA {
                        // An ETA computed from a position that is no longer current would be misleading.
                        f === 'STALE' ? 'unavailable (no recent GPS)'
                          : e.eta.status === 'ok' ? formatEtaMinutes(etaSecondsNow(e.eta.destination_seconds, e.eta.computed_at, now)) : e.eta.status
                      }</div>
                    ) : (
                      <div className="text-amber-700">{t.route_ready ? 'Not yet matched to route' : `Route not configured: ${t.route_problems.join('; ')}`}</div>
                    )}
                  </div>
                )}
                {e && mine.me && (() => {
                  const near = towardsMe(t, e, route, snap?.stops ?? [], mine.me.location);
                  const live = f === 'LIVE' || f === 'DELAYED';
                  return (
                    <div className="mt-1 rounded bg-blue-50 px-2 py-1 text-xs tabular-nums text-blue-900">
                      <div className="flex items-center justify-between">
                        <span>Bus is {formatDistance(haversine(mine.me.location, e.location))} from you (straight line)</span>
                        <button className="text-blue-700 underline" onClick={(ev) => { ev.stopPropagation(); showBoth(e.location); }}>Show me and the bus</button>
                      </div>
                      {near && (near.passed
                        ? <div>Your nearest stop, {near.stop.name} ({formatDistance(near.walk_m)} from you), is behind the bus.</div>
                        : <div>Nearest stop: {near.stop.name}, {formatDistance(near.walk_m)} from you · bus there {
                            live ? formatEtaMinutes(etaSecondsNow(near.seconds, e.eta.computed_at, now)) : 'ETA unavailable (no recent GPS)'
                          } ({formatDistance(near.meters)} along the route)</div>)}
                    </div>
                  );
                })()}
                {dev && !dev.resolved && <div className="mt-1 text-xs font-medium text-red-700">Off route (~{dev.distance_from_route_m} m)</div>}
                {seats[t.bus_id] && (() => {
                  const s = seats[t.bus_id]!;
                  const shown = displaySeats(s, now);
                  const people = displayPeople(s, now);
                  return (
                    <div className="mt-1 text-xs">
                      {shown ? <span className="font-medium">{shown.free}/{shown.capacity ?? '?'} seats free · {shown.source}</span>
                        : <span className="text-slate-500">Seats unavailable ({now - s.received_at > SEATS_MAX_AGE_MS ? 'no recent reading' : s.reason.replace(/_/g, ' ')})</span>}
                      {s.recalibration_required && <span className="ml-1 text-amber-700">· camera/IR disagree — recalibrate</span>}
                      {people && (
                        <div className="font-medium">
                          {people.count} on board · {people.source}{people.source === 'camera' ? ' (people in view)' : ''}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="relative min-w-0 flex-1">
        <Map ref={mapRef} initialViewState={{ longitude: 78.02, latitude: 30.31, zoom: 11.5 }} mapStyle={MAP_STYLE} style={{ width: '100%', height: '100%' }}>
          <NavigationControl position="top-right" />
          <Source id="gps-routes" type="geojson" data={routesGeo}>
            <Layer id="gps-route-line" type="line" paint={{ 'line-color': '#2563eb', 'line-width': 4, 'line-opacity': 0.6 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          </Source>
          <Source id="missed-walk" type="geojson" data={walkGeo}>
            <Layer id="missed-walk-line" type="line" filter={['==', ['geometry-type'], 'LineString']}
              paint={{ 'line-color': '#7c3aed', 'line-width': 3, 'line-dasharray': [1.5, 1.5] }} layout={{ 'line-cap': 'round' }} />
            <Layer id="missed-board-stop" type="circle" filter={['==', ['geometry-type'], 'Point']}
              paint={{ 'circle-radius': 8, 'circle-color': '#7c3aed', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 }} />
            <Layer id="missed-board-label" type="symbol" filter={['==', ['geometry-type'], 'Point']}
              layout={{ 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top' }}
              paint={{ 'text-color': '#5b21b6', 'text-halo-color': '#fff', 'text-halo-width': 1.5 }} />
          </Source>
          <Source id="my-location" type="geojson" data={myGeo}>
            <Layer id="my-accuracy" type="fill" filter={['==', ['geometry-type'], 'Polygon']} paint={{ 'fill-color': '#3b82f6', 'fill-opacity': 0.12 }} />
            <Layer id="my-dot" type="circle" filter={['==', ['geometry-type'], 'Point']} paint={{ 'circle-radius': 7, 'circle-color': '#3b82f6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 }} />
          </Source>
        </Map>
        <div className="absolute bottom-3 left-3 rounded-lg bg-white/95 p-2 text-xs shadow">
          {(['LIVE', 'DELAYED', 'STALE'] as const).map((k) => (
            <div key={k} className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: COLOR[k] }} />{k === 'LIVE' ? 'Live (≤5 s)' : k === 'DELAYED' ? 'Delayed (≤15 s)' : 'Stale / last known'}</div>
          ))}
          <div className="flex items-center gap-2"><span className="h-0 w-0 border-x-[5px] border-b-[8px] border-x-transparent border-b-slate-900" />Direction of travel</div>
          {mine.me && <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full border-2 border-white bg-blue-500 shadow" />You</div>}
        </div>
      </section>
    </div>
  );
}
