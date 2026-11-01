'use client';

import { OCCUPANCY_COLOR, busLabel, isStale, mockData, occupancyLevel, type Bus, type LngLat } from '@transitlink/shared';
import { APIProvider, Map, useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import { useEffect, useRef } from 'react';
import { allMotions } from '@/lib/motionRegistry';
import { useSnapshot } from '@/lib/queries';
import { useGoogleRoadRoutes } from '@/lib/roadRoutes';
import { useFleetStore } from '@/store/fleetStore';

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
// Advanced markers need a Map ID. DEMO_MAP_ID works for development; create your own in Cloud Console.
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAP_ID ?? 'DEMO_MAP_ID';

const toLatLng = ([lng, lat]: LngLat): google.maps.LatLngLiteral => ({ lat, lng });

function RouteLines() {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');
  const { data } = useSnapshot();

  useEffect(() => {
    if (!map || !mapsLib || !data) return;
    const lines = data.routes.map(
      (r) =>
        new mapsLib.Polyline({
          map,
          path: r.polyline.map(toLatLng),
          strokeColor: r.color ?? '#475569',
          strokeOpacity: 0.8,
          strokeWeight: 5,
          clickable: false,
        }),
    );
    return () => lines.forEach((l) => l.setMap(null));
  }, [map, mapsLib, data]);

  return null;
}

function dot(size: number, fill: string, stroke: string): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${fill};border:3px solid ${stroke};transform:translateY(50%);`;
  return el;
}

function StopMarkers() {
  const map = useMap();
  const markerLib = useMapsLibrary('marker');
  const { data } = useSnapshot();

  useEffect(() => {
    if (!map || !markerLib || !data) return;
    const markers = data.stops.map(
      (s) => new markerLib.AdvancedMarkerElement({ map, position: toLatLng(s.location), title: s.stop_name, content: dot(12, '#fff', '#334155') }),
    );
    markers.push(new markerLib.AdvancedMarkerElement({ map, position: toLatLng(mockData.CAMPUS), title: 'Graphic Era Campus', content: dot(18, '#0f172a', '#fff'), zIndex: 5 }));
    return () => markers.forEach((m) => (m.map = null));
  }, [map, markerLib, data]);

  return null;
}

interface BusMarker {
  marker: google.maps.marker.AdvancedMarkerElement;
  circle: HTMLElement;
  label: HTMLElement;
  styleKey: string;
}

function createBusContent(): { root: HTMLElement; circle: HTMLElement; label: HTMLElement } {
  const root = document.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;align-items:center;transform:translateY(50%);cursor:pointer;';
  const circle = document.createElement('div');
  const label = document.createElement('div');
  label.style.cssText = 'margin-top:2px;padding:0 4px;font:600 11px system-ui;color:#0f172a;background:#fff;border-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.25);white-space:nowrap;';
  root.append(circle, label);
  return { root, circle, label };
}

/** Moves bus markers every frame from the interpolation engine — no React re-renders involved. */
function BusMarkers() {
  const map = useMap();
  const markerLib = useMapsLibrary('marker');
  const { data } = useSnapshot();
  const selectBus = useFleetStore((s) => s.selectBus);
  const busesById = useRef<Record<string, Bus>>({});
  busesById.current = Object.fromEntries((data?.buses ?? []).map((b) => [b.id, b]));

  useEffect(() => {
    if (!map || !markerLib) return;
    const markers: Record<string, BusMarker> = {};
    let raf = 0;

    const frame = () => {
      const now = performance.now();
      const nowSec = Date.now() / 1000;
      const { latest, sos, selectedBusId } = useFleetStore.getState();
      allMotions().forEach((motion, busId) => {
        const pos = motion.positionAt(now);
        if (!pos) return;
        let m = markers[busId];
        if (!m) {
          const { root, circle, label } = createBusContent();
          const marker = new markerLib.AdvancedMarkerElement({ map, content: root, title: busLabel(busesById.current[busId], busId), zIndex: 10 });
          marker.addListener('click', () => selectBus(busId));
          m = markers[busId] = { marker, circle, label, styleKey: '' };
        }
        m.marker.position = toLatLng(pos);

        const t = latest[busId];
        const cap = busesById.current[busId]?.max_capacity ?? 0;
        const pax = t?.current_pax_count ?? 0;
        const stale = isStale(t?.timestamp, nowSec) && !motion.isCatchingUp();
        const color = stale ? '#94a3b8' : OCCUPANCY_COLOR[occupancyLevel(pax, cap)];
        const selected = busId === selectedBusId;
        const isSos = Boolean(sos[busId]);
        const styleKey = `${color}|${selected}|${isSos}|${pax}/${cap}`;
        if (styleKey !== m.styleKey) {
          // Only touch the DOM when something visible changed.
          const size = selected ? 22 : 16;
          m.circle.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid ${selected ? '#0f172a' : '#fff'};box-shadow:${isSos ? '0 0 0 8px rgba(220,38,38,.4)' : '0 1px 3px rgba(0,0,0,.4)'};`;
          m.label.textContent = `${busLabel(busesById.current[busId], busId)}  ${pax}/${cap}`;
          m.marker.zIndex = selected || isSos ? 20 : 10;
          m.styleKey = styleKey;
        }
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      Object.values(markers).forEach((m) => (m.marker.map = null));
    };
  }, [map, markerLib, selectBus]);

  const selectedBusId = useFleetStore((s) => s.selectedBusId);
  useEffect(() => {
    if (!map || !selectedBusId) return;
    const pos = allMotions().get(selectedBusId)?.positionAt(performance.now());
    if (pos) {
      map.panTo(toLatLng(pos));
      map.setZoom(15);
    }
  }, [map, selectedBusId]);

  return null;
}

function RoadStatus() {
  const { loading, snappedCount, total, error } = useGoogleRoadRoutes();
  if (!total) return null;
  return (
    <div className="absolute bottom-6 left-3 rounded-md bg-white/95 px-3 py-1.5 text-xs shadow">
      {error ? (
        <span className="text-red-700" title={error}>Road routes unavailable — showing straight lines ({error})</span>
      ) : loading ? (
        <span className="text-slate-600">Fetching road routes from Google…</span>
      ) : (
        <span className="text-slate-600">{snappedCount}/{total} routes on real roads (Google Routes)</span>
      )}
    </div>
  );
}

export default function GoogleLiveMap() {
  return (
    <APIProvider apiKey={API_KEY} language="en" region="IN">
      <Map
        mapId={MAP_ID}
        defaultCenter={{ lat: 30.31, lng: 78.02 }}
        defaultZoom={12}
        gestureHandling="greedy"
        clickableIcons={false}
        style={{ width: '100%', height: '100%' }}
      >
        <RouteLines />
        <StopMarkers />
        <BusMarkers />
      </Map>
      <RoadStatus />
    </APIProvider>
  );
}
