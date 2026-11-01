import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Circle, CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { CAMPUS } from '../geo'
import { GPS_SOURCE, onDriverAppGps } from '../gpsSource'
import { useRoutePaths } from '../liveHooks'
import { pointAlong, roadTrack, snapToRoad } from '../liveMath'
import { roadRoute, straightLine } from '../routing'

const GLIDE_MS = 1900      // a little under the 2 s telemetry interval, so the bus keeps moving
const SNAP_IF_DEG = 0.02   // ~2 km: a jump that big (e.g. backlog replay) is snapped, not animated
const GLIDE_ROAD_M = 2000  // further than this along the road between two fixes: jump, don't drive it
const ROUTE_COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2']

// Moves a bus marker between GPS fixes at a steady speed instead of teleporting. With its route's road (`track`), a
// fix that drifted a little off the road is drawn on it, and the marker drives along the road between fixes (round
// bends, not across them); a fix well off the road (a detour) is drawn where it is. Returns [position, metres off
// the road when off it].
function useGlide(target, track) {
  const [pos, setPos] = useState(null)
  const [offM, setOffM] = useState(null)
  const current = useRef(null) // { at, along, track }: along is set while the marker is on `track`
  const [lat, lng] = target ?? []

  useEffect(() => {
    if (lat == null) return
    const from = current.current
    const sameRoad = from?.track === track && from?.along != null
    const snap = snapToRoad(track, [lat, lng], sameRoad ? from.along : null)
    const to = snap?.onRoad ? { at: snap.at, along: snap.along, track } : { at: [lat, lng], track }
    const off = snap && !snap.onRoad ? snap.off : null
    const byRoad = sameRoad && to.along != null && Math.abs(to.along - from.along) < GLIDE_ROAD_M
    const set = (p) => { current.current = p; setPos(p.at) }
    let raf
    if (!from || (!byRoad && Math.abs(from.at[0] - to.at[0]) + Math.abs(from.at[1] - to.at[1]) > SNAP_IF_DEG)) {
      raf = requestAnimationFrame(() => { set(to); setOffM(off) })
      return () => cancelAnimationFrame(raf)
    }
    const start = performance.now()
    const step = (now) => {
      const t = Math.min((now - start) / GLIDE_MS, 1)
      if (byRoad) {
        const d = from.along + (to.along - from.along) * t
        set({ at: pointAlong(track, d), along: d, track })
      } else {
        set(t < 1 ? { at: [from.at[0] + (to.at[0] - from.at[0]) * t, from.at[1] + (to.at[1] - from.at[1]) * t], track } : to)
      }
      if (t < 1) raf = requestAnimationFrame(step)
      else setOffM(off)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [lat, lng, track])

  return [pos ?? (lat == null ? null : [lat, lng]), offM]
}

// The line each route is drawn with, and the road its buses are kept on: the approved road path from the GPS
// project; else a road-snapped line between the stops (OSRM, cached); else straight lines until that arrives.
function useRouteLines(routes, approved) {
  const [snapped, setSnapped] = useState({})
  useEffect(() => {
    let cancelled = false
    for (const r of routes) {
      if (approved[r.id] || r.stop_points.length === 0) continue
      roadRoute(straightLine(r)).then((line) => {
        if (!cancelled && line) setSnapped((s) => (s[r.id] === line ? s : { ...s, [r.id]: line }))
      })
    }
    return () => { cancelled = true }
  }, [routes, approved])
  return useMemo(() => {
    const lines = Object.fromEntries(routes.map((r) => [r.id, approved[r.id] ?? snapped[r.id] ?? straightLine(r)]))
    const tracks = Object.fromEntries(Object.entries(lines).map(([id, line]) => [id, roadTrack(line)]))
    return { lines, tracks }
  }, [routes, approved, snapped])
}

function RoutePolyline({ route, color, dim, path }) {
  return (
    <Fragment>
      <Polyline positions={path} pathOptions={{ color, weight: dim ? 2 : 4, opacity: dim ? 0.25 : 0.7 }} />
      {!dim && route.stop_points.map((p) => (
        <CircleMarker key={p.id} center={[p.lat, p.lng]} radius={4}
          pathOptions={{ color, weight: 2, fillColor: '#fff', fillOpacity: 1 }}>
          <Tooltip direction="top">{p.name} · {route.name}</Tooltip>
        </CircleMarker>
      ))}
    </Fragment>
  )
}

// Keeps the given points (you, a bus, or both) in view as they move. Dragging the map hands control back to the
// viewer until they press "Follow again".
function FollowView({ points, label }) {
  const map = useMap()
  const [paused, setPaused] = useState(false)
  const key = points.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(';') // changes in ~10 m steps
  useEffect(() => {
    const stop = () => setPaused(true)
    map.on('dragstart', stop)
    return () => { map.off('dragstart', stop) }
  }, [map])
  useEffect(() => {
    const pts = key ? key.split(';').map((p) => p.split(',').map(Number)) : []
    if (paused || pts.length === 0) return
    if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 15), { animate: true })
    else map.fitBounds(pts, { padding: [60, 60], maxZoom: 16, animate: true })
  }, [key, paused, map])
  if (!paused || points.length === 0) return null
  return <button type="button" className="btn primary small map-follow" onClick={() => setPaused(false)}>Follow again{label ? `: ${label}` : ''}</button>
}

