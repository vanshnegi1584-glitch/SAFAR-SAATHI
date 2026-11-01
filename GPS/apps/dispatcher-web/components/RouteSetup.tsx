'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { buildRoutePlan, cumulative, type LngLat, type PublicRoute, type PublicStop } from '@transitlink/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { Layer, Marker, NavigationControl, Source, type MapLayerMouseEvent, type MapRef } from 'react-map-gl/maplibre';
import { getTracking } from '@/lib/live';

const MAP_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE ?? 'https://tiles.openfreemap.org/styles/liberty';

type Stop = PublicStop & { location_source?: string | null };
interface Candidate { display_name: string; location: LngLat; source: string; type: string }

/** Insert `p` between the two consecutive points of `line` whose segment is closest to it. */
function insertIntoNearestSegment(line: LngLat[], p: LngLat): LngLat[] {
  const cos = Math.cos((p[1] * Math.PI) / 180);
  const xy = (q: LngLat) => [q[0] * cos, q[1]] as const;
  const [px, py] = xy(p);
  let best = 1, bestD = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = xy(line[i - 1]!), [bx, by] = xy(line[i]!);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
    if (d < bestD) { bestD = d; best = i; }
  }
  return [...line.slice(0, best), p, ...line.slice(best)];
}

const STATUS_STYLE: Record<PublicStop['status'], string> = {
  verified: 'bg-green-100 text-green-800',
  candidate: 'bg-amber-100 text-amber-800',
  unverified: 'bg-slate-100 text-slate-600',
};

/**
 * Admin workflow for turning text-only CSV routes into trackable ones:
 * 1) place each stop (search OSM, or click the map), review, mark verified;
 * 2) generate a road path through the verified stops, inspect it, approve it — or draw it by hand
 *    along the main roads the bus really uses, where OSM routing picks the wrong road (one-ways, lanes).
 * Nothing is accepted automatically — geocoder results are only suggestions.
 */
