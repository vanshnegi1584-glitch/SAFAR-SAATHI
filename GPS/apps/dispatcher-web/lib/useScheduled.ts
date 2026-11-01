import {
  localDate, slotRuns, zonedTimeToUtc, type ScheduledDeparture, type SlotMappingStatus, type TrackingSnapshot, type TripDirection,
} from '@transitlink/shared';
import { useEffect, useMemo, useState } from 'react';
import { getTracking } from './live';

const TZ = 'Asia/Kolkata';

interface SlotsResponse {
  timezone: string;
  slots: { id: string; local_time: string; direction: TripDirection; label: string }[];
  mapping: { bus_id: string; slot_id: string; status: SlotMappingStatus }[];
}

/**
 * Today's timetabled departures (e.g. the 1, 4 and 6 PM buses from campus) from the slot confirmations.
 * Staff-only on the server; for anyone else it quietly lists buses on the road only.
 */
export function useScheduled(snap: TrackingSnapshot | null, now: number): ScheduledDeparture[] {
  const [slots, setSlots] = useState<SlotsResponse | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => getTracking().request<SlotsResponse>('/api/admin/slots').then((s) => alive && setSlots(s)).catch(() => {});
    void load();
    const t = setInterval(load, 60_000); // an admin may confirm or cancel a run meanwhile
    return () => { alive = false; clearInterval(t); };
  }, []);
  const day = localDate(new Date(now), slots?.timezone ?? TZ);
  return useMemo(() => {
    if (!slots || !snap) return [];
    return slots.mapping.filter((m) => slotRuns(m.status)).flatMap((m) => {
      const slot = slots.slots.find((s) => s.id === m.slot_id);
      const routeId = snap.buses.find((b) => b.id === m.bus_id)?.route_id;
      if (!slot || !routeId) return [];
      return [{ bus_id: m.bus_id, route_id: routeId, direction: slot.direction, slot_id: slot.id,
        departs_at: zonedTimeToUtc(day, slot.local_time, slots.timezone).getTime() }];
    });
  }, [slots, snap, day]);
}
