import {
  buildRoutePlan, busLabel, displayPeople, displaySeats, effectiveFixTime, PEOPLE_SOURCE_TEXT, SEAT_SOURCE_TEXT, ETA_BASIS_TEXT, etaSecondsNow, formatAge, formatEtaMinutes, freshnessOf, haversine,
  type BusLocationEvent, type FreshnessStatus, type LngLat, type TripSummary,
} from '@transitlink/shared';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import { Redirect, router, Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FRESHNESS_COLOR, LiveBusMap } from '@/components/LiveBusMap';
import { Badge, Button, Card, Chip, colors } from '@/components/ui';
import { getAuth } from '@/lib/live';
import { serverNow, useTracking } from '@/store/tracking';

const FRESHNESS_LABEL: Record<FreshnessStatus, string> = {
  LIVE: 'LIVE', DELAYED: 'DELAYED', STALE: 'STALE', WAITING_FOR_GPS: 'WAITING FOR GPS', TRIP_ENDED: 'TRIP ENDED',
};

type LocPerm = 'unknown' | 'explain' | 'granted' | 'denied' | 'blocked' | 'dismissed';

/** Re-renders every second so ages and countdowns stay current. */
function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/**
 * Student's own location: requested only after an explanation and only on tap, never re-prompted after
 * a refusal, and never uploaded — it is used on this phone for the map and distance to the stop.
 */
function useStudentLocation() {
  const [perm, setPerm] = useState<LocPerm>('unknown');
  const [me, setMe] = useState<{ location: LngLat; accuracy: number | null } | null>(null);

  useEffect(() => {
    void Location.getForegroundPermissionsAsync().then((p) =>
      setPerm(p.granted ? 'granted' : !p.canAskAgain ? 'blocked' : p.status === 'denied' ? 'denied' : 'explain'));
  }, []);

  useEffect(() => {
    if (perm !== 'granted') return;
    let sub: Location.LocationSubscription | null = null;
    void Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 10 },
      (l) => setMe({ location: [l.coords.longitude, l.coords.latitude], accuracy: l.coords.accuracy ?? null }))
      .then((s) => { sub = s; })
      .catch(() => setPerm('denied'));
    return () => sub?.remove();
  }, [perm]);

  const request = async () => {
    const p = await Location.requestForegroundPermissionsAsync();
    setPerm(p.granted ? 'granted' : p.canAskAgain ? 'denied' : 'blocked');
  };
  return { perm, me, request, dismiss: () => setPerm('dismissed') };
}

