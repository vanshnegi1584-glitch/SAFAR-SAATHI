import { OCCUPANCY_COLOR, occupancyLevel, type LngLat, type Route, type Stop } from '@transitlink/shared';
import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, type LatLng } from 'react-native-maps';
import { motionFor } from '@/lib/motionRegistry';

const toLatLng = ([lng, lat]: LngLat): LatLng => ({ latitude: lat, longitude: lng });

interface Props {
  route: Route | undefined;
  stops: Stop[];
  highlightStopId?: string | null;
  bus?: { id: string; pax: number; capacity: number; stale: boolean } | null;
}

/** ~12 fps is plenty for a phone map and keeps the JS thread free. */
const FRAME_MS = 80;

export function BusMap({ route, stops, highlightStopId, bus }: Props) {
  const mapRef = useRef<MapView>(null);
  const [busPos, setBusPos] = useState<LngLat | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!bus) return setBusPos(null);
    const id = setInterval(() => setBusPos(motionFor(bus.id).positionAt(performance.now())), FRAME_MS);
    return () => clearInterval(id);
  }, [bus?.id]);

  useEffect(() => {
    if (!route || fitted.current) return;
    fitted.current = true;
    mapRef.current?.fitToCoordinates(route.polyline.map(toLatLng), {
      edgePadding: { top: 60, right: 40, bottom: 260, left: 40 },
      animated: false,
    });
  }, [route]);

  const color = bus ? (bus.stale ? '#94a3b8' : OCCUPANCY_COLOR[occupancyLevel(bus.pax, bus.capacity)]) : '#0f172a';

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      // Google on Android (required for Google road geometry); platform default (Apple Maps) on iOS.
      provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
      initialRegion={{ latitude: 30.31, longitude: 78.02, latitudeDelta: 0.12, longitudeDelta: 0.12 }}
      showsUserLocation
      toolbarEnabled={false}
    >
      {route && <Polyline coordinates={route.polyline.map(toLatLng)} strokeColor={route.color ?? '#2563eb'} strokeWidth={5} />}
      {stops.map((s) => (
        <Marker
          key={s.id}
          coordinate={toLatLng(s.location)}
          title={s.stop_name}
          pinColor={s.id === highlightStopId ? '#2563eb' : '#64748b'}
          opacity={s.id === highlightStopId ? 1 : 0.7}
        />
      ))}
      {bus && busPos && (
        <Marker
          coordinate={toLatLng(busPos)}
          title={bus.id}
          description={`${bus.pax}/${bus.capacity} seats taken${bus.stale ? ' · no signal' : ''}`}
          pinColor={color}
          zIndex={10}
        />
      )}
    </MapView>
  );
}
