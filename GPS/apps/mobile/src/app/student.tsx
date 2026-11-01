import {
  directionAlong, effectivePosition, estimateEta, formatEta, groupTokensByTrip, isStale,
  type ActiveTrip, type DigitalToken, type FleetSnapshot,
} from '@transitlink/shared';
import { Redirect, router, Stack } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BusMap } from '@/components/BusMap';
import { FallbackModal } from '@/components/FallbackModal';
import { Badge, Button, Card, Chip, colors } from '@/components/ui';
import { getDataSource, isMock, MOCK_STUDENT_ID } from '@/lib/dataSource';
import { ensureNotificationPermission } from '@/lib/notify';
import { useJoinQueue, useSetTokenStatus, useSnapshot, useTokens } from '@/lib/queries';
import { useRoadRoutes } from '@/lib/roadRoutes';
import { useSession } from '@/store/session';

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const upcomingTrips = (snap: FleetSnapshot, routeId: string | null) =>
  snap.trips
    .filter((t) => t.route_id === routeId && t.end_time === null)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

export default function StudentScreen() {
  const [tab, setTab] = useState<'track' | 'queue'>('track');
  const { routeId, signOut } = useSession();
  useRoadRoutes();

  useEffect(() => {
    void ensureNotificationPermission(); // queue calls + last-bus alerts
  }, []);

  if (!routeId) return <Redirect href="/" />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{ headerRight: () => <Text style={styles.link} onPress={() => { signOut(); router.replace('/'); }}>Switch</Text> }}
      />
      <View style={styles.tabs}>
        <Chip label="Live bus" selected={tab === 'track'} onPress={() => setTab('track')} />
        <Chip label="Afternoon queue" selected={tab === 'queue'} onPress={() => setTab('queue')} />
      </View>
      {tab === 'track' ? <TrackTab /> : <QueueTab />}
      <FallbackModal />
    </View>
  );
}

function TrackTab() {
  const { data: snap } = useSnapshot();
  const { routeId, stopId, overrideTripId, overrideStopId, latest, followTrip } = useSession();
  const prevLoc = useRef<Record<string, [number, number]>>({});
  const [dir, setDir] = useState<1 | -1>(1);

  const trip: ActiveTrip | undefined = snap &&
    (overrideTripId ? snap.trips.find((t) => t.id === overrideTripId) : upcomingTrips(snap, routeId)[0]);
  const route = snap?.routes.find((r) => r.id === trip?.route_id);
  const stop = snap?.stops.find((s) => s.id === (overrideTripId ? overrideStopId : stopId));
  const bus = snap?.buses.find((b) => b.id === trip?.bus_id);
  const t = bus ? latest[bus.id] : undefined;

  // Infer travel direction from successive positions (buses run both ways on a route).
  useEffect(() => {
    if (!t || !route) return;
    const prev = prevLoc.current[t.bus_id];
    if (prev) {
      const d = directionAlong(route.polyline, prev, t.location);
      if (d) setDir(d);
    }
    prevLoc.current[t.bus_id] = t.location;
  }, [t?.timestamp]);

  const stale = isStale(t?.timestamp, Date.now() / 1000);
  const eta = route && stop && t ? estimateEta(route.polyline, t.location, stop.location, t.speed_kmh, { direction: dir }) : null;
  const lastBusRoute = snap ? upcomingTrips(snap, routeId).find((x) => x.is_last_bus) : undefined;

  return (
    <View style={{ flex: 1 }}>
      <BusMap
        route={route}
        stops={snap?.stops.filter((s) => s.route_id === route?.id) ?? []}
        highlightStopId={stop?.id}
        bus={bus && t ? { id: bus.id, pax: t.current_pax_count, capacity: bus.max_capacity, stale } : null}
      />
      <SafeAreaView edges={['bottom']} style={styles.bottom} pointerEvents="box-none">
        <Card>
          {!trip ? (
            <Text style={styles.h2}>No more buses on your route today.</Text>
          ) : (
            <>
              <View style={styles.rowBetween}>
                <Text style={styles.h2}>{bus?.id} · {route?.name}</Text>
                {trip.is_last_bus && <Badge label="LAST BUS" color={colors.primary} />}
              </View>
              {overrideTripId && <Text style={styles.muted}>Following fallback route</Text>}
              <Text style={styles.eta} accessibilityLiveRegion="polite">
                {!t ? 'Waiting for GPS…' : stale ? 'No signal from bus' : formatEta(eta?.seconds ?? null)}
              </Text>
              <Text style={styles.muted}>
                to {stop?.stop_name}
                {eta && !eta.passed ? ` · ${(eta.meters / 1000).toFixed(1)} km` : ''}
                {t ? ` · ${t.current_pax_count}/${bus?.max_capacity} seats taken` : ''}
              </Text>
              <Text style={styles.fine}>ETA is an estimate from distance and current speed.</Text>
            </>
          )}
          {overrideTripId && <Button label="Back to my route" tone="ghost" onPress={() => followTrip(null)} />}
          {isMock() && lastBusRoute && !overrideTripId && (
            <Button
              label="Demo: last bus leaves campus"
              tone="ghost"
              onPress={() => getDataSource().reportGeofenceEvent({
                bus_id: lastBusRoute.bus_id, region_id: 'campus', event: 'exit', timestamp: Math.floor(Date.now() / 1000),
              })}
            />
          )}
        </Card>
      </SafeAreaView>
    </View>
  );
}

