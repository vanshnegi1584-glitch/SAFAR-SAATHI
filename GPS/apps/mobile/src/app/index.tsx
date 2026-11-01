import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card, Chip, colors } from '@/components/ui';
import { isMock } from '@/lib/dataSource';
import { isLive } from '@/lib/live';
import { useSnapshot } from '@/lib/queries';
import { useSession, type Role } from '@/store/session';

/**
 * Role + profile selection. In live mode this is replaced by Supabase login, where role,
 * default route and assigned bus come from the `users` table.
 */
export default function Welcome() {
  if (isLive()) return <Redirect href="/login" />;
  return <DemoWelcome />;
}

function DemoWelcome() {
  const { data, isLoading, error } = useSnapshot();
  const setStudent = useSession((s) => s.setStudent);
  const setDriver = useSession((s) => s.setDriver);
  const [role, setRole] = useState<Role>('student');
  const [routeId, setRouteId] = useState<string | null>(null);
  const [stopId, setStopId] = useState<string | null>(null);
  const [busId, setBusId] = useState<string | null>(null);

  if (isLoading) return <ActivityIndicator style={{ flex: 1 }} />;
  if (error || !data) return <Text style={styles.error}>Could not load routes: {String(error)}</Text>;

  const stops = data.stops.filter((s) => s.route_id === routeId && s.stop_name !== 'Graphic Era Campus');
  const buses = data.buses.filter((b) => b.status === 'active');

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {isMock() && <Text style={styles.mock}>DEMO MODE · simulated buses</Text>}
      <Text style={styles.h1}>Who are you?</Text>
      <View style={styles.row}>
        <Chip label="🎓 Student" selected={role === 'student'} onPress={() => setRole('student')} />
        <Chip label="🚌 Driver" selected={role === 'driver'} onPress={() => setRole('driver')} />
      </View>

      {role === 'student' ? (
        <Card>
          <Text style={styles.h2}>Your route</Text>
          <View style={styles.wrap}>
            {data.routes.map((r) => (
              <Chip key={r.id} label={r.name} color={r.color} selected={r.id === routeId} onPress={() => { setRouteId(r.id); setStopId(null); }} />
            ))}
          </View>
          {routeId && (
            <>
              <Text style={styles.h2}>Your stop</Text>
              <View style={styles.wrap}>
                {stops.map((s) => (
                  <Chip key={s.id} label={s.stop_name} selected={s.id === stopId} onPress={() => setStopId(s.id)} />
                ))}
              </View>
            </>
          )}
          <Button
            label="Continue"
            disabled={!routeId || !stopId}
            onPress={() => { setStudent(routeId!, stopId!); router.replace('/student'); }}
          />
        </Card>
      ) : (
        <Card>
          <Text style={styles.h2}>Your bus today</Text>
          <View style={styles.wrap}>
            {buses.map((b) => (
              <Chip key={b.id} label={`${b.id} · ${b.registration_number}`} selected={b.id === busId} onPress={() => setBusId(b.id)} />
            ))}
          </View>
          <Button label="Start shift" disabled={!busId} onPress={() => { setDriver(busId!); router.replace('/driver'); }} />
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 16, backgroundColor: colors.bg, flexGrow: 1 },
  h1: { fontSize: 28, fontWeight: '800', color: colors.ink },
  h2: { fontSize: 16, fontWeight: '700', color: colors.ink, marginTop: 4 },
  row: { flexDirection: 'row', gap: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mock: { alignSelf: 'flex-start', backgroundColor: '#fef3c7', color: '#92400e', fontWeight: '700', fontSize: 12, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  error: { padding: 20, color: colors.red },
});
