// Pure maths for the Live buses page: where a bus is on its route, which way it is going, what is next,
// whether it is full and which bus takes over, and "missed your bus?" options. No React, no network.
//
// Paths follow the approved road path from the GPS project where there is one (public/route-paths.json), else
// straight lines between stops, so distances and times are approximate and the page says so. Stops come from GET /routes (stop_points in pickup order, campus last).
import { CAMPUS } from './geo.js'

const R = 6371000
const rad = (d) => (d * Math.PI) / 180
export const TZ = 'Asia/Kolkata'

/** Metres between two [lat, lng] points. */
export function distanceM(a, b) {
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Compass bearing in degrees (0 = north) from a to b. */
export function bearingDeg(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]))
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]))
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** A polyline ([lat, lng] points) with metres along it at each point. */
function measured(points) {
  let along = 0
  return points.map((at, i) => { if (i) along += distanceM(points[i - 1], at); return { at, along } })
}

/** A point projected onto a measured line: metres along it, metres off it, and the closest point on it.
 *  With `nearAlong`, where the road passes the same spot more than once (a loop round a stop, out and back on one
 *  road) the pass nearest that distance along is taken, so a moving bus is not thrown to the other pass. */
function projectOnto(line, p, nearAlong = null) {
  const k = Math.cos(rad(p[0])) * 111320, m = 110570
  const all = []
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i]
    const ax = (a.at[1] - p[1]) * k, ay = (a.at[0] - p[0]) * m, bx = (b.at[1] - p[1]) * k, by = (b.at[0] - p[0]) * m
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
    all.push({ along: a.along + t * (b.along - a.along), off: Math.hypot(ax + t * dx, ay + t * dy),
      at: [a.at[0] + t * (b.at[0] - a.at[0]), a.at[1] + t * (b.at[1] - a.at[1])] })
  }
  if (!all.length) return { along: 0, off: Infinity, at: line[0]?.at }
  const best = all.reduce((x, y) => (y.off < x.off ? y : x))
  if (nearAlong == null) return best
  return all.filter((c) => c.off <= best.off + 25)
    .reduce((x, y) => (Math.abs(y.along - nearAlong) < Math.abs(x.along - nearAlong) ? y : x))
}

/** A road line ([lat, lng] points) measured, for keeping buses on it; null if there is no line. */
export function roadTrack(points) {
  return points?.length >= 2 ? measured(points) : null
}

const ON_ROAD_M = 60 // GPS drift: a fix this close to the route's road is drawn on the road

/** Where a GPS fix sits on the road: the closest point on it (`at`), metres along and metres off. `onRoad` is false
 *  when it is further off than ON_ROAD_M (a detour, or a bus on another road): then draw the fix as it is. */
export function snapToRoad(track, p, nearAlong = null) {
  if (!track || !p) return null
  const q = projectOnto(track, p, nearAlong)
  return { ...q, onRoad: q.off <= ON_ROAD_M }
}

/** The point `d` metres along a measured road line. */
export function pointAlong(track, d) {
  const last = track.at(-1)
  if (d <= 0) return track[0].at
  if (d >= last.along) return last.at
  let lo = 0, hi = track.length - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (track[mid].along < d) lo = mid; else hi = mid }
  const a = track[lo], b = track[hi], t = (d - a.along) / (b.along - a.along || 1)
  return [a.at[0] + (b.at[0] - a.at[0]) * t, a.at[1] + (b.at[1] - a.at[1]) * t]
}

/** The positions a demo bus ("Simulate route" on the driver page) sends, one per step: along `line` ([lat, lng], the
 *  route's road as the map draws it, campus -> far end) every `stepM` metres, holding `hold` extra steps where each
 *  of `stops` ([lat, lng]) meets the road, out to the far end and back again, so looping it never jumps. */
export function demoDrive(line, stops, stepM, hold) {
  const track = roadTrack(line)
  if (!track) return []
  const length = track.at(-1).along
  const marks = [...new Set(stops.map((p) => projectOnto(track, p).along).filter((d) => d > 0 && d < length))]
    .sort((a, b) => a - b)
  const out = [track[0].at]
  let d = 0
  for (const m of [...marks, length]) {
    while (d < m) {
      d = Math.min(d + stepM, m)
      out.push(pointAlong(track, d))
    }
    for (let i = 0; i < hold; i++) out.push(out.at(-1))
  }
  return [...out, ...out.slice(1, out.length - 1 - hold).reverse()]   // back again (the far-end wait only once)
}

