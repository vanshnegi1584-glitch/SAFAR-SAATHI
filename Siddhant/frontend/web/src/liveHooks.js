// Live GPS hooks and helpers shared by the Live buses page and the passenger, staff and office pages.
import { useEffect, useMemo, useRef, useState } from 'react'
import { bearingDeg, directionOf, distanceM, freshness, isFull, nowMinutesIst, routePath } from './liveMath'

export function useClock(ms = 5000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

// Heading and direction (arrival / departure) per bus, from consecutive positions (> 20 m apart, so GPS
// jitter at a stop doesn't spin the pointer), judged along the route's road path. Before a bus has moved, the time
// of day decides direction.
function useMotion(buses, routesById, paths) {
  const seen = useRef({})
  const [motion, setMotion] = useState({ headings: {}, directions: {} })
  useEffect(() => {
    const hour = Math.floor(nowMinutesIst() / 60)
    let changed = false
    for (const b of Object.values(buses)) {
      if (!b.location) continue
      const cur = [b.location.lat, b.location.lng]
      const s = seen.current[b.id] ?? {}
      const inPath = routesById[b.route_id] ? routePath(routesById[b.route_id], 'in', paths[b.route_id]) : null
      if (!s.at) Object.assign(s, { at: cur, direction: directionOf(null, cur, hour) })
      else if (distanceM(s.at, cur) > 20) Object.assign(s, { heading: bearingDeg(s.at, cur), direction: directionOf(s.at, cur, hour, inPath), at: cur })
      else continue
      seen.current[b.id] = s
      changed = true
    }
    if (!changed) return
    const entries = Object.entries(seen.current)
    setMotion({
      headings: Object.fromEntries(entries.filter(([, s]) => s.heading != null).map(([id, s]) => [id, s.heading])),
      directions: Object.fromEntries(entries.map(([id, s]) => [id, s.direction])),
    })
  }, [buses, routesById, paths])
  return motion
}

/** Everything the live panels need from the live feed: routes by id, a ticking clock and each bus's heading/direction. */
export function useLiveTrips(buses, routes) {
  const routesById = useMemo(() => Object.fromEntries(routes.map((r) => [r.id, r])), [routes])
  const now = useClock()
  const paths = useRoutePaths()
  const { headings, directions } = useMotion(buses, routesById, paths)
  return { routesById, now, nowMin: nowMinutesIst(now), headings, directions, paths }
}

// The viewer's own location: asked for only on click, kept in this browser, never sent anywhere.
export function useMyLocation() {
  const [state, setState] = useState('off')
  const [me, setMe] = useState(null)
  const watch = useRef(null)
  const stop = () => {
    if (watch.current != null) navigator.geolocation.clearWatch(watch.current)
    watch.current = null
    setMe(null)
    setState('off')
  }
  const start = () => {
    if (!('geolocation' in navigator)) return setState('unsupported')
    setState('finding')
    watch.current = navigator.geolocation.watchPosition(
      (p) => { setMe({ at: [p.coords.latitude, p.coords.longitude], accuracy: p.coords.accuracy ?? 0 }); setState('on') },
      (err) => { if (err.code === err.PERMISSION_DENIED) { stop(); setState('denied') } },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    )
  }
  useEffect(() => () => { if (watch.current != null) navigator.geolocation.clearWatch(watch.current) }, [])
  return { state, me, start, stop }
}

/** Buses sharing a live (or slightly delayed) position, full ones first. */
export function trackedBuses(list, now) {
  return list.filter((b) => b.location && ['LIVE', 'DELAYED'].includes(freshness(b, now)))
    .sort((a, b) => Number(isFull(b)) - Number(isFull(a)) || a.id - b.id)
}


let pathsLoad = null

/** Approved road paths by route id, from public/route-paths.json (tools/import_route_paths.py). {} until loaded or
 *  when there are none; loaded once per page and shared by every map and panel. */
export function useRoutePaths() {
  const [paths, setPaths] = useState({})
  useEffect(() => {
    pathsLoad ??= fetch('/route-paths.json')
      .then((r) => (r.ok ? r.json() : { routes: {} }))
      .then((d) => Object.fromEntries(Object.entries(d.routes ?? {}).map(([id, r]) => [id, r.path])))
      .catch(() => ({}))
    let alive = true
    pathsLoad.then((p) => { if (alive) setPaths(p) })
    return () => { alive = false }
  }, [])
  return paths
}
