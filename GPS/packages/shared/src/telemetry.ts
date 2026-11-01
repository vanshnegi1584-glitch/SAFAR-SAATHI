import type { MqttTelemetryPayload, TelemetryUpdate } from './types';

/**
 * Maps the raw ESP32 payload (§3.2) to the shape the UI consumes. In production the backend does
 * this (and replaces net_current with the IR+CV fused count from Vansh's service); the mock uses it
 * so the simulator speaks Rahul's exact wire format.
 */
export function normalizeMqtt(p: MqttTelemetryPayload, tripId: string | null): TelemetryUpdate {
  return {
    bus_id: p.bus_id,
    trip_id: tripId,
    timestamp: p.timestamp,
    location: [p.gps.lon, p.gps.lat], // note: GeoJSON order is [lng, lat]
    speed_kmh: p.gps.speed,
    sats: p.gps.sats,
    current_pax_count: Math.max(0, p.pax.net_current),
    sos_active: p.sos_active,
  };
}

/** No telemetry for this long → show the bus as stale (GSM dropout, §6). */
export const STALE_AFTER_SECONDS = 10;

export function isStale(lastTimestamp: number | undefined, nowSeconds: number): boolean {
  return lastTimestamp === undefined || nowSeconds - lastTimestamp > STALE_AFTER_SECONDS;
}
