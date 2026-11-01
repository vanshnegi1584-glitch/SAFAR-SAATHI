import { describe, expect, it } from 'vitest';
import { directionAlong, estimateEta, formatEta } from './eta';
import { distanceAlongLine, haversine, pointAlongLine, polylineLength } from './geo';
import { MockTransitSource } from './mock/mockSource';
import { effectivePosition, nextToCall, occupancyLevel } from './queue';
import { normalizeMqtt } from './telemetry';
import type { DigitalToken, LngLat } from './types';

const line: LngLat[] = [[78.0, 30.3], [78.01, 30.3], [78.01, 30.31]];

describe('geo', () => {
  it('haversine matches a known distance (~1 deg lat ≈ 111 km)', () => {
    expect(haversine([78, 30], [78, 31]) / 1000).toBeCloseTo(111.2, 0);
  });

  it('pointAlongLine and distanceAlongLine are inverses', () => {
    const len = polylineLength(line);
    for (const f of [0, 0.25, 0.5, 0.9, 1]) {
      expect(distanceAlongLine(line, pointAlongLine(line, len * f))).toBeCloseTo(len * f, -1);
    }
  });
});

describe('eta', () => {
  const stop = line[2]!;
  it('uses current speed when moving', () => {
    const r = estimateEta(line, line[0]!, stop, 36);
    expect(r.seconds).toBeCloseTo(polylineLength(line) / 10, -1);
  });
  it('falls back to an average speed when stopped', () => {
    expect(estimateEta(line, line[0]!, stop, 0).seconds).toBeGreaterThan(0);
  });
  it('handles buses running against polyline order', () => {
    const r = estimateEta(line, stop, line[0]!, 36, { direction: -1 });
    expect(r.passed).toBe(false);
    expect(r.seconds).toBeCloseTo(polylineLength(line) / 10, -1);
    expect(directionAlong(line, stop, line[1]!)).toBe(-1);
  });
  it('reports a passed stop', () => {
    const r = estimateEta(line, stop, line[0]!, 30);
    expect(r.passed).toBe(true);
    expect(formatEta(r.seconds)).toBe('Departed');
  });
});

const tok = (id: string, pos: number, status: DigitalToken['status']): DigitalToken => ({
  id, student_id: id, trip_id: 't', queue_position: pos, status, created_at: '',
});

describe('queue', () => {
  const list = [tok('a', 1, 'boarded'), tok('b', 2, 'called'), tok('c', 3, 'waiting'), tok('d', 4, 'waiting'), tok('e', 5, 'waiting')];
  it('only calls as many as there are seats not already promised', () => {
    expect(nextToCall(list, 3).map((t) => t.id)).toEqual(['c', 'd']);
    expect(nextToCall(list, 1)).toEqual([]);
  });
  it('computes position among waiting tokens only', () => {
    expect(effectivePosition(list[4]!, list)).toBe(3);
    expect(effectivePosition(list[1]!, list)).toBeNull();
  });
  it('classifies occupancy', () => {
    expect(occupancyLevel(10, 52)).toBe('low');
    expect(occupancyLevel(45, 52)).toBe('high');
    expect(occupancyLevel(52, 52)).toBe('full');
  });
});

describe('telemetry', () => {
  it('maps the §3.2 MQTT payload to [lng, lat]', () => {
    const u = normalizeMqtt({
      bus_id: 'B-402', timestamp: 1698754321,
      gps: { lat: 30.3165, lon: 78.0322, speed: 42.5, sats: 8 },
      pax: { in_count: 45, out_count: 12, net_current: 33 }, sos_active: false,
    }, 't-402');
    expect(u.location).toEqual([78.0322, 30.3165]);
    expect(u.current_pax_count).toBe(33);
  });
});

describe('MockTransitSource', () => {
  it('joinQueue is idempotent for the same student and trip', async () => {
    const src = new MockTransitSource();
    const a = await src.joinQueue('me', 't-401');
    const b = await src.joinQueue('me', 't-401');
    expect(a.id).toBe(b.id);
  });
});
