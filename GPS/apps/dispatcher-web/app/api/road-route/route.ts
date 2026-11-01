import {
  COMPUTE_ROUTES_FIELD_MASK, COMPUTE_ROUTES_URL, MAX_INTERMEDIATES_ESSENTIALS, buildComputeRoutesRequest,
  haversine, mockData, parseComputeRoutesResponse, type LngLat, type RoadRoute,
} from '@transitlink/shared';
import { NextResponse } from 'next/server';

// Server-side proxy to Google Routes API. Keeps GOOGLE_ROUTES_API_KEY off the client and stops
// anyone from using this endpoint to route arbitrary trips on our quota.

const MAX_STOPS = MAX_INTERMEDIATES_ESSENTIALS + 2;
const SERVICE_RADIUS_M = 60_000; // around campus
const cache = new Map<string, RoadRoute>(); // per server process; routes are fixed, so this saves quota

function isValidStops(v: unknown): v is LngLat[] {
  return (
    Array.isArray(v) && v.length >= 2 && v.length <= MAX_STOPS &&
    v.every((p) =>
      Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      haversine(p as LngLat, mockData.CAMPUS) <= SERVICE_RADIUS_M,
    )
  );
}

export async function POST(req: Request) {
  const key = process.env.GOOGLE_ROUTES_API_KEY;
  if (!key) return NextResponse.json({ error: 'GOOGLE_ROUTES_API_KEY is not set' }, { status: 503 });

  const body = (await req.json().catch(() => null)) as { stops?: unknown } | null;
  if (!isValidStops(body?.stops)) {
    return NextResponse.json({ error: `stops must be 2–${MAX_STOPS} [lng, lat] points near campus` }, { status: 400 });
  }
  const stops = body.stops;
  const cacheKey = JSON.stringify(stops);
  const hit = cache.get(cacheKey);
  if (hit) return NextResponse.json(hit);

  const res = await fetch(COMPUTE_ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': COMPUTE_ROUTES_FIELD_MASK,
    },
    body: JSON.stringify(buildComputeRoutesRequest(stops)),
    cache: 'no-store',
  });
  if (!res.ok) {
    // Google's error body explains key/API-enablement problems; log it, don't leak it to clients.
    console.error('Routes API error', res.status, await res.text());
    return NextResponse.json({ error: `Routes API returned ${res.status}` }, { status: 502 });
  }
  try {
    const route = parseComputeRoutesResponse(await res.json(), stops.length);
    cache.set(cacheKey, route);
    return NextResponse.json(route);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
