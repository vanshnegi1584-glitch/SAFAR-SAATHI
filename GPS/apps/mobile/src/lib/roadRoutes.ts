import { useQueries, useQueryClient } from '@tanstack/react-query';
import { MockTransitSource, type FleetSnapshot, type LngLat, type RoadRoute } from '@transitlink/shared';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { getDataSource } from './dataSource';
import { keys, useSnapshot } from './queries';

const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL;

/**
 * Google road geometry is only allowed on a Google map. react-native-maps renders Google Maps on
 * Android; iOS defaults to Apple Maps, so iOS keeps the plain route lines.
 */
export const roadRoutesEnabled = Platform.OS === 'android' && Boolean(WEB_URL);

/** Same as the web hook: fetches road paths via the dispatcher-web proxy (which holds the Routes key). */
export function useRoadRoutes(): void {
  const qc = useQueryClient();
  const { data } = useSnapshot();
  const applied = useRef(new Set<string>());
  const plans = useRef<{ routeId: string; stopIds: string[]; stops: LngLat[] }[] | null>(null);
  if (data && !plans.current) {
    plans.current = data.routes.map((r) => {
      const stops = data.stops.filter((s) => s.route_id === r.id);
      return { routeId: r.id, stopIds: stops.map((s) => s.id), stops: stops.map((s) => s.location) };
    });
  }

  const results = useQueries({
    queries: (roadRoutesEnabled ? plans.current ?? [] : []).map((p) => ({
      queryKey: ['road-route', p.routeId],
      queryFn: async (): Promise<RoadRoute> => {
        const res = await fetch(`${WEB_URL}/api/road-route`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stops: p.stops }),
        });
        if (!res.ok) throw new Error(`road-route ${res.status}`);
        return res.json();
      },
      staleTime: Infinity,
      gcTime: Infinity,
      retry: 1,
    })),
  });

  useEffect(() => {
    results.forEach((res, i) => {
      const plan = plans.current?.[i];
      if (!plan || !res.data || applied.current.has(plan.routeId)) return;
      applied.current.add(plan.routeId);
      const road = res.data;
      const snapped = Object.fromEntries(plan.stopIds.map((id, k) => [id, road.stopLocations[k]!]));
      qc.setQueryData<FleetSnapshot>(keys.snapshot, (s) =>
        s && {
          ...s,
          routes: s.routes.map((r) => (r.id === plan.routeId ? { ...r, polyline: road.polyline } : r)),
          stops: s.stops.map((st) => (snapped[st.id] ? { ...st, location: snapped[st.id]! } : st)),
        },
      );
      const src = getDataSource();
      if (src instanceof MockTransitSource) src.setRouteGeometry(plan.routeId, road.polyline, snapped);
    });
  }, [results, qc]);
}
