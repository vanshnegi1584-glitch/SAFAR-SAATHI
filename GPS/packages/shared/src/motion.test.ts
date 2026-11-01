import { describe, expect, it } from 'vitest';
import { haversine } from './geo';
import { MarkerMotion } from './motion';
import type { LngLat } from './types';

const A: LngLat = [78.0, 30.3];
const B: LngLat = [78.001, 30.3]; // ~96 m east
const step = (i: number): LngLat => [78.0 + i * 0.0005, 30.3];

describe('MarkerMotion', () => {
  it('shows the first sample immediately', () => {
    const m = new MarkerMotion();
    m.push({ location: A, timestamp: 100 }, 0);
    expect(m.positionAt(0)).toEqual(A);
  });

  it('animates live samples over their interval instead of jumping', () => {
    const m = new MarkerMotion();
    m.push({ location: A, timestamp: 100 }, 0);
    m.push({ location: B, timestamp: 102 }, 0);
    const mid = m.positionAt(1000)!;
    expect(haversine(A, mid)).toBeCloseTo(haversine(A, B) / 2, 0);
    expect(m.positionAt(2000)).toEqual(B);
  });

  it('drops duplicate and out-of-order samples', () => {
    const m = new MarkerMotion();
    m.push({ location: A, timestamp: 100 }, 0);
    m.push({ location: B, timestamp: 102 }, 0);
    m.push({ location: [0, 0], timestamp: 101 }, 0);
    m.push({ location: [0, 0], timestamp: 102 }, 0);
    expect(m.positionAt(10_000)).toEqual(B);
  });

  it('replays a post-outage backlog through every point within the catch-up budget', () => {
    const m = new MarkerMotion({ catchUpMs: 3000 });
    m.push({ location: step(0), timestamp: 100 }, 0);
    // 20 queued samples (40 s of driving) arrive at once, unsorted
    const backlog = Array.from({ length: 20 }, (_, i) => ({ location: step(i + 1), timestamp: 102 + i * 2 }));
    m.push(backlog.reverse(), 0);
    expect(m.isCatchingUp()).toBe(true);

    let prev = m.positionAt(0)!;
    let maxHop = 0;
    for (let t = 16; t <= 3000; t += 16) {
      const p = m.positionAt(t)!;
      maxHop = Math.max(maxHop, haversine(prev, p));
      prev = p;
    }
    expect(m.positionAt(3001)).toEqual(step(20));
    // at 60 fps no single frame should move more than a fraction of one ~48 m hop
    expect(maxHop).toBeLessThan(30);
  });

  it('snaps when a single hop is implausibly long (bad GPS fix)', () => {
    const m = new MarkerMotion({ snapDistanceMeters: 1000 });
    m.push({ location: A, timestamp: 100 }, 0);
    m.push({ location: [78.5, 30.3], timestamp: 102 }, 0);
    expect(m.positionAt(1)).toEqual([78.5, 30.3]);
  });
});
