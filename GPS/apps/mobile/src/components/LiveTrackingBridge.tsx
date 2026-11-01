import { useEffect } from 'react';
import { getTracking } from '@/lib/live';
import { motionFor } from '@/lib/motionRegistry';
import { notifyNow } from '@/lib/notify';
import { useTracking } from '@/store/tracking';

/** Live mode: tracking-server socket events → tracking store + marker interpolation. Mounted after login. */
export function LiveTrackingBridge() {
  useEffect(() => {
    const client = getTracking();
    const s = useTracking.getState;
    const refresh = () => client.snapshot().then((snap) => {
      s().setSnapshot(snap);
      const now = performance.now();
      for (const l of snap.latest) motionFor(l.bus_id).push({ location: l.location, timestamp: l.measured_at / 1000 }, now);
    }).catch(() => {});

    const offs = [
      client.on('connection:state', (c) => {
        s().setConnection(c);
        if (c === 'connected') void refresh(); // resync anything missed while disconnected
      }),
      client.on('bus:location', (e) => {
        s().applyLocation(e);
        motionFor(e.bus_id).push({ location: e.location, timestamp: e.measured_at / 1000 }, performance.now());
      }),
      client.on('trip:started', (t) => s().applyTrip(t)),
      client.on('trip:updated', (t) => s().applyTrip(t)),
      client.on('trip:ended', (t) => s().applyTrip(t)),
      client.on('bus:arrived', (a) => {
        s().setArrival(a);
        const myStop = s().me?.student_route?.stop_id;
        if (a.final || a.stop_id === myStop) {
          void notifyNow(a.final ? 'Bus has arrived' : 'Bus is at your stop', `Arrived at ${a.stop_name}`);
        }
      }),
      client.on('route:deviation', (d) => s().setDeviation(d)),
      client.on('bus:seats', (e) => s().applySeats(e)),
    ];
    client.connect();
    return () => {
      offs.forEach((off) => off());
      client.disconnect();
    };
  }, []);
  return null;
}