// The bus number is the marker itself, so riders can tell "18" from "19" at a glance.
function BusMarker({ bus, focused, marked, dimmed, onSelect, heading, track }) {
  const [pos, offM] = useGlide(bus.location ? [bus.location.lat, bus.location.lng] : null, track)
  const tone = bus.sos ? 'sos' : focused ? 'focus' : marked ? 'mark' : dimmed ? 'dim' : bus.device?.online === false ? 'off' : ''
  const linked = onDriverAppGps(bus) // green ring: position live from the driver-app GPS
  // Direction of travel: a pointer around the number, turned to the heading (rounded so the icon isn't rebuilt every fix).
  const turn = heading == null ? null : Math.round(heading / 5) * 5
  const icon = useMemo(() => L.divIcon({
    className: 'bus-num-icon', iconSize: null,
    html: `${turn == null ? '' : `<span class="bus-heading" style="transform: rotate(${turn}deg)"></span>`}`
      + `<span class="bus-num-marker ${tone}${linked ? ' linked' : ''}">${bus.id}</span>`,
  }), [bus.id, tone, linked, turn])
  if (!pos) return null
  return (
    <Marker position={pos} icon={icon} zIndexOffset={focused || bus.sos ? 1000 : marked ? 500 : 0}
      eventHandlers={onSelect ? { click: () => onSelect(bus.id) } : undefined}>
      <Tooltip direction="top" offset={[0, -14]}>
        Bus {bus.id}{bus.route_name ? ` · ${bus.route_name}` : ''}{bus.sos ? ' · SOS' : ''}
        {bus.speed_kmh ? ` · ${Math.round(bus.speed_kmh)} km/h` : ''}
        {bus.location_source ? ` · ${GPS_SOURCE[bus.location_source] ?? 'GPS'}` : ''}
        {offM != null ? ` · ${Math.round(offM)} m off its route` : ''}
      </Tooltip>
    </Marker>
  )
}

const NO_ROUTES = []

export default function BusMap({ buses, routes = NO_ROUTES, focusId, highlightRoute, highlightRoutes, markIds = [], height = 260,
  zoom = 13, onSelect, headings = {}, me = null, walk = null, follow = null, followLabel = '' }) {
  const approvedPaths = useRoutePaths()
  const { lines, tracks } = useRouteLines(routes, approvedPaths)
  const highlighted = highlightRoutes?.length ? highlightRoutes : highlightRoute != null ? [highlightRoute] : null
  const focus = buses.find((b) => b.id === focusId && b.location)
  const center = focus ? [focus.location.lat, focus.location.lng] : CAMPUS
  const anyLocated = buses.some((b) => b.location)

  return (
    <div className="map" style={{ height }}>
      <MapContainer key={focus ? `focus-${focusId}` : 'campus'} center={center} zoom={zoom} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {routes.map((r, i) => (
          <RoutePolyline key={r.id} route={r} color={ROUTE_COLORS[i % ROUTE_COLORS.length]}
            dim={highlighted != null && !highlighted.includes(r.id)} path={lines[r.id]} />
        ))}
        <CircleMarker center={CAMPUS} radius={7} pathOptions={{ color: '#0f172a', fillColor: '#fbbf24', fillOpacity: 1 }}>
          <Tooltip>GEHU campus</Tooltip>
        </CircleMarker>
        {buses.map((b) => (
          <BusMarker key={b.id} bus={b} focused={b.id === focusId} marked={markIds.includes(b.id)}
            dimmed={markIds.length > 0 && !markIds.includes(b.id)} onSelect={onSelect} heading={headings[b.id]}
            track={tracks[b.route_id]} />
        ))}
        {me && (
          <Fragment>
            {me.accuracy > 0 && <Circle center={me.at} radius={me.accuracy} pathOptions={{ color: '#3b82f6', weight: 1, fillOpacity: 0.1 }} />}
            {/* "You" stays labelled, so it shows even under a bus marker when you are at (or on) the bus. */}
            <CircleMarker center={me.at} radius={9} pathOptions={{ color: '#fff', weight: 3, fillColor: '#3b82f6', fillOpacity: 1 }}>
              <Tooltip permanent direction="bottom" offset={[0, 10]} className="me-label">You</Tooltip>
            </CircleMarker>
          </Fragment>
        )}
        {walk && (
          <Fragment>
            <Polyline positions={[walk.from, walk.to]} pathOptions={{ color: '#7c3aed', weight: 3, dashArray: '6 6' }} />
            <CircleMarker center={walk.to} radius={8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#7c3aed', fillOpacity: 1 }}>
              <Tooltip permanent direction="bottom" offset={[0, 8]}>{walk.label}</Tooltip>
            </CircleMarker>
          </Fragment>
        )}
        {follow?.length > 0 && <FollowView points={follow} label={followLabel} />}
      </MapContainer>
      {!anyLocated && <p className="map-note">No bus is sharing its location yet.</p>}
    </div>
  )
}