/** Route as a path for one direction: 'in' = first pickup -> campus, 'out' = campus -> first pickup.
 *  With `roadPath` (the approved road path from the GPS project, [lat, lng] first pickup -> campus) distances follow
 *  the road and each stop sits where it meets the road; without it, straight lines between stops.
 *  Returns the stops (`nodes`: name, position, metres along), the `line` measured along, and its `length`. */
export function routePath(route, direction, roadPath = null) {
  const stops = (route?.stop_points ?? []).map((s) => ({ name: s.name, at: [s.lat, s.lng] }))
  const campus = { name: 'Campus', at: CAMPUS, campus: true }
  const nodes = direction === 'in' ? [...stops, campus] : [campus, ...[...stops].reverse()]
  if (roadPath?.length >= 2) {
    const line = measured(direction === 'in' ? roadPath : [...roadPath].reverse())
    const length = line.at(-1).along
    nodes.forEach((n) => { n.along = n.campus ? (direction === 'in' ? length : 0) : projectOnto(line, n.at).along })
    return { nodes, line, length, road: true }
  }
  let along = 0
  nodes.forEach((n, i) => { if (i) along += distanceM(nodes[i - 1].at, n.at); n.along = along })
  return { nodes, line: nodes.map((n) => ({ at: n.at, along: n.along })), length: along, road: false }
}

/** A point projected onto a route path: metres along it, metres off it, and the closest point on the route. */
export function project(path, p) {
  return projectOnto(path.line, p)
}

/** Which way a bus is going, from two positions: moving along its route towards campus = 'in' (arrival).
 *  With the route's inbound path (`inPath`, from routePath(route, 'in', road)) and both positions on it, progress
 *  along that path decides, so a road that loops back near a stop (ISBT) doesn't flip it; otherwise getting closer
 *  to campus as the crow flies. Without enough movement, the time of day decides (mornings bring students in). */
export function directionOf(prev, cur, hourIst, inPath = null) {
  if (prev && cur && distanceM(prev, cur) > 20) {
    const a = inPath && project(inPath, prev), b = inPath && project(inPath, cur)
    if (a && b && a.off < 300 && b.off < 300 && Math.abs(b.along - a.along) > 10) return b.along > a.along ? 'in' : 'out'
    return distanceM(cur, CAMPUS) < distanceM(prev, CAMPUS) ? 'in' : 'out'
  }
  return hourIst < 12 ? 'in' : 'out'
}

const MIN_SPEED_KMH = 5
export const TYPICAL_KMH = 20 // when a bus is stopped or has no speed yet

/** Where the bus is on its route: the stop it last passed, the next stop, distance and time to the end of the route
 *  (along the approved road path when there is one), and how far it is off the route. */
export function progress(route, direction, location, speedKmh, roadPath = null) {
  if (!route || !location) return null
  const path = routePath(route, direction, roadPath)
  if (path.nodes.length < 2) return null
  const { along, off } = project(path, [location.lat, location.lng])
  const next = path.nodes.find((n) => n.along > along + 30) ?? path.nodes.at(-1)
  const previous = [...path.nodes].reverse().find((n) => n.along <= along + 30) ?? null
  const leftM = Math.max(0, path.length - along)
  const kmh = speedKmh >= MIN_SPEED_KMH ? speedKmh : TYPICAL_KMH
  return { along, off, next: next.name, previous: previous?.name ?? null, destination: path.nodes.at(-1).name,
    leftKm: leftM / 1000, etaMin: (leftM / 1000 / kmh) * 60, path, kmh }
}

/** "Near ISBT (120 m)": the closest named place (any stop on these routes, or campus) to a point. */
export function nearestPlace(routes, at) {
  let best = { name: 'Campus', d: distanceM(at, CAMPUS) }
  for (const r of routes) for (const s of r.stop_points ?? []) {
    const d = distanceM(at, [s.lat, s.lng])
    if (d < best.d) best = { name: s.name, d }
  }
  return best
}

/** LIVE / DELAYED / STALE from the age of the last position (the backend calls >60 s "last seen"). */
export function freshness(bus, now = Date.now()) {
  if (!bus?.location_at) return 'NO_GPS'
  const s = (now - new Date(bus.location_at).getTime()) / 1000
  return s <= 30 ? 'LIVE' : s <= 60 ? 'DELAYED' : 'STALE'
}

export const isFull = (bus) => bus?.status === 'full' || (bus?.seats_free === 0 && bus?.capacity > 0)

