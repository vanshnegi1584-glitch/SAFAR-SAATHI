'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { OCCUPANCY_COLOR, busLabel, isStale, mockData, occupancyLevel, type Bus } from '@transitlink/shared';
import type { GeoJSONSource } from 'maplibre-gl';
import { useEffect, useMemo, useRef } from 'react';
import Map, { Layer, NavigationControl, Source, type MapLayerMouseEvent, type MapRef } from 'react-map-gl/maplibre';
import { allMotions } from '@/lib/motionRegistry';
import { useSnapshot } from '@/lib/queries';
import { useFleetStore } from '@/store/fleetStore';

const MAP_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE ?? 'https://tiles.openfreemap.org/styles/liberty';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export default function LiveMap() {
  const mapRef = useRef<MapRef>(null);
  const { data } = useSnapshot();
  const selectedBusId = useFleetStore((s) => s.selectedBusId);
  const selectBus = useFleetStore((s) => s.selectBus);

  const busesById = useRef<Record<string, Bus>>({});
  busesById.current = Object.fromEntries((data?.buses ?? []).map((b) => [b.id, b]));

  const routesGeo = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: (data?.routes ?? []).map((r) => ({
      type: 'Feature',
      properties: { id: r.id, color: r.color ?? '#475569' },
      geometry: { type: 'LineString', coordinates: r.polyline },
    })),
  }), [data?.routes]);

  const stopsGeo = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: (data?.stops ?? []).map((s) => ({
      type: 'Feature',
      properties: { name: s.stop_name },
      geometry: { type: 'Point', coordinates: s.location },
    })),
  }), [data?.stops]);

  // Animation loop: read interpolated positions and push them straight into the map source.
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const src = mapRef.current?.getMap().getSource('buses') as GeoJSONSource | undefined;
      if (src) {
        const now = performance.now();
        const nowSec = Date.now() / 1000;
        const { latest, sos, selectedBusId: sel } = useFleetStore.getState();
        const features: GeoJSON.Feature[] = [];
        allMotions().forEach((motion, busId) => {
          const pos = motion.positionAt(now);
          if (!pos) return;
          const t = latest[busId];
          const cap = busesById.current[busId]?.max_capacity ?? 0;
          const pax = t?.current_pax_count ?? 0;
          const stale = isStale(t?.timestamp, nowSec) && !motion.isCatchingUp();
          features.push({
            type: 'Feature',
            properties: {
              id: busId,
              label: `${busLabel(busesById.current[busId], busId)}  ${pax}/${cap}`,
              color: stale ? '#94a3b8' : OCCUPANCY_COLOR[occupancyLevel(pax, cap)],
              sos: Boolean(sos[busId]),
              selected: busId === sel,
            },
            geometry: { type: 'Point', coordinates: pos },
          });
        });
        src.setData({ type: 'FeatureCollection', features });
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!selectedBusId) return;
    const pos = allMotions().get(selectedBusId)?.positionAt(performance.now());
    if (pos) mapRef.current?.flyTo({ center: pos, zoom: 14, duration: 800 });
  }, [selectedBusId]);

  const onClick = (e: MapLayerMouseEvent) => {
    const id = e.features?.[0]?.properties?.id as string | undefined;
    selectBus(id ?? null);
  };

  return (
    <Map
      ref={mapRef}
      initialViewState={{ longitude: 78.02, latitude: 30.31, zoom: 12 }}
      mapStyle={MAP_STYLE}
      interactiveLayerIds={['bus-circle']}
      onClick={onClick}
      cursor="auto"
      style={{ width: '100%', height: '100%' }}
    >
      <NavigationControl position="top-right" />
      <Source id="routes" type="geojson" data={routesGeo}>
        <Layer id="route-line" type="line" paint={{ 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.7 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
      </Source>
      <Source id="stops" type="geojson" data={stopsGeo}>
        <Layer id="stop-dot" type="circle" paint={{ 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#334155', 'circle-stroke-width': 2 }} />
      </Source>
      <Source id="campus" type="geojson" data={{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: mockData.CAMPUS } }}>
        <Layer id="campus-dot" type="circle" paint={{ 'circle-radius': 9, 'circle-color': '#0f172a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 }} />
      </Source>
      <Source id="buses" type="geojson" data={EMPTY}>
        <Layer id="bus-sos" type="circle" filter={['==', ['get', 'sos'], true]} paint={{ 'circle-radius': 22, 'circle-color': '#dc2626', 'circle-opacity': 0.35 }} />
        <Layer id="bus-circle" type="circle" paint={{
          'circle-radius': ['case', ['get', 'selected'], 11, 8],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': ['case', ['get', 'selected'], '#0f172a', '#ffffff'],
          'circle-stroke-width': 3,
        }} />
        <Layer id="bus-label" type="symbol" layout={{
          'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.4], 'text-anchor': 'top',
          'text-allow-overlap': true,
        }} paint={{ 'text-color': '#0f172a', 'text-halo-color': '#fff', 'text-halo-width': 1.5 }} />
      </Source>
    </Map>
  );
}
