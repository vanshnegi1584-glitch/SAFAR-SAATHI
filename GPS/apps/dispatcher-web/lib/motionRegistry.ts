import { MarkerMotion } from '@transitlink/shared';

// Animation state lives outside React: it changes every frame and only the map canvas reads it.
const motions = new Map<string, MarkerMotion>();

export function motionFor(busId: string): MarkerMotion {
  let m = motions.get(busId);
  if (!m) {
    m = new MarkerMotion();
    motions.set(busId, m);
  }
  return m;
}

export function allMotions(): ReadonlyMap<string, MarkerMotion> {
  return motions;
}
