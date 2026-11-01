import type { LngLat } from './types';

const EARTH_RADIUS_M = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Linear interpolation between two points. Fine for the short (< 1 km) hops between telemetry samples. */
export function lerpLngLat(a: LngLat, b: LngLat, t: number): LngLat {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}

/** Initial bearing a → b in degrees (0 = north, clockwise). */
export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function polylineLength(line: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += haversine(line[i - 1]!, line[i]!);
  return total;
}

/**
 * Snap a point to the polyline and return how far along the line it is (metres from the start).
 * Uses an equirectangular projection per segment — accurate enough at city scale.
 */
export function distanceAlongLine(line: LngLat[], p: LngLat): number {
  if (line.length < 2) return 0;
  const kx = Math.cos(toRad(p[1])); // shrink longitude by latitude
  let best = { d2: Infinity, along: 0 };
  let acc = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const ax = a[0] * kx, ay = a[1], bx = b[0] * kx, by = b[1], px = p[0] * kx, py = p[1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const cx = ax + t * dx, cy = ay + t * dy;
    const d2 = (px - cx) ** 2 + (py - cy) ** 2;
    const segLen = haversine(a, b);
    if (d2 < best.d2) best = { d2, along: acc + t * segLen };
    acc += segLen;
  }
  return best.along;
}

/** Point at a given distance (metres) along the polyline; clamps to the ends. */
export function pointAlongLine(line: LngLat[], meters: number): LngLat {
  if (line.length === 0) throw new Error('empty polyline');
  if (meters <= 0) return line[0]!;
  let acc = 0;
  for (let i = 1; i < line.length; i++) {
    const seg = haversine(line[i - 1]!, line[i]!);
    if (acc + seg >= meters) return lerpLngLat(line[i - 1]!, line[i]!, (meters - acc) / seg);
    acc += seg;
  }
  return line[line.length - 1]!;
}
