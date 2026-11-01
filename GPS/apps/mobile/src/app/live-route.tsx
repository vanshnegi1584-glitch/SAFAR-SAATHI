import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card, Chip, colors } from '@/components/ui';
import { getTracking } from '@/lib/live';
import { useTracking } from '@/store/tracking';

/** Student picks the route (and stop) they ride; this decides which bus locations they may see. */
export default function LiveRoute() {
  const snapshot = useTracking((s) => s.snapshot);
  const me = useTracking((s) => s.me);
  const [routeId, setRouteId] = useState<string | null>(me?.student_route?.route_id ?? null);
  const [stopId, setStopId] = useState<string | null>(me?.student_route?.stop_id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!snapshot) void getTracking().snapshot().then((s) => useTracking.getState().setSnapshot(s)).catch((e) => setError(String(e.message)));
  }, [snapshot]);

  if (!snapshot) return error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator style={{ flex: 1 }} />;
  const route = snapshot.routes.find((r) => r.id === routeId);
  const stopName = (id: string) => snapshot.stops.find((s) => s.id === id)?.name ?? id;

  const save = async () => {
    if (!routeId) return;
    setSaving(true);
    try {
      const r = await getTracking().setStudentRoute(routeId, stopId);
      useTracking.getState().setMe(me ? { ...me, student_route: r } : me);
      await getTracking().subscribeRoute(r.route_id);
      useTracking.getState().setSnapshot(await getTracking().snapshot());
      router.replace('/live-student');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.h1}>Your route</Text>
      <Card>
        <View style={styles.wrap}>
          {snapshot.routes.map((r) => (
            <Chip key={r.id} label={r.name} selected={r.id === routeId} onPress={() => { setRouteId(r.id); setStopId(null); }} />
          ))}
        </View>
      </Card>
      {route && (
        <Card>
          <Text style={styles.muted}>{route.stop_ids.map(stopName).join(' → ')}</Text>
          {!route.ready && <Text style={styles.warn}>Live ETA isn't available on this route yet (stops not verified). You'll still see the bus position.</Text>}
          <Text style={styles.h2}>Your stop</Text>
          <View style={styles.wrap}>
            {[...new Set(route.stop_ids.filter((id) => id !== route.college_stop_id))].map((id) => (
              <Chip key={id} label={stopName(id)} selected={id === stopId} onPress={() => setStopId(id)} />
            ))}
          </View>
        </Card>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <Button label={saving ? 'Saving…' : 'Continue'} disabled={!routeId || saving} onPress={save} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 16, backgroundColor: colors.bg, flexGrow: 1 },
  h1: { fontSize: 28, fontWeight: '800', color: colors.ink },
  h2: { fontSize: 16, fontWeight: '700', color: colors.ink, marginTop: 4 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  muted: { color: colors.muted },
  warn: { color: colors.amber },
  error: { padding: 20, color: colors.red },
});