function QueueTab() {
  const { data: snap } = useSnapshot();
  const { data: tokens } = useTokens();
  const { routeId, overrideTripId, latest } = useSession();
  const join = useJoinQueue();
  const setStatus = useSetTokenStatus();

  const effectiveRoute = overrideTripId ? snap?.trips.find((t) => t.id === overrideTripId)?.route_id ?? routeId : routeId;
  const trips = snap ? upcomingTrips(snap, effectiveRoute) : [];
  const byTrip = useMemo(() => groupTokensByTrip(tokens ?? []), [tokens]);

  if (!snap || !tokens) return <Text style={{ padding: 20 }}>Loading…</Text>;
  if (trips.length === 0) return <Text style={{ padding: 20 }}>No departures left today.</Text>;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      {trips.map((trip) => {
        const bus = snap.buses.find((b) => b.id === trip.bus_id)!;
        const list = byTrip.get(trip.id) ?? [];
        const mine = latestMine(list);
        const waiting = list.filter((t) => t.status === 'waiting').length;
        const free = Math.max(0, bus.max_capacity - (latest[bus.id]?.current_pax_count ?? 0));
        return (
          <Card key={trip.id}>
            <View style={styles.rowBetween}>
              <Text style={styles.h2}>Departs {fmtTime(trip.start_time)} · {bus.id}</Text>
              {trip.is_last_bus && <Badge label="LAST BUS" color={colors.primary} />}
            </View>
            <Text style={styles.muted}>{waiting} waiting · {free} seats free</Text>
            <TokenState
              token={mine}
              position={mine ? effectivePosition(mine, list) : null}
              busId={bus.id}
              joining={join.isPending}
              onJoin={() => join.mutate(trip.id)}
              onLeave={() => mine && setStatus.mutate({ id: mine.id, status: 'cancelled' })}
            />
            {join.isError && <Text style={{ color: colors.red }}>Could not join: {String(join.error)}</Text>}
          </Card>
        );
      })}
    </ScrollView>
  );
}

/** The student's most relevant token for a trip: an active one if any, else the most recent. */
function latestMine(list: DigitalToken[]): DigitalToken | undefined {
  const mine = list.filter((t) => t.student_id === MOCK_STUDENT_ID);
  return mine.find((t) => t.status === 'waiting' || t.status === 'called') ?? mine.at(-1);
}

function TokenState({ token, position, busId, joining, onJoin, onLeave }: {
  token: DigitalToken | undefined; position: number | null; busId: string; joining: boolean;
  onJoin: () => void; onLeave: () => void;
}) {
  if (!token || token.status === 'cancelled' || token.status === 'expired') {
    return (
      <>
        {token?.status === 'expired' && <Text style={{ color: colors.amber }}>You missed your call. You can rejoin.</Text>}
        <Button label={joining ? 'Joining…' : 'JOIN QUEUE'} onPress={onJoin} disabled={joining} big />
      </>
    );
  }
  if (token.status === 'called') {
    return (
      <View style={[styles.banner, { backgroundColor: colors.green }]}>
        <Text style={styles.bannerText}>Your turn! Board {busId} now.</Text>
      </View>
    );
  }
  if (token.status === 'boarded') return <Text style={[styles.h2, { color: colors.green }]}>Boarded ✓</Text>;
  return (
    <>
      <Text style={styles.position}>#{position}</Text>
      <Text style={styles.muted}>in line — we'll notify you when it's your turn. No need to wait at the bus.</Text>
      <Button label="Leave queue" tone="ghost" onPress={onLeave} />
    </>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 8, padding: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: colors.line, zIndex: 2 },
  bottom: { position: 'absolute', left: 12, right: 12, bottom: 12 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  h2: { fontSize: 16, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  eta: { fontSize: 40, fontWeight: '800', color: colors.ink },
  muted: { color: colors.muted },
  fine: { color: colors.muted, fontSize: 11 },
  position: { fontSize: 48, fontWeight: '800', color: colors.primary },
  banner: { borderRadius: 12, padding: 16 },
  bannerText: { color: '#fff', fontSize: 20, fontWeight: '800' },
  link: { color: colors.primary, fontWeight: '600', fontSize: 16 },
});
