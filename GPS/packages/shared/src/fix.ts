import { haversine } from './geo';
import type { DriverLocationPayload, FixQuality, LocationFix, LocationSource } from './trackingTypes';

// Validation and plausibility checks for incoming GPS fixes. Shared so the driver app can pre-check
// what it sends, but the server always re-validates — the client is never trusted.

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const SOURCES: LocationSource[] = ['driver_device', 'vehicle_tracker'];
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 80 && /^[\w.:-]+$/.test(v);

/** Strict parse of a driver location payload. Unknown/negative speed and heading become null. */
export function parseDriverLocation(input: unknown): ParseResult<DriverLocationPayload & { measured_at: number }> {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'payload must be an object' };
  const p = input as Record<string, unknown>;
  if (!isId(p.busId)) return { ok: false, error: 'busId is required' };
  if (!isId(p.tripId)) return { ok: false, error: 'tripId is required' };
  if (!isNum(p.latitude) || p.latitude < -90 || p.latitude > 90) return { ok: false, error: 'latitude out of range' };
  if (!isNum(p.longitude) || p.longitude < -180 || p.longitude > 180) return { ok: false, error: 'longitude out of range' };
  if (Math.abs(p.latitude) < 1e-6 && Math.abs(p.longitude) < 1e-6) return { ok: false, error: '0,0 is not a valid fix' };
  if (p.accuracyMeters != null && (!isNum(p.accuracyMeters) || p.accuracyMeters <= 0 || p.accuracyMeters > 5000)) {
    return { ok: false, error: 'accuracyMeters must be between 0 and 5000' };
  }
  if (p.speedMetersPerSecond != null && !isNum(p.speedMetersPerSecond)) return { ok: false, error: 'speedMetersPerSecond must be a number' };
  if (p.headingDegrees != null && !isNum(p.headingDegrees)) return { ok: false, error: 'headingDegrees must be a number' };
  if (!Number.isSafeInteger(p.sequence) || (p.sequence as number) < 0) return { ok: false, error: 'sequence must be a non-negative integer' };
  if (!SOURCES.includes(p.source as LocationSource)) return { ok: false, error: `source must be one of ${SOURCES.join(', ')}` };
  if (typeof p.timestamp !== 'string') return { ok: false, error: 'timestamp must be an ISO-8601 string' };
  const measuredAt = Date.parse(p.timestamp);
  if (!Number.isFinite(measuredAt)) return { ok: false, error: 'timestamp is not a valid date' };

  const speed = p.speedMetersPerSecond as number | null | undefined;
  const heading = p.headingDegrees as number | null | undefined;
  return {
    ok: true,
    value: {
      busId: p.busId,
      tripId: p.tripId,
      latitude: p.latitude,
      longitude: p.longitude,
      accuracyMeters: (p.accuracyMeters as number | null | undefined) ?? null,
      // Android reports -1 when unknown.
      speedMetersPerSecond: speed != null && speed >= 0 && speed < 90 ? speed : null,
      headingDegrees: heading != null && heading >= 0 && heading <= 360 ? heading % 360 : null,
      timestamp: new Date(measuredAt).toISOString(),
      sequence: p.sequence as number,
      source: p.source as LocationSource,
      measured_at: measuredAt,
    },
  };
}

export interface FixPolicy {
  /** Device clock may be ahead of the server by at most this much. */
  maxFutureSkewMs: number;
  /** Older fixes are history only (offline backlog), never shown as the live position. */
  liveMaxAgeMs: number;
  /** Older fixes are rejected outright. */
  maxAgeMs: number;
  /** Implied speed between consecutive fixes above this is a jump, unless accuracy explains it. */
  maxSpeedMps: number;
  /** After this many consecutive mutually-consistent "jumps", accept — the previous fix was the bad one. */
  jumpResetCount: number;
  goodAccuracyM: number;
  fairAccuracyM: number;
  /** Fixes worse than this are displayed (honestly labelled) but not used for route progress or arrival. */
  maxMatchingAccuracyM: number;
}

export const DEFAULT_FIX_POLICY: FixPolicy = {
  maxFutureSkewMs: 30_000,
  liveMaxAgeMs: 60_000,
  maxAgeMs: 30 * 60_000,
  maxSpeedMps: 40, // 144 km/h — well above any campus bus
  jumpResetCount: 3,
  goodAccuracyM: 10,
  fairAccuracyM: 30,
  maxMatchingAccuracyM: 50,
};

export function fixQuality(accuracy: number | null, policy: FixPolicy = DEFAULT_FIX_POLICY): FixQuality {
  if (accuracy === null) return 'poor';
  if (accuracy <= policy.goodAccuracyM) return 'good';
  if (accuracy <= policy.fairAccuracyM) return 'fair';
  return 'poor';
}

export interface FixGateState {
  last: LocationFix | null;
  /** Consecutive fixes rejected as jumps, all close to each other. */
  pendingJumps: LocationFix[];
}

export type FixVerdict =
  | { accept: true; live: boolean; quality: FixQuality; usableForMatching: boolean; reset: boolean }
  | { accept: false; reason: 'timestamp_in_future' | 'too_old' | 'out_of_order' | 'implausible_jump' };

/**
 * Decides whether a fix is accepted, given the last accepted fix of the same trip. Pure: returns the
 * next gate state instead of mutating.
 */
export function assessFix(
  fix: LocationFix, state: FixGateState, serverNowMs: number, policy: FixPolicy = DEFAULT_FIX_POLICY,
): { verdict: FixVerdict; state: FixGateState } {
  const reject = (reason: Extract<FixVerdict, { accept: false }>['reason'], next = state) =>
    ({ verdict: { accept: false as const, reason }, state: next });

  if (fix.measured_at > serverNowMs + policy.maxFutureSkewMs) return reject('timestamp_in_future');
  if (fix.measured_at < serverNowMs - policy.maxAgeMs) return reject('too_old');
  const { last } = state;
  if (last && (fix.sequence <= last.sequence || fix.measured_at <= last.measured_at)) return reject('out_of_order');

  let reset = false;
  if (last) {
    const dist = haversine([last.longitude, last.latitude], [fix.longitude, fix.latitude]);
    const dt = (fix.measured_at - last.measured_at) / 1000;
    const slack = (last.accuracy_m ?? 50) + (fix.accuracy_m ?? 50);
    if (dist - slack > policy.maxSpeedMps * dt) {
      // Several jumps that agree with each other mean the *previous* accepted fix was the outlier.
      const pending = state.pendingJumps;
      const prevJump = pending[pending.length - 1];
      const consistent = !prevJump ||
        haversine([prevJump.longitude, prevJump.latitude], [fix.longitude, fix.latitude]) - slack <=
          policy.maxSpeedMps * Math.max(1, (fix.measured_at - prevJump.measured_at) / 1000);
      const nextPending = consistent ? [...pending, fix] : [fix];
      if (nextPending.length < policy.jumpResetCount) return reject('implausible_jump', { last, pendingJumps: nextPending });
      reset = true;
    }
  }

  const quality = fixQuality(fix.accuracy_m, policy);
  return {
    verdict: {
      accept: true,
      live: fix.measured_at >= serverNowMs - policy.liveMaxAgeMs,
      quality,
      usableForMatching: fix.accuracy_m !== null && fix.accuracy_m <= policy.maxMatchingAccuracyM,
      reset,
    },
    state: { last: fix, pendingJumps: [] },
  };
}
