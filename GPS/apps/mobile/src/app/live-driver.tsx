import { ApiError, formatAge, type DriverInfo, type TripDirection, type TripSummary } from '@transitlink/shared';
import * as Linking from 'expo-linking';
import { Redirect, router, Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Badge, Button, Card, Chip, colors } from '@/components/ui';
import { GpsPublisher, type GpsState, type GpsStats } from '@/lib/gpsPublisher';
import { getAuth, getTracking } from '@/lib/live';
import { isExpoGo } from '@/lib/notify';
import { useTracking } from '@/store/tracking';
import { isBackgroundTracking, startBackgroundTracking, stopBackgroundTracking } from '@/tasks/driverLocation';

const GPS_TEXT: Record<GpsState['kind'], { text: string; color: string }> = {
  idle: { text: 'GPS off — not sharing location', color: colors.muted },
  requesting: { text: 'Asking for location permission…', color: colors.muted },
  denied: { text: 'Location permission denied — the bus is NOT being tracked', color: colors.red },
  services_off: { text: 'Location services are off — the bus is NOT being tracked', color: colors.red },
  approximate_only: { text: 'Only approximate location allowed — turn on "Precise location" to track the bus', color: colors.red },
  acquiring: { text: 'Waiting for a GPS fix… (step outside / away from tall buildings)', color: colors.amber },
  tracking: { text: 'Sharing bus location', color: colors.green },
  error: { text: 'GPS error — the bus is NOT being tracked', color: colors.red },
};

const SLOT_OK = new Set(['matched', 'confirmed']);