export default function LiveStudent() {
  useTick();
  const me = useTracking((s) => s.me);
  const snapshot = useTracking((s) => s.snapshot);
  const trips = useTracking((s) => s.trips);
  const latest = useTracking((s) => s.latest);
  const seats = useTracking((s) => s.seats);
  const connection = useTracking((s) => s.connection);
  const deviation = useTracking((s) => s.deviation);
  const lastArrival = useTracking((s) => s.lastArrival);
  const loc = useStudentLocation();
  const [chosenTripId, setChosenTripId] = useState<string | null>(null);

  const routeId = me?.student_route?.route_id ?? null;
  const myStopId = me?.student_route?.stop_id ?? null;
  const route = snapshot?.routes.find((r) => r.id === routeId) ?? null;
  const stops = useMemo(() => snapshot?.stops.filter((s) => route?.stop_ids.includes(s.id)) ?? [], [snapshot, route]);
  const myStop = stops.find((s) => s.id === myStopId) ?? null;

  const openTrips = Object.values(trips).filter((t) => t.route_id === routeId && !['completed', 'cancelled'].includes(t.status));
  // Default to the bus with the freshest fix; the student can switch between buses on the route.
  const trip: TripSummary | undefined = openTrips.find((t) => t.id === chosenTripId) ??
    openTrips.sort((a, b) => (latest[b.bus_id]?.measured_at ?? 0) - (latest[a.bus_id]?.measured_at ?? 0))[0];
  const bus = trip ? snapshot?.buses.find((b) => b.id === trip.bus_id) : undefined;
  const ev: BusLocationEvent | null = trip && latest[trip.bus_id]?.trip_id === trip.id ? latest[trip.bus_id]! : null;

  const now = serverNow();
  const fixAt = ev ? effectiveFixTime(ev) : null;
  const freshness = freshnessOf(fixAt, now, trip?.status ?? null);
  const live = freshness === 'LIVE' || freshness === 'DELAYED';
  const seatInfo = trip ? displaySeats(seats[trip.bus_id], now) : null;
  const peopleInfo = trip ? displayPeople(seats[trip.bus_id], now) : null;

  // ETA to *my* stop: same verified route data as the server, same speed basis as the server's estimate.
  const myEta = useMemo(() => {
    if (!trip || !route?.ready || !myStop || !ev?.route || ev.eta.status !== 'ok' || route.version !== trip.route_version) return null;
    try {
      const plan = buildRoutePlan({ route, stops: new Map(stops.map((s) => [s.id, s])) }, trip.direction);
      const target = plan.stops.filter((s) => s.stop_id === myStop.id).find((s) => s.along_m + s.geofence_radius_m >= ev.route!.along_m);
      if (!target) return { passed: true as const };
      const meters = Math.max(0, target.along_m - ev.route.along_m);
      const mps = ev.eta.destination_seconds ? ev.route.remaining_to_destination_m / ev.eta.destination_seconds : null;
      return { passed: false as const, meters, seconds: mps ? meters / mps : null };
    } catch {
      return null;
    }
  }, [trip, route, stops, myStop, ev]);

  if (!me) return <Redirect href="/login" />;
  if (!routeId) return <Redirect href="/live-route" />;

  const dev = trip ? deviation[trip.id] : undefined;
  const directionText = trip?.direction === 'TO_COLLEGE'
    ? `Towards college (${stops.find((s) => s.is_college_endpoint)?.name ?? 'GEU'})`
    : `From college towards ${stops.find((s) => s.id === route?.stop_ids[0])?.name ?? 'first stop'}`;
  const distToMyStop = loc.me && myStop?.location ? haversine(loc.me.location, myStop.location) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        title: route?.name ?? 'My bus',
        headerRight: () => (
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <Text style={styles.link} onPress={() => router.push('/live-route')}>Route</Text>
            <Text style={styles.link} onPress={() => void getAuth().signOut().then(() => { useTracking.getState().reset(); router.replace('/login'); })}>Sign out</Text>
          </View>
        ),
      }} />
      <LiveBusMap route={route} stops={stops} myStopId={myStopId} bus={ev} freshness={freshness} showUser={loc.perm === 'granted'} />

      <SafeAreaView edges={['bottom']} style={styles.bottom} pointerEvents="box-none">
        <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 8 }}>
          {loc.perm === 'explain' && (
            <Card>
              <Text style={styles.body}>Enable location access to see your position, nearby stops, and the live location of your assigned college bus.</Text>
              <Text style={styles.fine}>Your location stays on this phone — it is not sent to the college or other users.</Text>
              <View style={styles.row}>
                <Button label="Enable location" onPress={() => void loc.request()} />
                <Button label="Not now" tone="ghost" onPress={loc.dismiss} />
              </View>
            </Card>
          )}
          {(loc.perm === 'denied' || loc.perm === 'blocked') && (
            <Card>
              <Text style={styles.body}>Location is off for this app, so your own position isn't shown. Bus tracking and timings still work.</Text>
              <Text style={styles.fine}>To turn it on: Settings → Apps → TransitLink → Location → "While using the app".</Text>
              <View style={styles.row}>
                <Button label="Open settings" tone="ghost" onPress={() => void Linking.openSettings()} />
                <Button label="Dismiss" tone="ghost" onPress={loc.dismiss} />
              </View>
            </Card>
          )}

          <Card>
            {connection !== 'connected' && <Text style={styles.warn}>{connection === 'unauthorised' ? 'Session expired — please sign in again.' : 'Reconnecting to live updates…'}</Text>}
            {openTrips.length > 1 && (
              <View style={styles.wrap}>
                {openTrips.map((t) => {
                  const b = snapshot?.buses.find((x) => x.id === t.bus_id);
                  return <Chip key={t.id} label={`Bus ${b?.fleet_number ?? t.bus_id}`} selected={t.id === trip?.id} onPress={() => setChosenTripId(t.id)} />;
                })}
              </View>
            )}
            {!trip ? (
              <Text style={styles.h2}>No bus on your route is being tracked right now.</Text>
            ) : (
              <>
                <View style={styles.rowBetween}>
                  <Text style={styles.h2}>{busLabel(bus, trip.bus_id)}</Text>
                  <Badge label={FRESHNESS_LABEL[freshness]} color={FRESHNESS_COLOR[freshness]} />
                </View>
                <Text style={styles.muted}>{directionText}</Text>
                {seatInfo ? (
                  <Text style={[styles.h2, { color: seatInfo.free === 0 ? colors.red : colors.green }]}>
                    {seatInfo.free === 0 ? 'No seats free' : `${seatInfo.free}${seatInfo.capacity ? ` of ${seatInfo.capacity}` : ''} seats free`}
                    <Text style={styles.fine}> · {SEAT_SOURCE_TEXT[seatInfo.source as keyof typeof SEAT_SOURCE_TEXT]}</Text>
                  </Text>
                ) : (
                  seats[trip.bus_id] && <Text style={styles.fine}>Seat count unavailable right now</Text>
                )}
                {peopleInfo && (
                  <Text style={styles.muted}>
                    {peopleInfo.count} {peopleInfo.count === 1 ? 'person' : 'people'} on board
                    <Text style={styles.fine}> · {PEOPLE_SOURCE_TEXT[peopleInfo.source]}</Text>
                  </Text>
                )}
                {trip.status === 'arrived' && <Text style={[styles.h2, { color: colors.green }]}>Arrived at destination</Text>}

                {myEta && !myEta.passed && trip.status !== 'arrived' && (
                  // No countdown from a stale position: show the ETA only while updates are recent.
                  <Text style={[styles.eta, !live && { color: colors.muted, fontSize: 22 }]} accessibilityLiveRegion="polite">
                    {live ? formatEtaMinutes(etaSecondsNow(myEta.seconds, ev!.eta.computed_at, now)) : 'ETA unavailable'}
                  </Text>
                )}
                {myEta?.passed && <Text style={styles.h2}>The bus has passed your stop.</Text>}
                {myStop && myEta && !myEta.passed && <Text style={styles.muted}>to {myStop.name} · {(myEta.meters / 1000).toFixed(1)} km along the route</Text>}
                {ev?.route?.next_stop_name && <Text style={styles.muted}>Next stop: {ev.route.next_stop_name}{ev.route.remaining_to_next_stop_m !== null ? ` (${(ev.route.remaining_to_next_stop_m / 1000).toFixed(1)} km)` : ''}</Text>}

                {ev ? (
                  <Text style={styles.fine}>
                    {formatAge(now - fixAt!)}
                    {ev.accuracy_m !== null ? ` · GPS ±${Math.round(ev.accuracy_m)} m` : ' · GPS accuracy unknown'}
                    {ev.quality === 'poor' ? ' (weak signal)' : ''}
                  </Text>
                ) : (
                  <Text style={styles.muted}>Trip started — waiting for the bus's first GPS fix.</Text>
                )}
                {!trip.route_ready && <Text style={styles.warn}>ETA unavailable: this route's stops/geometry are not verified yet. Position is shown as reported.</Text>}
                {ev && ev.eta.status === 'stationary' && <Text style={styles.warn}>The bus has not moved for a while — ETA paused.</Text>}
                {freshness === 'STALE' && <Text style={styles.warn}>No recent update from the bus. Showing its last known position.</Text>}
                {dev && !dev.resolved && <Text style={styles.warn}>The bus is off its usual route (~{dev.distance_from_route_m} m away).</Text>}
                {ev?.eta.basis && myEta && !myEta.passed && <Text style={styles.fine}>{ETA_BASIS_TEXT[ev.eta.basis]}. It is an estimate, not a guarantee.</Text>}
                {lastArrival && lastArrival.trip_id === trip.id && !lastArrival.final && <Text style={styles.fine}>Last stop reached: {lastArrival.stop_name}</Text>}
              </>
            )}
            {distToMyStop !== null && myStop && <Text style={styles.fine}>You are {distToMyStop < 1000 ? `${Math.round(distToMyStop)} m` : `${(distToMyStop / 1000).toFixed(1)} km`} from {myStop.name} (straight line).</Text>}
          </Card>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  bottom: { position: 'absolute', left: 12, right: 12, bottom: 12 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  h2: { fontSize: 16, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  body: { color: colors.ink, fontSize: 15 },
  eta: { fontSize: 40, fontWeight: '800', color: colors.ink },
  muted: { color: colors.muted },
  fine: { color: colors.muted, fontSize: 12 },
  warn: { color: colors.amber, fontWeight: '600' },
  link: { color: colors.primary, fontWeight: '600', fontSize: 16 },
});
