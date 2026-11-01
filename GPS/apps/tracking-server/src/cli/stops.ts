// Save and restore stop placements and route road paths through the admin API, so map work done in
// Route Setup survives a restart of the in-memory dev server and can be loaded into another server.
//
//   npm run stops -w @transitlink/tracking-server -- export [file]   (default ../../data/stop-locations.json)
//   npm run stops -w @transitlink/tracking-server -- import [file] [--dry-run]
//
// TRACKING_API_URL (default http://localhost:4000) and TRACKING_ADMIN_TOKEN (an admin's access token; for
// `npm run dev:local` the printed dev admin token) select the server. Coordinates only — no personal data.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LngLat, PublicRoute, PublicStop } from '@transitlink/shared';

interface SavedStop { id: string; name: string; location: LngLat | null; status: PublicStop['status']; geofence_radius_m: number }
interface SavedRoute { id: string; name: string; geometry: LngLat[] | null; geometry_status: PublicRoute['geometry_status'] }
interface SavedFile { format: 'transitlink-stop-locations/1'; exported_at: string; stops: SavedStop[]; routes: SavedRoute[] }

const [command, fileArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
const file = resolve(fileArg ?? '../../data/stop-locations.json');
const api = (process.env.TRACKING_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const token = process.env.TRACKING_ADMIN_TOKEN;
if (!['export', 'import'].includes(command ?? '') || !token) {
  console.error('Usage: stops export|import [file] [--dry-run]   (needs TRACKING_ADMIN_TOKEN; optional TRACKING_API_URL)');
  process.exit(1);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(api + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null) as T & { message?: string };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.message ?? ''}`);
  return data;
}

const stops = await call<PublicStop[]>('GET', '/api/admin/stops');
const routes = (await call<{ routes: PublicRoute[] }>('GET', '/api/tracking/snapshot')).routes;

if (command === 'export') {
  const out: SavedFile = {
    format: 'transitlink-stop-locations/1', exported_at: new Date().toISOString(),
    stops: stops.map(({ id, name, location, status, geofence_radius_m }) => ({ id, name, location, status, geofence_radius_m })),
    routes: routes.map(({ id, name, geometry, geometry_status }) => ({ id, name, geometry, geometry_status })),
  };
  writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  const n = (s: string) => out.stops.filter((x) => x.status === s).length;
  console.log(`Saved ${out.stops.length} stops (${n('verified')} verified, ${n('candidate')} candidate) and `
    + `${out.routes.filter((r) => r.geometry).length} route paths to ${file}`);
} else {
  const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedFile;
  if (saved.format !== 'transitlink-stop-locations/1') throw new Error(`${file} is not a stop-locations file`);
  const known = new Map(stops.map((s) => [s.id, s]));
  const knownRoutes = new Map(routes.map((r) => [r.id, r]));
  let changed = 0, same = 0, unknown = 0;
  for (const s of saved.stops) {
    const now = known.get(s.id);
    if (!now) { unknown++; console.warn(`skip stop ${s.id} (${s.name}): not on this server (schedule changed?)`); continue; }
    if (now.status === s.status && now.geofence_radius_m === s.geofence_radius_m
      && JSON.stringify(now.location) === JSON.stringify(s.location)) { same++; continue; }
    changed++;
    if (!dryRun) {
      await call('PUT', `/api/admin/stops/${encodeURIComponent(s.id)}`, {
        location: s.status === 'unverified' ? null : s.location, status: s.status,
        source: `restored from ${file.split(/[\\/]/).pop()}`, geofence_radius_m: s.geofence_radius_m,
      });
    }
  }
  let paths = 0;
  for (const r of saved.routes) {
    const now = knownRoutes.get(r.id);
    if (!now || !r.geometry || (now.geometry_status === r.geometry_status && JSON.stringify(now.geometry) === JSON.stringify(r.geometry))) continue;
    paths++;
    if (!dryRun) await call('PUT', `/api/admin/routes/${encodeURIComponent(r.id)}/geometry`, { geometry: r.geometry, status: r.geometry_status, source: 'restored' });
  }
  console.log(`${dryRun ? 'Would restore' : 'Restored'} ${changed} stops (${same} already identical, ${unknown} unknown here) and ${paths} route paths from ${file}`);
}
