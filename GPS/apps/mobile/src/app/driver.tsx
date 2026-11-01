import { haversine, isStale, mockData } from '@transitlink/shared';
import { Redirect, router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SosButton } from '@/components/SosButton';
import { Badge, Button, Card, colors } from '@/components/ui';
import { getDataSource, isMock } from '@/lib/dataSource';
import { isExpoGo } from '@/lib/notify';
import { useSnapshot } from '@/lib/queries';
import { useSession } from '@/store/session';
import {
  onGeofenceEvent, startGeofencing, stopGeofencing, type FenceRegion, type GeofenceLogEntry, type GeofenceStatus,
} from '@/tasks/geofence';

const CAMPUS_RADIUS_M = 150;

const STATUS_TEXT: Record<GeofenceStatus | 'off', { text: string; color: string }> = {
  off: { text: 'Auto-tracking is off', color: colors.muted },
  active: { text: 'Auto-tracking active — trips start and stops log automatically', color: colors.green },
  'needs-foreground': { text: 'Location permission denied', color: colors.red },
  'needs-background': { text: '"Allow all the time" location is needed for auto-tracking', color: colors.amber },
  unavailable: {
    text: isExpoGo ? 'Background tracking needs a development build (not Expo Go)' : 'Background tracking unavailable on this device',
    color: colors.amber,
  },
};

/**
 * Zero-touch driver screen (Blueprint §5.1): after the one-time setup, the driver never has to touch
 * the phone — geofences start/stop the trip, and the only control is the giant SOS button.
 */
export default function DriverScreen() {
  const { busId, latest, sos, signOut } = useSession();
  const { data: snap } = useSnapshot();
  const [fence, setFence] = useState<GeofenceStatus | 'off'>('off');
  const [log, setLog] = useState<GeofenceLogEntry[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => onGeofenceEvent((e) => setLog((l) => [e, ...l].slice(0, 5))), []);

  if (!busId) return <Redirect href="/" />;

  const trip = snap?.trips.find((t) => t.bus_id === busId);
  const route = snap?.routes.find((r) => r.id === trip?.route_id);
  const bus = snap?.buses.find((b) => b.id === busId);
  const t = latest[busId];
  const hwOk = !isStale(t?.timestamp, Date.now() / 1000);
  const sosActive = Boolean(sos[busId]);

  const regions = (): FenceRegion[] => [
    { key: 'campus', location: mockData.CAMPUS, radius: CAMPUS_RADIUS_M },
    ...(snap?.stops ?? [])
      .filter((s) => s.route_id === route?.id && haversine(s.location, mockData.CAMPUS) > CAMPUS_RADIUS_M)
      .map((s) => ({ key: `stop:${s.id}`, location: s.location, radius: s.geofence_radius_meters })),
  ];

  const enableTracking = () =>
    // Android 11+ sends the user to Settings for "Allow all the time" — explain first.
    Alert.alert(
      'Allow location all the time',
      'TransitLink detects when the bus leaves campus and reaches stops, so you never need to tap the phone while driving. On the next screen choose "Allow all the time".',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Continue', onPress: async () => setFence(await startGeofencing(busId, regions())) },
      ],
    );

  const raiseSos = async () => {
    setSending(true);
    try {
      await getDataSource().raiseSos(busId);
      useSession.getState().setSos(busId, {
        bus_id: busId, trip_id: trip?.id ?? null, location: t?.location ?? mockData.CAMPUS, raised_at: Math.floor(Date.now() / 1000),
      });
    } catch (e) {
      Alert.alert('SOS failed to send', 'Call the dispatcher directly. ' + String(e));
    } finally {
      setSending(false);
    }
  };

  const cancelSos = () =>
    Alert.alert('Cancel SOS?', 'Only cancel if this was a false alarm.', [
      { text: 'Keep SOS active', style: 'cancel' },
      { text: 'False alarm', style: 'destructive', onPress: () => void getDataSource().clearSos(busId).then(() => useSession.getState().setSos(busId, null)) },
    ]);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Text style={styles.link} onPress={async () => { await stopGeofencing(); signOut(); router.replace('/'); }}>
              End shift
            </Text>
          ),
        }}
      />
      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.h1}>{busId}</Text>
          {trip?.is_last_bus && <Badge label="LAST BUS" color={colors.primary} />}
        </View>
        <Text style={styles.muted}>{route?.name ?? 'No trip assigned'} · {bus?.registration_number}</Text>
        <Text style={styles.muted}>
          {trip?.end_time ? 'Trip completed' : 'Trip in progress'} · Bus hardware {hwOk ? `online (${t?.current_pax_count ?? 0} on board)` : 'no signal'}
        </Text>
      </Card>

      {sosActive ? (
        <Card style={{ backgroundColor: colors.red }}>
          <Text style={styles.sosTitle}>SOS SENT</Text>
          <Text style={styles.sosBody}>The dispatcher has your location. Stay with the bus if it is safe.</Text>
          <Button label="Cancel (false alarm)" tone="ghost" onPress={cancelSos} />
        </Card>
      ) : (
        <SosButton onTrigger={raiseSos} disabled={sending} />
      )}

      <Card>
        <Text style={[styles.status, { color: STATUS_TEXT[fence].color }]}>{STATUS_TEXT[fence].text}</Text>
        {fence !== 'active' && <Button label="Enable auto-tracking" onPress={enableTracking} />}
        {log.map((e) => (
          <Text key={e.at} style={styles.muted}>
            {new Date(e.at).toLocaleTimeString()} · {e.event === 'enter' ? 'Arrived at' : 'Left'} {e.regionKey.replace('stop:', '')}
          </Text>
        ))}
        {isMock() && (
          <Button
            label="Demo: simulate leaving campus"
            tone="ghost"
            onPress={() => {
              const e: GeofenceLogEntry = { regionKey: 'campus', event: 'exit', at: Date.now() };
              setLog((l) => [e, ...l].slice(0, 5));
              void getDataSource().reportGeofenceEvent({ bus_id: busId, region_id: 'campus', event: 'exit', timestamp: Math.floor(e.at / 1000) });
            }}
          />
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 16, backgroundColor: colors.bg, flexGrow: 1 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  h1: { fontSize: 32, fontWeight: '900', color: colors.ink },
  muted: { color: colors.muted },
  status: { fontWeight: '700', fontSize: 15 },
  sosTitle: { color: '#fff', fontSize: 32, fontWeight: '900' },
  sosBody: { color: '#fff', fontSize: 16 },
  link: { color: colors.red, fontWeight: '700', fontSize: 16 },
});
