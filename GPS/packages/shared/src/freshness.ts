import type { BusLocationEvent, BusSeatsEvent, EtaEstimate, FreshnessStatus, PeopleSource, SeatSource, TripStatus } from './trackingTypes';

// How recent the last accepted fix is, and an honest ETA built only from route progress. Neither
// pretends to know more than the data supports: stale positions are labelled stale, and no ETA is
// produced without verified route geometry.

export interface FreshnessConfig {
  /** 0..liveMaxSec → LIVE */
  liveMaxSec: number;
  /** liveMaxSec..delayedMaxSec → DELAYED, beyond → STALE */
  delayedMaxSec: number;
  /** Server reports the bus offline after this long without fixes. */
  offlineAfterSec: number;
}

export const DEFAULT_FRESHNESS: FreshnessConfig = { liveMaxSec: 5, delayedMaxSec: 15, offlineAfterSec: 60 };

/**
 * Time the position actually describes, in server-clock ms. Uses the device measurement time but never
 * a time later than the server received it (a device clock running fast must not make data look fresh).
 */
export const effectiveFixTime = (e: Pick<BusLocationEvent, 'measured_at' | 'received_at'>) =>
  Math.min(e.measured_at, e.received_at);

export function freshnessOf(
  lastFixAt: number | null, serverNowMs: number, tripStatus: TripStatus | null,
  cfg: FreshnessConfig = DEFAULT_FRESHNESS,
): FreshnessStatus {
  if (tripStatus === 'completed' || tripStatus === 'cancelled') return 'TRIP_ENDED';
  if (lastFixAt === null) return 'WAITING_FOR_GPS';
  const age = (serverNowMs - lastFixAt) / 1000;
  if (age <= cfg.liveMaxSec) return 'LIVE';
  if (age <= cfg.delayedMaxSec) return 'DELAYED';
  return 'STALE';
}

export function formatAge(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 60) return `Last updated ${s} second${s === 1 ? '' : 's'} ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `Last updated ${m} minute${m === 1 ? '' : 's'} ago`;
  return 'Last updated over an hour ago';
}

export interface EtaPolicy {
  /** Transparent baseline when there is no history: typical Dehradun city-bus average incl. stops. */
  baselineKmh: number;
  /** Live speed only counts when the fix is at least this accurate and the bus is moving. */
  liveSpeedMinMps: number;
  liveSpeedMaxMps: number;
  /** Weight of current speed vs. baseline; current speed alone overreacts to every traffic light. */
  liveSpeedWeight: number;
  /** Stopped longer than this → show "bus stationary" instead of a countdown. */
  stationaryAfterMs: number;
}

export const DEFAULT_ETA_POLICY: EtaPolicy = {
  baselineKmh: 18,
  liveSpeedMinMps: 2,
  liveSpeedMaxMps: 17,
  liveSpeedWeight: 0.4,
  stationaryAfterMs: 90_000,
};

export interface EtaInput {
  routeReady: boolean;
  freshness: FreshnessStatus;
  arrived: boolean;
  remainingToDestinationM: number | null;
  remainingToNextStopM: number | null;
  /** Smoothed speed from accurate fixes, m/s; null if unknown. */
  speedMps: number | null;
  stationarySinceMs: number | null;
  /** Average speed for this route/time of day from completed trips, if enough exist. */
  historicalMps?: number | null;
  nowMs: number;
}

export function estimateRouteEta(i: EtaInput, policy: EtaPolicy = DEFAULT_ETA_POLICY): EtaEstimate {
  const none = (status: EtaEstimate['status'], reason: string): EtaEstimate =>
    ({ status, destination_seconds: null, next_stop_seconds: null, basis: null, computed_at: i.nowMs, reason });

  if (i.arrived) return none('arrived', 'Bus has arrived');
  if (!i.routeReady || i.remainingToDestinationM === null) return none('unavailable', 'Route stops/geometry not verified yet');
  if (i.freshness === 'TRIP_ENDED') return none('unavailable', 'Trip ended');
  if (i.freshness === 'WAITING_FOR_GPS') return none('unavailable', 'Waiting for GPS');
  if (i.freshness === 'STALE') return none('stale', 'Location is out of date');
  if (i.stationarySinceMs !== null && i.nowMs - i.stationarySinceMs >= policy.stationaryAfterMs) {
    return none('stationary', 'Bus has not moved for a while');
  }

  const baseline = policy.baselineKmh / 3.6;
  let mps = baseline;
  let basis: EtaEstimate['basis'] = 'baseline';
  if (i.historicalMps && i.historicalMps > 0) {
    mps = i.historicalMps;
    basis = 'historical';
  } else if (i.speedMps !== null && i.speedMps >= policy.liveSpeedMinMps) {
    const live = Math.min(policy.liveSpeedMaxMps, i.speedMps);
    mps = policy.liveSpeedWeight * live + (1 - policy.liveSpeedWeight) * baseline;
    basis = 'live_speed_blend';
  }
  return {
    status: 'ok',
    destination_seconds: Math.round(i.remainingToDestinationM / mps),
    next_stop_seconds: i.remainingToNextStopM === null ? null : Math.round(i.remainingToNextStopM / mps),
    basis,
    computed_at: i.nowMs,
    reason: null,
  };
}

/** Seconds remaining now, counting down from when the server computed the estimate. */
export function etaSecondsNow(seconds: number | null, computedAt: number, serverNowMs: number): number | null {
  if (seconds === null) return null;
  return Math.max(0, seconds - (serverNowMs - computedAt) / 1000);
}

export function formatEtaMinutes(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return '< 1 min';
  return `~${Math.round(seconds / 60)} min`;
}

/** Seat counts older than this are not shown — people board and leave at every stop. */
export const SEATS_MAX_AGE_MS = 15_000;

/** Free seats to display now, or null when the reading is missing, untrusted or out of date. */
export function displaySeats(e: BusSeatsEvent | undefined, serverNowMs: number): { free: number; capacity: number | null; source: SeatSource } | null {
  if (!e || e.seats_free === null || e.source === 'unavailable') return null;
  if (serverNowMs - e.received_at > SEATS_MAX_AGE_MS) return null;
  return { free: e.seats_free, capacity: e.capacity, source: e.source };
}

/** People on board to display now, or null when missing, untrusted or out of date. Independent of seats:
 *  a camera with no seat map still counts people. */
export function displayPeople(e: BusSeatsEvent | undefined, serverNowMs: number): { count: number; source: Exclude<PeopleSource, 'unavailable'> } | null {
  if (!e || e.people_on_board == null || !e.people_source || e.people_source === 'unavailable') return null;
  if (serverNowMs - e.received_at > SEATS_MAX_AGE_MS) return null;
  return { count: e.people_on_board, source: e.people_source };
}

export const PEOPLE_SOURCE_TEXT: Record<Exclude<PeopleSource, 'unavailable'>, string> = {
  ir: 'door passenger counter',
  camera: 'bus camera, people in view',
};

export const SEAT_SOURCE_TEXT: Record<Exclude<SeatSource, 'unavailable'>, string> = {
  camera: 'counted by the bus camera',
  ir: 'from the door passenger counter',
};

export const ETA_BASIS_TEXT: Record<NonNullable<EtaEstimate['basis']>, string> = {
  historical: 'Estimate from remaining route distance and past trips on this route',
  live_speed_blend: 'Estimate from remaining route distance, current speed and a typical bus speed',
  baseline: 'Estimate from remaining route distance and a typical bus speed (no trip history yet)',
};