/** Minutes after midnight, IST, for "16:00"-style times and for now. */
export const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m }
export function nowMinutesIst(now = Date.now()) {
  const [h, m] = new Date(now).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number)
  return h * 60 + m
}
export const departureOf = (bus) => bus?.slot ?? bus?.usual_departure ?? null

/** For a full bus: the bus that takes over its route. Another bus of the route boarding at campus now,
 *  else the next later departure of that route, else none. */
export function nextBusAfterFull(full, buses, nowMin) {
  const same = buses.filter((b) => b.id !== full.id && b.route_id === full.route_id && !isFull(b))
  const boarding = same.find((b) => b.status === 'boarding' || b.trip?.in_depot)
  if (boarding) return { bus: boarding, kind: 'boarding' }
  const later = same.filter((b) => departureOf(b) && minutesOf(departureOf(b)) >= nowMin)
    .sort((a, b) => minutesOf(departureOf(a)) - minutesOf(departureOf(b)))[0]
  return later ? { bus: later, kind: 'later', at: departureOf(later) } : null
}

const WALK_MPS = 1.2, WALK_DETOUR = 1.3, MARGIN_MIN = 1, DROP_RADIUS_M = 2000

/** "Missed your bus?": every bus that still gets the student to `dest` ({name, at}) or a stop within 2 km of it.
 *  live: buses on the road with `direction` and a position; scheduled: later departures from campus.
 *  Returns options (catchable first, soonest arrival first) with the stop to board, the walk and the times. */
export function alternatives({ dest, me, buses, routesById, directions, nowMin, paths = {} }) {
  const out = []
  const walkMin = (at) => (distanceM(me, at) * WALK_DETOUR) / WALK_MPS / 60
  const consider = (bus, direction, startAlong, startMin, kmh, kind) => {
    const path = routePath(routesById[bus.route_id], direction, paths[bus.route_id])
    const drops = path.nodes.map((n) => ({ n, d: distanceM(n.at, dest.at) })).filter((x) => x.d <= DROP_RADIUS_M && x.n.along > startAlong)
    const drop = drops.sort((a, b) => a.d - b.d)[0]
    if (!drop) return
    const at = (along) => startMin + ((along - startAlong) / 1000 / kmh) * 60
    const boards = path.nodes.filter((n) => n.along >= startAlong && n.along < drop.n.along)
      .map((n) => ({ n, walk: walkMin(n.at), busAt: at(n.along) }))
      .map((x) => ({ ...x, slack: x.busAt - nowMin - x.walk - MARGIN_MIN }))
    const ok = boards.filter((x) => x.slack >= 0).sort((a, b) => a.walk - b.walk)[0]
    const board = ok ?? boards.sort((a, b) => b.slack - a.slack)[0]
    if (!board) return
    out.push({ bus, kind, direction, board: board.n.name, boardAt: board.n.at, walkMin: board.walk,
      walkM: distanceM(me, board.n.at) * WALK_DETOUR, busAtMin: board.busAt, slackMin: board.slack, catchable: !!ok,
      drop: drop.n.name, dropFromDestM: drop.d, arriveMin: at(drop.n.along) })
  }
  for (const bus of buses) {
    const route = routesById[bus.route_id]
    if (!route) continue
    const direction = directions[bus.id]
    if (bus.location && direction && freshness(bus) !== 'STALE' && !isFull(bus)) {
      const p = progress(route, direction, bus.location, bus.speed_kmh, paths[bus.route_id])
      if (p) consider(bus, direction, p.along, nowMin, p.kmh, 'live')
    }
    const dep = departureOf(bus)
    if (dep && minutesOf(dep) > nowMin && !(bus.location && direction === 'out' && freshness(bus) === 'LIVE')) {
      consider(bus, 'out', 0, minutesOf(dep), TYPICAL_KMH, 'scheduled')
    }
  }
  return out.sort((a, b) => Number(b.catchable) - Number(a.catchable) || a.arriveMin - b.arriveMin)
}

/** "4:05 PM" from minutes after midnight (IST). */
export function clock(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440, h = Math.floor(m / 60)
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}
export const duration = (min) => (Math.abs(min) < 1 ? '< 1 min' : Math.abs(min) < 60 ? `${Math.round(Math.abs(min))} min`
  : `${Math.floor(Math.abs(min) / 60)} h ${Math.round(Math.abs(min) % 60)} min`)
export const km = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`)
