// Domain types mirroring the Supabase schema (Blueprint §2.1) and MQTT payload (§3.2).
// Enum *values* are not given in the blueprint — the ones below are assumptions to agree with Siddhant.

export type LngLat = [lng: number, lat: number];

export type UserRole = 'student' | 'driver' | 'dispatcher' | 'admin';
export type BusStatus = 'active' | 'idle' | 'maintenance' | 'offline';
export type TokenStatus = 'waiting' | 'called' | 'boarded' | 'expired' | 'cancelled';

export interface Route {
  id: string;
  name: string;
  /** GeoJSON LineString coordinates, [lng, lat] order. */
  polyline: LngLat[];
  is_active: boolean;
  color?: string; // UI-only
}

export interface Stop {
  id: string;
  route_id: string;
  stop_name: string;
  location: LngLat;
  geofence_radius_meters: number;
}

export interface Bus {
  id: string;
  /** Number allotted to the bus by the transport office ("18", "42") — what students know it by. */
  fleet_number?: string;
  registration_number: string;
  max_capacity: number;
  status: BusStatus;
}

export interface ActiveTrip {
  id: string;
  bus_id: string;
  route_id: string;
  start_time: string; // ISO
  end_time: string | null;
  is_last_bus: boolean;
}

export interface DigitalToken {
  id: string;
  student_id: string;
  student_name?: string; // joined for display
  trip_id: string;
  queue_position: number;
  status: TokenStatus;
  created_at: string;
}

/** Raw ESP32 payload, exactly as published over MQTT (§3.2). */
export interface MqttTelemetryPayload {
  bus_id: string;
  timestamp: number; // unix seconds
  gps: { lat: number; lon: number; speed: number; sats: number };
  pax: { in_count: number; out_count: number; net_current: number };
  sos_active: boolean;
}

/**
 * What the frontend receives over Socket.io after the backend has fused IR + CV counts.
 * Proposed contract — see docs/CONTRACT.md.
 */
export interface TelemetryUpdate {
  bus_id: string;
  trip_id: string | null;
  timestamp: number; // unix seconds (device time)
  location: LngLat;
  speed_kmh: number;
  sats: number;
  current_pax_count: number; // fused value
  sos_active: boolean;
}

export interface FallbackSuggestion {
  student_id: string;
  route_id: string;
  route_name: string;
  stop_id: string;
  stop_name: string;
  distance_meters: number; // from student's home to stop
  trip_id: string;
  available_seats: number;
}

export interface SosAlert {
  bus_id: string;
  trip_id: string | null;
  location: LngLat;
  raised_at: number; // unix seconds
}

/** Socket.io server → client events (proposed). */
export interface ServerToClientEvents {
  'telemetry:update': (u: TelemetryUpdate) => void;
  /** Bulk replay after a network partition (§6) — ordered oldest → newest. */
  'telemetry:batch': (u: TelemetryUpdate[]) => void;
  'token:update': (t: DigitalToken) => void;
  'sos:alert': (a: SosAlert) => void;
  'sos:cleared': (a: { bus_id: string }) => void;
  'trip:last_bus_departed': (a: { route_id: string; trip_id: string }) => void;
  'fallback:suggestion': (s: FallbackSuggestion) => void;
}
