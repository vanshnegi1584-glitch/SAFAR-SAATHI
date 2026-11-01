import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { toPayload } from '../lib/gpsPublisher';
import { getAuth, getTracking } from '../lib/live';

// Background ("screen off") trip tracking for drivers. Requires a development build — Expo Go has no
// background location — and "Allow all the time" permission. Android shows a persistent notification
// while it runs, so the driver always knows the bus location is being shared.

export const DRIVER_LOCATION_TASK = 'transitlink-driver-location';
const TRIP_KEY = 'transitlink.activeTrip';

interface ActiveTrip { id: string; bus_id: string }

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(DRIVER_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations.length) return;
  const raw = await SecureStore.getItemAsync(TRIP_KEY);
  if (!raw) return;
  const trip = JSON.parse(raw) as ActiveTrip;
  try {
    // The OS may start this JS context cold, with no session in memory.
    if (!(await getAuth().getSession())) await getAuth().restore();
    const fixes = data.locations.sort((a, b) => a.timestamp - b.timestamp).map((l) => toPayload(l, trip));
    const { acks } = await getTracking().postLocations(fixes);
    if (acks.some((a) => a.reason === 'trip_not_active' || a.reason === 'not_authorised_for_bus')) {
      await stopBackgroundTracking(); // trip ended elsewhere or assignment revoked
    }
  } catch (e) {
    console.warn('Background location upload failed', e);
  }
});

export type BackgroundState = 'active' | 'needs-background-permission' | 'unavailable';

export async function startBackgroundTracking(trip: ActiveTrip): Promise<BackgroundState> {
  try {
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (!bg.granted) return 'needs-background-permission';
    await SecureStore.setItemAsync(TRIP_KEY, JSON.stringify(trip));
    await Location.startLocationUpdatesAsync(DRIVER_LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 2000,
      distanceInterval: 0,
      deferredUpdatesInterval: 2000,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.AutomotiveNavigation,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Trip in progress',
        notificationBody: 'Sharing the bus location with students on your route',
        killServiceOnDestroy: false,
      },
    });
    return 'active';
  } catch (e) {
    console.warn('Background tracking unavailable', e);
    return 'unavailable';
  }
}

export async function stopBackgroundTracking(): Promise<void> {
  await SecureStore.deleteItemAsync(TRIP_KEY);
  if (await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
  }
}

export const isBackgroundTracking = () => Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK).catch(() => false);
