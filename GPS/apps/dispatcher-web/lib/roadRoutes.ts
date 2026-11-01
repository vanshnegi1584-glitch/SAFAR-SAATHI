'use client';

import { useQueries, useQueryClient } from '@tanstack/react-query';
import { MockTransitSource, type FleetSnapshot, type LngLat, type RoadRoute } from '@transitlink/shared';
import { useEffect, useRef } from 'react';
import { getDataSource } from './dataSource';
import { keys, useSnapshot } from './queries';

async function fetchRoadRoute(stops: LngLat[]): Promise<RoadRoute> {
  const res = await fetch('/api/road-route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stops }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return res.json();
}

/**
 * Replaces each route's straight-line polyline with Google's road-following path (one request per
 * route per session) and snaps stops onto the road. Only used with the Google map — Google's terms
 * don't allow showing Routes API data on a non-Google map.
 */
export function useGoogleRoadRoutes() {
  const qc = useQueryClient();
  const { data } = useSnapshot();
  const applied = useRef(new Set<string>());

  // Capture each route's original stop order once; the snapshot changes after we apply geometry.
  const plans = useRef<{ routeId: string; stopIds: string[]; stops: LngLat[] }[] | null>(null);
  if (data && !plans.current) {
    plans.current = data.routes.map((r) => {
      const stops = data.stops.filter((s) => s.route_id === r.id);
      return { routeId: r.id, stopIds: stops.map((s) => s.id), stops: stops.map((s) => s.location) };
    });
  }

  const results = useQueries({
    queries: (plans.current ?? []).map((p) => ({
      queryKey: ['road-route', p.routeId],
      queryFn: () => fetchRoadRoute(p.stops),
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

  const failed = results.find((r) => r.error)?.error as Error | undefined;
  return {
    loading: results.some((r) => r.isLoading),
    snappedCount: results.filter((r) => r.data).length,
    total: results.length,
    error: failed?.message ?? null,
  };
}
