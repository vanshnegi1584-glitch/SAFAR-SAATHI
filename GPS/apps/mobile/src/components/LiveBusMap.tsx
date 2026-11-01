import type { BusLocationEvent, FreshnessStatus, LngLat, PublicRoute, PublicStop } from '@transitlink/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import MapView, { Circle, Marker, Polyline, PROVIDER_GOOGLE, type LatLng } from 'react-native-maps';
import { motionFor } from '@/lib/motionRegistry';
import { colors } from './ui';

const toLatLng = ([lng, lat]: LngLat): LatLng => ({ latitude: lat, longitude: lng });
const FRAME_MS = 80;

export const FRESHNESS_COLOR: Record<FreshnessStatus, string> = {
  LIVE: colors.green,
  DELAYED: colors.amber,
  STALE: '#94a3b8',
  WAITING_FOR_GPS: '#94a3b8',
  TRIP_ENDED: '#94a3b8',
};

interface Props {
  route: PublicRoute | null;
  stops: PublicStop[];
  myStopId?: string | null;
  bus: BusLocationEvent | null;
  freshness: FreshnessStatus;
  /** Only true after the user granted location permission — never triggers a prompt by itself. */
  showUser: boolean;
}

/**
 * Live map: verified route geometry, verified stops, the bus's last accepted GPS fix (smoothly animated
 * between fixes, never extrapolated beyond the last one) and, if permitted, the user's own position.
 */
export function LiveBusMap({ route, stops, myStopId, bus, freshness, showUser }: Props) {
  const mapRef = useRef<MapView>(null);
  const [pos, setPos] = useState<LngLat | null>(null);
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    if (!bus) return setPos(null);
    const id = setInterval(() => setPos(motionFor(bus.bus_id).positionAt(performance.now())), FRAME_MS);
    return () => clearInterval(id);
  }, [bus?.bus_id]);

  const placed = useMemo(() => stops.filter((s): s is PublicStop & { location: LngLat } => s.location !== null), [stops]);

  useEffect(() => {
    if (!route || fitted.current === route.id) return;
    const pts = route.geometry ?? placed.map((s) => s.location);
    if (pts.length < 2) return;
    fitted.current = route.id;
    mapRef.current?.fitToCoordinates(pts.map(toLatLng), { edgePadding: { top: 60, right: 40, bottom: 300, left: 40 }, animated: false });
  }, [route, placed]);

  const busColor = FRESHNESS_COLOR[freshness];
  const heading = bus?.heading_deg ?? null;
  // Heading from a near-stationary phone is noise; only rotate when moving.
  const rotate = heading !== null && (bus?.speed_mps ?? 0) > 1.5;

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={{ latitude: 30.31, longitude: 78.02, latitudeDelta: 0.15, longitudeDelta: 0.15 }}
        showsUserLocation={showUser}
        toolbarEnabled={false}
      >
        {route?.geometry && <Polyline coordinates={route.geometry.map(toLatLng)} strokeColor={colors.primary} strokeWidth={5} />}
        {placed.map((s) => (
          <Marker key={s.id} coordinate={toLatLng(s.location)} title={s.name} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <View style={[styles.stop, s.is_college_endpoint && styles.college, s.id === myStopId && styles.myStop]} />
          </Marker>
        ))}
        {bus && pos && bus.accuracy_m !== null && bus.accuracy_m > 15 && (
          <Circle center={toLatLng(pos)} radius={bus.accuracy_m} strokeColor="rgba(37,99,235,0.4)" fillColor="rgba(37,99,235,0.08)" />
        )}
        {bus && pos && (
          <Marker
            key={`bus-${busColor}-${rotate}`}
            coordinate={toLatLng(pos)}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
            rotation={rotate ? heading! : 0}
            zIndex={10}
            tracksViewChanges={false}
          >
            <View style={[styles.bus, { backgroundColor: busColor }]}>
              <Text style={styles.busText}>{rotate ? '▲' : '●'}</Text>
            </View>
          </Marker>
        )}
      </MapView>
      <View style={styles.legend} pointerEvents="none">
        <LegendRow swatch={<View style={[styles.busSwatch, { backgroundColor: colors.green }]} />} label="Bus (grey = not live)" />
        <LegendRow swatch={<View style={[styles.stop, styles.myStop]} />} label="Your stop" />
        <LegendRow swatch={<View style={styles.stop} />} label="Stop" />
        <LegendRow swatch={<View style={[styles.stop, styles.college]} />} label="College" />
        {showUser && <LegendRow swatch={<View style={styles.you} />} label="You" />}
      </View>
    </View>
  );
}

function LegendRow({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <View style={styles.legendRow}>
      <View style={styles.legendSwatch}>{swatch}</View>
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stop: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#fff', borderWidth: 3, borderColor: '#475569' },
  myStop: { borderColor: colors.primary, backgroundColor: '#bfdbfe' },
  college: { width: 16, height: 16, borderRadius: 3, borderColor: colors.ink, backgroundColor: colors.ink },
  bus: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#fff' },
  busText: { color: '#fff', fontSize: 13, fontWeight: '900' },
  busSwatch: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#fff' },
  you: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#3b82f6', borderWidth: 2, borderColor: '#fff' },
  legend: { position: 'absolute', top: 10, left: 10, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 10, padding: 8, gap: 4 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: { width: 18, alignItems: 'center' },
  legendText: { fontSize: 11, color: colors.ink },
});