export default function LiveDriver() {
  const me = useTracking((s) => s.me);
  const connection = useTracking((s) => s.connection);
  const [info, setInfo] = useState<DriverInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState<TripDirection>('TO_COLLEGE');
  const [slotId, setSlotId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gps, setGps] = useState<{ state: GpsState; stats: GpsStats | null }>({ state: { kind: 'idle' }, stats: null });
  const [background, setBackground] = useState(false);
  const publisher = useRef<GpsPublisher | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    try {
      setInfo(await getTracking().driverInfo());
      setBackground(await isBackgroundTracking());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void router.replace('/login');
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const startGps = useCallback(async (trip: TripSummary) => {
    publisher.current?.stop();
    const p = new GpsPublisher(getTracking(), trip, (state, stats) => setGps({ state, stats }));
    publisher.current = p;
    await p.start();
  }, []);

  // Resume publishing for a trip that is already open (app restart mid-trip).
  const openTrip = info?.open_trip ?? null;
  useEffect(() => {
    if (openTrip && !publisher.current && !background) void startGps(openTrip);
    return undefined;
  }, [openTrip?.id, background, startGps]);
  useEffect(() => () => publisher.current?.stop(), []);

  if (!me) return <Redirect href="/login" />;
  if (!info) return error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator style={{ flex: 1 }} />;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const trip = await getTracking().startTrip(direction, slotId);
      setInfo({ ...info, open_trip: trip });
      await startGps(trip);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const end = () =>
    Alert.alert('End trip?', 'Location sharing stops and students see the trip as ended.', [
      { text: 'Keep driving', style: 'cancel' },
      {
        text: 'End trip', style: 'destructive', onPress: async () => {
          publisher.current?.stop();
          publisher.current = null;
          await stopBackgroundTracking();
          setBackground(false);
          try {
            await getTracking().endTrip(openTrip!.id);
          } catch (e) {
            setError((e as Error).message);
          }
          await load();
        },
      },
    ]);

  const toggleBackground = async (on: boolean) => {
    if (!openTrip) return;
    if (!on) {
      await stopBackgroundTracking();
      setBackground(false);
      await startGps(openTrip);
      return;
    }
    const r = await startBackgroundTracking(openTrip);
    if (r === 'active') {
      publisher.current?.stop(); // the background task now delivers fixes in both states
      publisher.current = null;
      setBackground(true);
    } else {
      Alert.alert('Screen-off tracking unavailable', r === 'needs-background-permission'
        ? 'Allow location "All the time" for TransitLink in Settings to keep sharing with the screen off.'
        : isExpoGo ? 'Screen-off tracking needs a development build of the app (not Expo Go).' : 'This device does not support background location.');
    }
  };

  const route = info.route;
  const slots = info.slots.filter((s) => s.direction === direction);
  const st = gps.stats;
  const view = GPS_TEXT[gps.state.kind];
  const lastAckBad = st?.lastAck && !st.lastAck.accepted;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen options={{
        title: 'Driver',
        headerRight: () => !openTrip ? (
          <Text style={styles.link} onPress={() => void getAuth().signOut().then(() => { useTracking.getState().reset(); router.replace('/login'); })}>Sign out</Text>
        ) : null,
      }} />
      <Card>
        {info.bus ? (
          <>
            <Text style={styles.h1}>Bus {info.bus.fleet_number}</Text>
            <Text style={styles.muted}>{info.bus.registration_number} · {route?.name ?? 'No route'}</Text>
            {route && !route.ready && <Text style={styles.warn}>Route not fully configured ({route.problems.join('; ')}). Students will see the bus position but no ETA.</Text>}
          </>
        ) : (
          <Text style={styles.h2}>No bus is assigned to your account. Ask the transport office to assign you.</Text>
        )}
        {connection !== 'connected' && <Text style={styles.warn}>Not connected to the server — fixes are kept on the phone and sent when the connection returns.</Text>}
      </Card>

      {info.bus && !openTrip && (
        <Card>
          <Text style={styles.h2}>Start a trip</Text>
          <View style={styles.wrap}>
            <Chip label="To college" selected={direction === 'TO_COLLEGE'} onPress={() => { setDirection('TO_COLLEGE'); setSlotId(null); }} />
            <Chip label="From college" selected={direction === 'FROM_COLLEGE'} onPress={() => { setDirection('FROM_COLLEGE'); setSlotId(null); }} />
          </View>
          <Text style={styles.muted}>Departure</Text>
          <View style={styles.wrap}>
            <Chip label="Unscheduled run" selected={slotId === null} onPress={() => setSlotId(null)} />
            {slots.map((s) => (
              <Chip key={s.id} label={SLOT_OK.has(s.status) ? s.label : `${s.label} (${s.status.replace('_', ' ')})`}
                selected={s.id === slotId} onPress={() => SLOT_OK.has(s.status) ? setSlotId(s.id) : Alert.alert(s.label, `Not available for this bus: ${s.note}.`)} />
            ))}
          </View>
          <Button label={busy ? 'Starting…' : 'Start trip'} big onPress={start} disabled={busy} tone="green" />
        </Card>
      )}

      {openTrip && (
        <Card>
          <View style={styles.rowBetween}>
            <Text style={styles.h2}>{openTrip.direction === 'TO_COLLEGE' ? 'To college' : 'From college'}</Text>
            <Badge label={openTrip.status.replace(/_/g, ' ').toUpperCase()} color={openTrip.status === 'arrived' ? colors.green : colors.primary} />
          </View>
          <Text style={[styles.status, { color: background ? colors.green : view.color }]}>
            {background ? 'Sharing bus location (screen-off mode)' : view.text}
          </Text>
          {(gps.state.kind === 'denied' || gps.state.kind === 'approximate_only') && (
            <Button label="Open settings" tone="ghost" onPress={() => void Linking.openSettings()} />
          )}
          {(gps.state.kind === 'denied' || gps.state.kind === 'services_off' || gps.state.kind === 'error') && (
            <Button label="Try again" onPress={() => void startGps(openTrip)} />
          )}
          {gps.state.kind === 'error' && <Text style={styles.fine}>{gps.state.message}</Text>}
          {!background && st && (
            <Text style={styles.fine}>
              {st.lastFixAt ? `GPS fix ${formatAge(Date.now() - st.lastFixAt).replace('Last updated ', '')}` : 'No GPS fix yet'}
              {st.lastAccuracyM !== null ? ` · ±${Math.round(st.lastAccuracyM)} m` : ''}
              {` · sent ${st.sent}`}{st.rejected ? ` · rejected ${st.rejected}` : ''}{st.queued ? ` · ${st.queued} waiting to send` : ''}
            </Text>
          )}
          {lastAckBad && <Text style={styles.warn}>Server did not accept the last fix: {st!.lastAck!.reason}</Text>}
          <View style={styles.rowBetween}>
            <Text style={styles.body}>Keep sharing with screen off</Text>
            <Switch value={background} onValueChange={(v) => void toggleBackground(v)} />
          </View>
          <Button label="End trip" tone="danger" onPress={end} />
        </Card>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 16, backgroundColor: colors.bg, flexGrow: 1 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  h1: { fontSize: 32, fontWeight: '900', color: colors.ink },
  h2: { fontSize: 17, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  body: { color: colors.ink, fontSize: 15, flexShrink: 1 },
  muted: { color: colors.muted },
  fine: { color: colors.muted, fontSize: 12 },
  status: { fontWeight: '700', fontSize: 16 },
  warn: { color: colors.amber, fontWeight: '600' },
  error: { padding: 4, color: colors.red },
  link: { color: colors.red, fontWeight: '700', fontSize: 16 },
});
