import type { LngLat } from '@transitlink/shared';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { getDataSource } from '../lib/dataSource';

export const GEOFENCE_TASK = 'transitlink-geofence';

export interface GeofenceLogEntry {
  regionKey: string;
  event: 'enter' | 'exit';
  at: number;
}

// The bus id is encoded in the region identifier, so the task still knows which bus it belongs to
// when the OS relaunches the JS runtime in the background with no app state.
const SEP = '|';
const toIdentifier = (regionKey: string, busId: string) => `${regionKey}${SEP}${busId}`;

const listeners = new Set<(e: GeofenceLogEntry) => void>();
export function onGeofenceEvent(l: (e: GeofenceLogEntry) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

interface GeofenceTaskData {
  eventType: Location.GeofencingEventType;
  region: Location.LocationRegion;
}

TaskManager.defineTask<GeofenceTaskData>(GEOFENCE_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('Geofence task error', error.message);
    return;
  }
  if (!data?.region.identifier) return;
  const [regionKey, busId] = data.region.identifier.split(SEP);
  if (!regionKey || !busId) return;
  const event = data.eventType === Location.GeofencingEventType.Enter ? 'enter' : 'exit';
  const entry: GeofenceLogEntry = { regionKey, event, at: Date.now() };
  listeners.forEach((l) => l(entry));
  try {
    await getDataSource().reportGeofenceEvent({
      bus_id: busId,
      region_id: regionKey,
      event,
      timestamp: Math.floor(entry.at / 1000),
    });
  } catch (e) {
    // TODO: queue and retry when offline, like the ESP32 does (§6)
    console.warn('Failed to report geofence event', e);
  }
});

export interface FenceRegion {
  key: string; // 'campus' or 'stop:<id>'
  location: LngLat;
  radius: number;
}

export type GeofenceStatus = 'active' | 'needs-foreground' | 'needs-background' | 'unavailable';

/** Foreground permission must be granted before background; caller explains why before calling. */
export async function startGeofencing(busId: string, regions: FenceRegion[]): Promise<GeofenceStatus> {
  try {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (!fg.granted) return 'needs-foreground';
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (!bg.granted) return 'needs-background';
    await Location.startGeofencingAsync(
      GEOFENCE_TASK,
      regions.slice(0, 20).map((r) => ({ // iOS monitors at most 20 regions
        identifier: toIdentifier(r.key, busId),
        latitude: r.location[1],
        longitude: r.location[0],
        radius: r.radius,
        notifyOnEnter: true,
        notifyOnExit: true,
      })),
    );
    return 'active';
  } catch (e) {
    // Background location is not available in Expo Go — needs a development build.
    console.warn('Geofencing unavailable', e);
    return 'unavailable';
  }
}

export async function stopGeofencing(): Promise<void> {
  if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false)) {
    await Location.stopGeofencingAsync(GEOFENCE_TASK);
  }
}