export default function RouteSetup() {
  const api = getTracking();
  const mapRef = useRef<MapRef>(null);
  const [routes, setRoutes] = useState<PublicRoute[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [stopId, setStopId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ location: LngLat; source: string } | null>(null);
  const [radius, setRadius] = useState(60);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [geomDraft, setGeomDraft] = useState<{ geometry: LngLat[]; distance_m: number } | null>(null);
  /** Hand-drawn path in progress (map clicks add points); null when not drawing. */
  const [drawing, setDrawing] = useState<LngLat[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'not-ready'>('not-ready');

  const reload = useCallback(async () => {
    const [snap, allStops] = await Promise.all([api.snapshot(), api.request<Stop[]>('/api/admin/stops')]);
    setRoutes(snap.routes);
    setStops(allStops);
  }, [api]);
  useEffect(() => void reload().catch((e) => setMsg({ tone: 'error', text: e.message })), [reload]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const route = routes.find((r) => r.id === routeId) ?? null;
  const stopById = useMemo(() => new globalThis.Map(stops.map((s) => [s.id, s])), [stops]);
  const stop = stopId ? stopById.get(stopId) ?? null : null;
  const routeStops = route ? route.stop_ids.map((id) => stopById.get(id)).filter((s): s is Stop => !!s) : [];
  const usedBy = (id: string) => routes.filter((r) => r.stop_ids.includes(id)).length;

  const selectStop = (s: Stop) => {
    setStopId(s.id);
    setCandidates([]);
    setRadius(s.geofence_radius_m);
    setDraft(s.location ? { location: s.location, source: s.location_source ?? 'existing' } : null);
    if (s.location) mapRef.current?.flyTo({ center: s.location, zoom: 16 });
  };

  const onMapClick = (e: MapLayerMouseEvent) => {
    const point: LngLat = [Number(e.lngLat.lng.toFixed(6)), Number(e.lngLat.lat.toFixed(6))];
    if (drawing) {
      // Shift+click inserts into the nearest segment (to fix a corner cut mid-path); a plain click appends.
      return setDrawing(e.originalEvent.shiftKey && drawing.length >= 2 ? insertIntoNearestSegment(drawing, point) : [...drawing, point]);
    }
    if (!stop) return;
    setDraft({ location: point, source: 'manual-map' });
  };

  const saveStop = (status: PublicStop['status']) => run('save', async () => {
    if (!stop) return;
    await api.request(`/api/admin/stops/${encodeURIComponent(stop.id)}`, {
      method: 'PUT',
      body: { location: status === 'unverified' ? null : draft?.location ?? null, status, source: draft?.source ?? null, geofence_radius_m: radius },
    });
    await reload();
    setCandidates([]);
    setMsg({ tone: 'ok', text: `${stop.name} saved as ${status}. Routes using it: ${usedBy(stop.id)}.` });
    // Move on to the next stop on this route that still needs work.
    const next = routeStops.find((s) => s.id !== stop.id && s.status !== 'verified');
    if (next && status === 'verified') selectStop(next);
  });

  const allStopsVerified = routeStops.length > 0 && routeStops.every((s) => s.status === 'verified');
  const shownRoutes = routes.filter((r) => filter === 'all' || !r.ready);

  // The same check the server applies before a route is ready: every stop within 150 m, in order.
  const drawnCheck = useMemo(() => {
    if (!route || !drawing || drawing.length < 2) return null;
    const lengthM = cumulative(drawing).at(-1)!;
    try {
      buildRoutePlan({ route: { ...route, geometry: drawing, geometry_status: 'verified' }, stops: stopById }, 'TO_COLLEGE');
      return { ok: true as const, lengthM, text: `Passes all ${route.stop_ids.length} stops in order.` };
    } catch (e) {
      return { ok: false as const, lengthM, text: (e as Error).message };
    }
  }, [route, drawing, stopById]);

  const saveDrawn = (status: 'candidate' | 'verified') => run('drawn', async () => {
    if (!route || !drawing) return;
    await api.request(`/api/admin/routes/${encodeURIComponent(route.id)}/geometry`, {
      method: 'PUT', body: { geometry: drawing, status, source: 'drawn by admin (main roads)' },
    });
    setDrawing(null);
    await reload();
    setMsg({ tone: 'ok', text: status === 'verified'
      ? 'Drawn path approved. New trips on this route get ETAs and stop progress.'
      : 'Drawn path saved as a candidate for review.' });
  });

  // ---- map data
  const stopsGeo: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: routeStops.filter((s) => s.location).map((s) => ({
      type: 'Feature', properties: { name: s.name, status: s.status, selected: s.id === stopId },
      geometry: { type: 'Point', coordinates: s.location! },
    })),
  };
  const lines: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      ...(route?.geometry ? [{ type: 'Feature' as const, properties: { kind: route.geometry_status }, geometry: { type: 'LineString' as const, coordinates: route.geometry } }] : []),
      ...(geomDraft ? [{ type: 'Feature' as const, properties: { kind: 'draft' }, geometry: { type: 'LineString' as const, coordinates: geomDraft.geometry } }] : []),
      ...(drawing && drawing.length > 1 ? [{ type: 'Feature' as const, properties: { kind: 'drawing' }, geometry: { type: 'LineString' as const, coordinates: drawing } }] : []),
    ],
  };
  const drawnPoints: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: (drawing ?? []).map((p, i) => ({ type: 'Feature', properties: { last: i === drawing!.length - 1 }, geometry: { type: 'Point', coordinates: p } })),
  };

  return (
    <div className="flex h-full">
      <aside className="w-[26rem] shrink-0 overflow-y-auto border-r border-slate-200 bg-white text-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Routes · {routes.filter((r) => r.ready).length}/{routes.length} ready
          </h2>
          <select className="rounded border border-slate-200 text-xs" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="not-ready">Needs setup</option>
            <option value="all">All</option>
          </select>
        </div>
        {msg && <p className={`mx-4 mt-3 rounded p-2 text-xs ${msg.tone === 'error' ? 'bg-red-50 text-red-800' : 'bg-green-50 text-green-800'}`}>{msg.text}</p>}

        {!route ? (
          <ul className="divide-y divide-slate-100">
            {shownRoutes.map((r) => (
              <li key={r.id}>
                <button className="w-full px-4 py-3 text-left hover:bg-slate-50" onClick={() => { setRouteId(r.id); setStopId(null); setGeomDraft(null); setDraft(null); setDrawing(null); }}>
                  <div className="flex justify-between gap-2"><span className="font-medium">{r.name}</span>{r.ready ? <span className="text-xs text-green-700">ready</span> : <span className="text-xs text-amber-700">{r.problems.length} issue{r.problems.length > 1 ? 's' : ''}</span>}</div>
                  <div className="text-xs text-slate-500">{r.stop_ids.length} stops · geometry {r.geometry_status}</div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-4 p-4">
            <button className="text-xs text-blue-700" onClick={() => { setRouteId(null); setStopId(null); setGeomDraft(null); setDrawing(null); }}>← All routes</button>
            <div>
              <h3 className="font-semibold">{route.name}</h3>
              <p className="text-xs text-slate-500">CSV order = to college. Version {route.version}.</p>
              {route.problems.map((p) => <p key={p} className="text-xs text-amber-700">• {p}</p>)}
            </div>

            <ol className="space-y-1">
              {route.stop_ids.map((id, i) => {
                const s = stopById.get(id);
                if (!s) return null;
                return (
                  <li key={`${id}-${i}`}>
                    <button onClick={() => selectStop(s)} className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left ${s.id === stopId ? 'bg-blue-50 ring-1 ring-blue-300' : 'hover:bg-slate-50'}`}>
                      <span>{i + 1}. {s.name}{s.is_college_endpoint ? ' 🎓' : ''}</span>
                      <span className={`rounded px-1.5 text-[11px] ${STATUS_STYLE[s.status]}`}>{s.status}</span>
                    </button>
                  </li>
                );
              })}
            </ol>

            {stop && (
              <div className="space-y-2 rounded-lg border border-slate-200 p-3">
                <div className="font-medium">{stop.name}</div>
                <p className="text-xs text-slate-500">Shared by {usedBy(stop.id)} route(s). Click the map to place it exactly at the bus stop, or search OpenStreetMap for suggestions.</p>
                <button className="rounded border border-slate-300 px-2 py-1 text-xs" disabled={!!busy} onClick={() => run('geocode', async () => {
                  const r = await api.request<{ candidates: Candidate[] }>(`/api/admin/stops/${encodeURIComponent(stop.id)}/geocode`, { method: 'POST' });
                  setCandidates(r.candidates);
                  if (!r.candidates.length) setMsg({ tone: 'error', text: 'No OpenStreetMap match near Dehradun — place it on the map manually.' });
                })}>{busy === 'geocode' ? 'Searching…' : 'Search OpenStreetMap'}</button>
                {candidates.length > 0 && (
                  <ul className="space-y-1">
                    {candidates.map((c) => (
                      <li key={c.source}>
                        <button className="w-full rounded border border-amber-200 bg-amber-50 p-1.5 text-left text-xs hover:bg-amber-100" onClick={() => { setDraft({ location: c.location, source: c.source }); mapRef.current?.flyTo({ center: c.location, zoom: 16 }); }}>
                          {c.display_name} <span className="text-slate-500">({c.type})</span>
                        </button>
                      </li>
                    ))}
                    <li className="text-[11px] text-slate-500">Suggestions can be the wrong place with the same name. Check on the map; drag the view and click to correct.</li>
                  </ul>
                )}
                <div className="text-xs tabular-nums">{draft ? `Position: ${draft.location[1].toFixed(6)}, ${draft.location[0].toFixed(6)} (${draft.source})` : 'No position yet'}</div>
                <label className="flex items-center gap-2 text-xs">Arrival radius
                  <input type="number" min={15} max={500} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className="w-20 rounded border border-slate-300 px-1" /> m
                </label>
                <div className="flex gap-2">
                  <button className="rounded bg-green-700 px-2 py-1 text-xs text-white disabled:opacity-40" disabled={!draft || !!busy} onClick={() => saveStop('verified')}>Save as verified</button>
                  <button className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40" disabled={!draft || !!busy} onClick={() => saveStop('candidate')}>Save as candidate</button>
                  {stop.status !== 'unverified' && <button className="rounded border border-red-200 px-2 py-1 text-xs text-red-700" disabled={!!busy} onClick={() => saveStop('unverified')}>Clear</button>}
                </div>
              </div>
            )}

            <div className="space-y-2 rounded-lg border border-slate-200 p-3">
              <div className="font-medium">Road geometry · <span className="font-normal">{route.geometry_status}</span></div>
              <p className="text-xs text-slate-500">Generated through the verified stops in order using OSRM (OpenStreetMap roads). Check that it follows the road the bus actually takes before approving.</p>
              <button className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40" disabled={!allStopsVerified || !!busy} onClick={() => run('osrm', async () => {
                setGeomDraft(await api.request(`/api/admin/routes/${encodeURIComponent(route.id)}/geometry/suggest`, { method: 'POST' }));
              })}>{busy === 'osrm' ? 'Routing…' : allStopsVerified ? 'Suggest road path' : 'Verify all stops first'}</button>
              {geomDraft && (
                <div className="space-y-1">
                  <div className="text-xs">Suggested path (dashed): {(geomDraft.distance_m / 1000).toFixed(1)} km, {geomDraft.geometry.length} points.</div>
                  <div className="flex gap-2">
                    <button className="rounded bg-green-700 px-2 py-1 text-xs text-white" disabled={!!busy} onClick={() => run('approve', async () => {
                      await api.request(`/api/admin/routes/${encodeURIComponent(route.id)}/geometry`, { method: 'PUT', body: { geometry: geomDraft.geometry, status: 'verified', source: 'osrm' } });
                      setGeomDraft(null);
                      await reload();
                      setMsg({ tone: 'ok', text: 'Geometry approved. New trips on this route get ETAs and stop progress.' });
                    })}>Approve</button>
                    <button className="rounded border border-slate-300 px-2 py-1 text-xs" onClick={() => setGeomDraft(null)}>Discard</button>
                  </div>
                </div>
              )}

              <div className="border-t border-slate-100 pt-2">
                {!drawing ? (
                  <>
                    <div className="flex flex-wrap gap-2">
                      <button className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40" disabled={!allStopsVerified || !!busy}
                        onClick={() => { setDrawing([]); setGeomDraft(null); setStopId(null); setDraft(null); setCandidates([]); }}>
                        Draw path by hand
                      </button>
                      {route.geometry && route.geometry.length > 1 && (
                        <button className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40" disabled={!allStopsVerified || !!busy}
                          onClick={() => { setDrawing(route.geometry!.slice()); setGeomDraft(null); setStopId(null); setDraft(null); setCandidates([]); }}>
                          Edit saved path
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">Use this when the suggested path takes the wrong road. Draw along the main roads the bus uses.</p>
                  </>
                ) : (
                  <div className="space-y-1">
                    <p className="text-xs text-slate-600">Click along the <b>main road</b> from the first stop to the campus, with a point at every turn and junction. Straight lines join the points, so add more points on curves. <b>Shift + click</b> inserts a point into the nearest part of the line, to bend a straight piece onto the road.</p>
                    <div className="text-xs tabular-nums">{drawing.length} points{drawnCheck ? ` · ${(drawnCheck.lengthM / 1000).toFixed(2)} km` : ''}</div>
                    {drawnCheck && <p className={`rounded p-1.5 text-xs ${drawnCheck.ok ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>{drawnCheck.text}</p>}
                    <div className="flex flex-wrap gap-2">
                      <button className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40" disabled={!drawing.length} onClick={() => setDrawing(drawing.slice(0, -1))}>Undo point</button>
                      <button className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40" disabled={!drawing.length} onClick={() => setDrawing([])}>Clear</button>
                      <button className="rounded border border-slate-300 px-2 py-1 text-xs" onClick={() => setDrawing(null)}>Cancel</button>
                    </div>
                    <div className="flex gap-2">
                      <button className="rounded bg-green-700 px-2 py-1 text-xs text-white disabled:opacity-40" disabled={!drawnCheck?.ok || !!busy} onClick={() => saveDrawn('verified')}>Approve drawn path</button>
                      <button className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40" disabled={!drawnCheck || !!busy} onClick={() => saveDrawn('candidate')}>Save as candidate</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </aside>

      <section className="relative min-w-0 flex-1">
        <Map ref={mapRef} initialViewState={{ longitude: 78.02, latitude: 30.31, zoom: 11.5 }} mapStyle={MAP_STYLE}
          style={{ width: '100%', height: '100%' }} onClick={onMapClick} cursor={stop || drawing ? 'crosshair' : 'grab'}
          boxZoom={!drawing /* Shift is "insert point" while drawing; MapLibre otherwise uses it for box zoom */}>
          <NavigationControl position="top-right" />
          <Source id="setup-lines" type="geojson" data={lines}>
            <Layer id="setup-line-saved" type="line" filter={['!', ['in', ['get', 'kind'], ['literal', ['draft', 'drawing']]]]} paint={{ 'line-color': '#2563eb', 'line-width': 4, 'line-opacity': drawing ? 0.25 : 0.7 }} />
            <Layer id="setup-line-draft" type="line" filter={['==', ['get', 'kind'], 'draft']} paint={{ 'line-color': '#9333ea', 'line-width': 4, 'line-dasharray': [2, 1.5] }} />
            <Layer id="setup-line-drawing" type="line" filter={['==', ['get', 'kind'], 'drawing']} paint={{ 'line-color': '#ea580c', 'line-width': 4 }} />
          </Source>
          <Source id="setup-drawn-points" type="geojson" data={drawnPoints}>
            <Layer id="setup-drawn-point" type="circle" paint={{
              'circle-radius': ['case', ['get', 'last'], 6, 4], 'circle-color': '#ea580c', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
            }} />
          </Source>
          <Source id="setup-stops" type="geojson" data={stopsGeo}>
            <Layer id="setup-stop" type="circle" paint={{
              'circle-radius': ['case', ['get', 'selected'], 9, 6],
              'circle-color': ['match', ['get', 'status'], 'verified', '#16a34a', 'candidate', '#d97706', '#94a3b8'],
              'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
            }} />
            <Layer id="setup-stop-label" type="symbol" layout={{ 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top' }} paint={{ 'text-halo-color': '#fff', 'text-halo-width': 1.5 }} />
          </Source>
          {candidates.map((c) => (
            <Marker key={c.source} longitude={c.location[0]} latitude={c.location[1]} color="#d97706" />
          ))}
          {draft && stop && <Marker longitude={draft.location[0]} latitude={draft.location[1]} color="#2563eb" />}
        </Map>
        {stop && <div className="pointer-events-none absolute left-3 top-3 rounded bg-white/95 px-2 py-1 text-xs shadow">Placing: <b>{stop.name}</b> — click the exact boarding point</div>}
        {drawing && <div className="pointer-events-none absolute left-3 top-3 rounded bg-white/95 px-2 py-1 text-xs shadow">Drawing path: <b>{route?.name}</b> — click along the main road, a point at every turn</div>}
      </section>
    </div>
  );
}
