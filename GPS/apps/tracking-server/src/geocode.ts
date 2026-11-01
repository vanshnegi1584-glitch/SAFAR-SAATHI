import type { LngLat } from '@transitlink/shared';
import type { ServerConfig } from './config';

// Admin-only helpers that *propose* coordinates and road geometry. Nothing returned here is saved
// until an admin reviews it on the map and marks it verified.

export interface GeocodeCandidate {
  display_name: string;
  location: LngLat;
  source: string;
  type: string;
}

/** Rough bounding box of Dehradun district (lng/lat), to keep same-named places elsewhere out. */
const DEHRADUN_VIEWBOX = '77.70,30.60,78.30,30.05';

// Nominatim's usage policy: at most one request per second, identified by User-Agent.
let lastNominatimCall = 0;
async function politeDelay() {
  const wait = lastNominatimCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimCall = Date.now();
}

export async function geocodeStop(name: string, cfg: ServerConfig): Promise<GeocodeCandidate[]> {
  await politeDelay();
  const url = new URL('/search', cfg.nominatimUrl);
  url.search = new URLSearchParams({
    q: `${name}, Dehradun, Uttarakhand`, format: 'jsonv2', limit: '5', countrycodes: 'in',
    viewbox: DEHRADUN_VIEWBOX, bounded: '1',
  }).toString();
  const res = await fetch(url, { headers: { 'User-Agent': cfg.geoUserAgent, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
  const list = (await res.json()) as { display_name: string; lat: string; lon: string; osm_type: string; osm_id: number; type: string }[];
  return list.map((r) => ({
    display_name: r.display_name,
    location: [Number(r.lon), Number(r.lat)],
    source: `nominatim:${r.osm_type}/${r.osm_id}`,
    type: r.type,
  }));
}

/**
 * Road-following path through the stops (in order) from an OSRM server. The public demo server is for
 * light admin use only; set OSRM_URL to a self-hosted instance for anything heavier.
 */
export async function routeThroughStops(stops: LngLat[], cfg: ServerConfig): Promise<{ geometry: LngLat[]; distance_m: number }> {
  if (stops.length < 2) throw new Error('Need at least two stops');
  const coords = stops.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';');
  const url = `${cfg.osrmUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=true`;
  const res = await fetch(url, { headers: { 'User-Agent': cfg.geoUserAgent } });
  if (!res.ok) throw new Error(`OSRM returned ${res.status}`);
  const body = (await res.json()) as { code: string; routes?: { geometry: { coordinates: LngLat[] }; distance: number }[] };
  const route = body.routes?.[0];
  if (body.code !== 'Ok' || !route) throw new Error(`OSRM could not route: ${body.code}`);
  return { geometry: route.geometry.coordinates, distance_m: route.distance };
}
