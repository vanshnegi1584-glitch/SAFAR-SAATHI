// Types for live GPS tracking of campus buses. Static schedule data (schedule.ts) and live telemetry
// (these types) are deliberately separate: a scheduled departure is not an active, GPS-tracked trip.

import type { LngLat } from './types';

/**
 * Logical direction along the route's CSV stop order, independent of the map's orientation.
 * TO_COLLEGE follows the CSV order (first listed stop → college); FROM_COLLEGE is the reverse.
 */
export type TripDirection = 'TO_COLLEGE' | 'FROM_COLLEGE';

export type LocationSource = 'driver_device' | 'vehicle_tracker';

export type TripStatus = 'waiting_for_gps' | 'active' | 'arrived' | 'completed' | 'cancelled';

/** Update freshness — how recent the last accepted fix is. Says nothing about GPS accuracy. */
export type FreshnessStatus = 'LIVE' | 'DELAYED' | 'STALE' | 'WAITING_FOR_GPS' | 'TRIP_ENDED';

/** Measurement quality from the device-reported accuracy radius. */
export type FixQuality = 'good' | 'fair' | 'poor';

/** One validated location measurement. Times are epoch milliseconds. */
export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
  /** When the device measured it (device clock). */
  measured_at: number;
  /** Monotonic per tracking session; rejects out-of-order delivery. */
  sequence: number;
  source: LocationSource;
}

/** Wire format a driver device sends (camelCase, ISO timestamp), validated by parseDriverLocation. */
export interface DriverLocationPayload {
  busId: string;
  tripId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
  timestamp: string;
  sequence: number;
  source: LocationSource;
}

export interface TripSummary {
  id: string;
  bus_id: string;
  route_id: string;
  route_version: number;
  direction: TripDirection;
  status: TripStatus;
  slot_id: string | null;
  scheduled_departure: string | null;
  started_at: string;
  first_fix_at: string | null;
  departed_at: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  /** False when stops/geometry are not verified — position is shown, but no ETA or stop progress. */
  route_ready: boolean;
  route_problems: string[];
}

export interface RouteProgress {
  on_route: boolean;
  distance_from_route_m: number;
  along_m: number;
  /** 0..1 of the directed route length. */
  progress: number;
  next_stop_id: string | null;
  next_stop_name: string | null;
  remaining_to_next_stop_m: number | null;
  remaining_to_destination_m: number;
}

export type EtaStatus = 'ok' | 'stationary' | 'stale' | 'unavailable' | 'arrived';

export interface EtaEstimate {
  status: EtaStatus;
  /** Seconds from `computed_at`; null unless status is 'ok'. */
  destination_seconds: number | null;
  next_stop_seconds: number | null;
  /** How the speed was chosen, so the UI can say what the estimate is based on. */
  basis: 'historical' | 'live_speed_blend' | 'baseline' | null;
  computed_at: number;
  reason: string | null;
}

/** `bus:location` — the latest accepted fix for a bus, enriched by the server. */
export interface BusLocationEvent {
  bus_id: string;
  trip_id: string;
  route_id: string;
  direction: TripDirection;
  source: LocationSource;
  location: LngLat;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
  quality: FixQuality;
  measured_at: number;
  received_at: number;
  sequence: number;
  /** Null when the route is not configured (no verified geometry/stops). */
  route: RouteProgress | null;
  eta: EtaEstimate;
  server_time: number;
}

export interface BusStatusEvent {
  bus_id: string;
  trip_id: string;
  last_measured_at: number | null;
  server_time: number;
}

export interface BusArrivedEvent {
  bus_id: string;
  trip_id: string;
  stop_id: string;
  stop_name: string;
  /** True when this is the trip's destination (college for TO_COLLEGE). */
  final: boolean;
  at: number;
}

export interface RouteDeviationEvent {
  bus_id: string;
  trip_id: string;
  distance_from_route_m: number;
  /** False when the deviation starts, true when the bus is back on the route. */
  resolved: boolean;
  at: number;
}

/** Where a seat count came from, as decided by the vision module's IR/camera fusion (ai_face/vision). */
export type SeatSource = 'camera' | 'ir' | 'unavailable';

/** Where an on-board people count came from: IR door counters (whole bus) or the camera (people in view only). */
export type PeopleSource = 'ir' | 'camera' | 'unavailable';

/**
 * `bus:seats` — free seats for a bus from its on-board fusion service (`GET /fusion`). `seats_free` is
 * null whenever the number can't be trusted: service unreachable, stale sensors, or a capacity that
 * disagrees with the schedule.
 */
export interface BusSeatsEvent {
  bus_id: string;
  route_id: string | null;
  seats_free: number | null;
  /** Seats per the schedule CSV (not the vision service's own setting). */
  capacity: number | null;
  source: SeatSource;
  /** Vision service reason (e.g. 'normal', 'sensor_disagreement') or ours ('unreachable', 'capacity_mismatch'). */
  reason: string;
  recalibration_required: boolean;
  /** Anonymous people on board from the same fusion service; null when unknown or the reading is doubtful. */
  people_on_board: number | null;
  people_source: PeopleSource;
  /** Server time this reading was received (ms). */
  received_at: number;
  server_time: number;
}

export interface TrackingErrorEvent {
  code: string;
  message: string;
}

/** Socket.IO server → client events for GPS tracking. */
export interface TrackingServerEvents {
  'trip:started': (t: TripSummary) => void;
  'trip:updated': (t: TripSummary) => void;
  'trip:ended': (t: TripSummary) => void;
  'bus:location': (e: BusLocationEvent) => void;
  'bus:stale': (e: BusStatusEvent) => void;
  'bus:offline': (e: BusStatusEvent) => void;
  'bus:arrived': (e: BusArrivedEvent) => void;
  'route:deviation': (e: RouteDeviationEvent) => void;
  'bus:seats': (e: BusSeatsEvent) => void;
  'tracking:error': (e: TrackingErrorEvent) => void;
}

export interface LocationAck {
  ok: boolean;
  accepted: boolean;
  reason?: string;
  sequence?: number;
}

/** Socket.IO client → server events for GPS tracking. */
export interface TrackingClientEvents {
  'driver:location': (p: DriverLocationPayload, ack: (a: LocationAck) => void) => void;
  'track:subscribe': (p: { route_id: string }, ack: (a: { ok: boolean; error?: string }) => void) => void;
  'track:unsubscribe': (p: { route_id: string }) => void;
}

/** A stop on a route as published to clients (no personal data). */
export interface PublicStop {
  id: string;
  name: string;
  location: LngLat | null;
  status: 'unverified' | 'candidate' | 'verified';
  geofence_radius_m: number;
  is_college_endpoint: boolean;
}

export interface PublicRoute {
  id: string;
  name: string;
  version: number;
  /** Stop ids in CSV (TO_COLLEGE) order. */
  stop_ids: string[];
  college_stop_id: string | null;
  geometry: LngLat[] | null;
  geometry_status: 'missing' | 'candidate' | 'verified';
  ready: boolean;
  problems: string[];
}

export interface PublicBus {
  id: string;
  registration_number: string;
  fleet_number: string;
  seats: number | null;
  route_id: string | null;
  is_active: boolean;
}

export interface TrackingSnapshot {
  routes: PublicRoute[];
  stops: PublicStop[];
  buses: PublicBus[];
  trips: TripSummary[];
  latest: BusLocationEvent[];
  seats: BusSeatsEvent[];
  server_time: number;
}
