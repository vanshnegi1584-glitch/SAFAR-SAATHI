// "Which stop is mine?": the stops nearest to where you are (phone GPS) or to a place you type (an area or landmark,
// looked up on OpenStreetMap). Stop positions come from GET /routes (stop_points); GET /stops has names only.
import { distanceM } from './liveMath.js'

const WALK_M_PER_MIN = 80        // ~4.8 km/h
export const WALKABLE_M = 3000   // further than this, say so instead of pretending it's a walk
const NOMINATIM = 'https://nominatim.openstreetmap.org/search'

/** Stop name -> [lat, lng], from the routes' stop_points (a stop on several routes takes its first position). */
export function stopPositions(routes) {
  const at = {}
  for (const r of routes) for (const p of r.stop_points ?? []) at[p.name] ??= [p.lat, p.lng]
  return at
}

/** The `n` stops nearest to `from` ([lat, lng]), with distance and walking minutes. `stops` are GET /stops entries
 *  ({ name, routes, buses }); stops without a known position are skipped. */
export function nearestStops(stops, positions, from, n = 3) {
  return stops
    .filter((s) => positions[s.name])
    .map((s) => {
      const m = distanceM(from, positions[s.name])
      return { ...s, at: positions[s.name], distanceM: m, walkMin: Math.max(1, Math.round(m / WALK_M_PER_MIN)), walkable: m <= WALKABLE_M }
    })
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, n)
}

/** The area the stops cover, padded ~10 km, as Nominatim's viewbox (west,north,east,south), so a typed place is
 *  looked up near the bus network and not in another city with the same name. */
export function searchBox(positions, padDeg = 0.1) {
  const pts = Object.values(positions)
  if (!pts.length) return null
  const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1])
  return [Math.min(...lngs) - padDeg, Math.max(...lats) + padDeg, Math.max(...lngs) + padDeg, Math.min(...lats) - padDeg]
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Places matching `text` inside `box` (OpenStreetMap Nominatim). Only the typed text leaves the browser.
 *  Names are often written both ways ("Prem Nagar" / "Premnagar"), so when nothing is found a name with spaces is
 *  tried once more without them, after a pause: Nominatim's usage policy allows searches per user action (not
 *  as-you-type), at most about one a second. */
export async function findPlaces(text, box, fetchImpl = fetch, pauseMs = 1100) {
  const q = text.trim().replace(/\s+/g, ' ')
  if (q.length < 3) return []
  const once = async (query) => {
    const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', countrycodes: 'in', 'accept-language': 'en' })
    if (box) { params.set('viewbox', box.join(',')); params.set('bounded', '1') }
    const res = await fetchImpl(`${NOMINATIM}?${params}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Place search failed (${res.status}). Try again in a moment, or search your stop by name.`)
    return (await res.json()).map((r) => ({ name: r.display_name.split(',').slice(0, 3).join(',').trim(), at: [Number(r.lat), Number(r.lon)] }))
  }
  const found = await once(q)
  if (found.length || !q.includes(' ')) return found
  await wait(pauseMs)
  return once(q.replaceAll(' ', ''))
}
