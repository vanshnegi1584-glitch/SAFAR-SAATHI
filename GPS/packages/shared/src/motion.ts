import { bearing, haversine, lerpLngLat } from './geo';
import type { LngLat } from './types';

export interface MotionSample {
  location: LngLat;
  timestamp: number; // unix seconds (device time)
}

export interface MotionOptions {
  /** Segment duration bounds for live (non-backlog) samples. */
  minSegmentMs?: number;
  maxSegmentMs?: number;
  /** When a backlog of queued samples arrives (Blueprint §6), replay it within this budget. */
  catchUpMs?: number;
  /** A single hop longer than this is treated as a bad fix / reassignment and snapped, not animated. */
  snapDistanceMeters?: number;
}

interface Segment {
  from: LngLat;
  to: LngLat;
  startMs: number;
  durMs: number;
}

/**
 * Smooths one bus marker between telemetry samples.
 *
 * Live samples (every ~2 s) are animated over their own interval, so the marker trails reality by one
 * sample but never jumps. After a GSM outage the ESP32 bulk-publishes its queue; those samples are
 * replayed as a fast path animation instead of teleporting the marker to the newest point.
 * Out-of-order and duplicate samples (by device timestamp) are dropped.
 */
export class MarkerMotion {
  private readonly opts: Required<MotionOptions>;
  private queue: MotionSample[] = [];
  private seg: Segment | null = null;
  private displayed: LngLat | null = null;
  private lastAcceptedTs = -Infinity;
  private lastSegmentTs = -Infinity;
  private heading = 0;
  private backlogSegmentMs: number | null = null;

  constructor(opts: MotionOptions = {}) {
    this.opts = {
      minSegmentMs: 300,
      maxSegmentMs: 4000,
      catchUpMs: 3000,
      snapDistanceMeters: 3000,
      ...opts,
    };
  }

  push(samples: MotionSample | MotionSample[], nowMs: number): void {
    const list = (Array.isArray(samples) ? samples : [samples])
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp);
    for (const s of list) {
      if (s.timestamp <= this.lastAcceptedTs) continue;
      this.lastAcceptedTs = s.timestamp;
      if (this.displayed === null) {
        this.displayed = s.location;
        this.lastSegmentTs = s.timestamp;
        continue;
      }
      this.queue.push(s);
    }
    // Fix the per-hop duration once per backlog so the whole replay fits in catchUpMs.
    if (this.queue.length > 1) this.backlogSegmentMs = this.opts.catchUpMs / this.queue.length;
    if (!this.seg) this.startNext(nowMs);
  }

  /** Current interpolated position, or null before the first sample. */
  positionAt(nowMs: number): LngLat | null {
    while (this.seg) {
      const elapsed = nowMs - this.seg.startMs;
      if (elapsed < this.seg.durMs) {
        return lerpLngLat(this.seg.from, this.seg.to, elapsed / this.seg.durMs);
      }
      this.displayed = this.seg.to;
      const endMs = this.seg.startMs + this.seg.durMs;
      this.seg = null;
      this.startNext(endMs);
    }
    return this.displayed;
  }

  /** Bearing of the current/last movement in degrees. */
  getHeading(): number {
    return this.heading;
  }

  /** True while replaying a post-outage backlog. */
  isCatchingUp(): boolean {
    return this.queue.length > 0;
  }

  private startNext(startMs: number): void {
    const next = this.queue.shift();
    if (!next || !this.displayed) return;
    const from = this.displayed;
    const dist = haversine(from, next.location);
    const dtMs = (next.timestamp - this.lastSegmentTs) * 1000;
    this.lastSegmentTs = next.timestamp;

    if (dist > this.opts.snapDistanceMeters) {
      this.displayed = next.location;
      this.startNext(startMs);
      return;
    }
    if (dist > 1) this.heading = bearing(from, next.location);

    const { minSegmentMs, maxSegmentMs } = this.opts;
    let durMs = Math.min(maxSegmentMs, Math.max(minSegmentMs, dtMs));
    if (this.backlogSegmentMs !== null) {
      durMs = Math.min(durMs, this.backlogSegmentMs);
      if (this.queue.length === 0) this.backlogSegmentMs = null;
    }
    this.seg = { from, to: next.location, startMs, durMs };
  }
}
