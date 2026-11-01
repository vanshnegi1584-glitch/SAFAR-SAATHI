import type { LngLat } from './types';

// Helpers for the Google Routes API (routes.googleapis.com/directions/v2:computeRoutes).
// Pure functions only — the HTTP call lives server-side so the API key never reaches the browser.

export const COMPUTE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/** Only request what we use: smaller response, and keeps the call on the cheapest SKU. */
export const COMPUTE_ROUTES_FIELD_MASK = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.legs.startLocation',
  'routes.legs.endLocation',
].join(',');

/** Above 10 intermediates Google bills the request at the higher "Pro" rate. */
export const MAX_INTERMEDIATES_ESSENTIALS = 10;

export interface RoadRoute {
  /** Road-following path, [lng, lat]. */
  polyline: LngLat[];
  /** Each input stop snapped onto the road, same order as the request. */
  stopLocations: LngLat[];
  distanceMeters: number;
  durationSeconds: number;
}

/** Decodes Google's Encoded Polyline Algorithm Format into [lng, lat] pairs. */
export function decodePolyline(encoded: string, precision = 5): LngLat[] {
  const factor = 10 ** precision;
  const out: LngLat[] = [];
  let index = 0, lat = 0, lng = 0;
  const next = () => {
    let result = 0, shift = 0, b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

const waypoint = ([lng, lat]: LngLat) => ({ location: { latLng: { latitude: lat, longitude: lng } } });

/** Request body for a bus route that visits `stops` in order (first = origin, last = destination). */
export function buildComputeRoutesRequest(stops: LngLat[]) {
  if (stops.length < 2) throw new Error('need at least an origin and a destination');
  return {
    origin: waypoint(stops[0]!),
    destination: waypoint(stops[stops.length - 1]!),
    intermediates: stops.slice(1, -1).map(waypoint),
    travelMode: 'DRIVE',
    polylineQuality: 'HIGH_QUALITY',
    languageCode: 'en-IN',
    units: 'METRIC',
  };
}

interface GLatLng { latLng?: { latitude: number; longitude: number } }
interface ComputeRoutesResponse {
  routes?: {
    distanceMeters?: number;
    duration?: string; // e.g. "1234s"
    polyline?: { encodedPolyline?: string };
    legs?: { startLocation?: GLatLng; endLocation?: GLatLng }[];
  }[];
}

const toLngLat = (p: GLatLng | undefined): LngLat | null =>
  p?.latLng ? [p.latLng.longitude, p.latLng.latitude] : null;

export function parseComputeRoutesResponse(body: ComputeRoutesResponse, stopCount: number): RoadRoute {
  const route = body.routes?.[0];
  const encoded = route?.polyline?.encodedPolyline;
  if (!route || !encoded) throw new Error('Routes API returned no route');
  const legs = route.legs ?? [];
  if (legs.length !== stopCount - 1) throw new Error(`expected ${stopCount - 1} legs, got ${legs.length}`);

  // Stop i is where leg i starts; the last stop is where the last leg ends.
  const stopLocations = [...legs.map((l) => toLngLat(l.startLocation)), toLngLat(legs[legs.length - 1]?.endLocation)];
  if (stopLocations.some((p) => p === null)) throw new Error('Routes API leg missing a location');

  return {
    polyline: decodePolyline(encoded),
    stopLocations: stopLocations as LngLat[],
    distanceMeters: route.distanceMeters ?? 0,
    durationSeconds: Number.parseInt(route.duration ?? '0', 10) || 0,
  };
}
