// Where a bus's position comes from, in words riders and the office understand.
export const GPS_SOURCE = { phone: 'driver’s phone', device: 'bus GPS', gps_server: 'driver app GPS' }

const LIVE_MS = 60_000 // same "live" window as LocationAge

/** True while the bus's position is coming live from the campus GPS tracking server (the driver app). */
export function onDriverAppGps(bus, now = Date.now()) {
  return bus?.location_source === 'gps_server' && !!bus.location_at && now - new Date(bus.location_at).getTime() < LIVE_MS
}
