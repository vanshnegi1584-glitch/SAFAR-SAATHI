import { MarkerMotion } from '@transitlink/shared';

// Same interpolation engine as the dispatcher web; kept outside React state.
const motions = new Map<string, MarkerMotion>();

export function motionFor(busId: string): MarkerMotion {
  let m = motions.get(busId);
  if (!m) {
    m = new MarkerMotion();
    motions.set(busId, m);
  }
  return m;
}
