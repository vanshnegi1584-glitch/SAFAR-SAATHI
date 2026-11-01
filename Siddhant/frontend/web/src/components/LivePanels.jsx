// Live GPS pieces shared by the Live buses page and the passenger, staff and office pages: direction of travel,
// next stop and ETA, full buses and the bus that takes over, the viewer's own location, and "missed your bus?".
import { useMemo, useState } from 'react'
import { GPS_SOURCE } from '../gpsSource'
import {
  alternatives, clock, departureOf, distanceM, duration, freshness, isFull, km, minutesOf, nearestPlace, nextBusAfterFull,
  progress, TYPICAL_KMH,
} from '../liveMath'

const FRESH_PILL = { LIVE: 'good', DELAYED: 'warn', STALE: 'neutral' }

/** "Show my location": where the viewer is (nearest stop or campus, coordinates, accuracy), plus page-specific children. */
export function LocationCard({ loc, title = 'Your location', routes = [], children }) {
  const place = loc.me && nearestPlace(routes, loc.me.at)
  return (
    <section className="card">
      <div className="row-between">
        <div className="eyebrow">{title}</div>
        {loc.state === 'off' || loc.state === 'denied' || loc.state === 'unsupported'
          ? <button className="btn primary small" onClick={loc.start}>Show my location</button>
          : <button className="btn ghost small" onClick={loc.stop}>Hide my location</button>}
      </div>
      <p className="tiny muted">
        {loc.state === 'denied' ? 'Location permission was refused; allow it for this site to compare. '
          : loc.state === 'unsupported' ? 'This browser cannot share a location. '
            : loc.state === 'finding' && !loc.me ? 'Finding your location… '
              : ''}
        Your location stays in this browser and is never sent.
      </p>
      {loc.me && (
        <div className="you-are-here">
          <b>You are {place && place.d < 150 ? 'at' : 'near'} {place?.name ?? 'an unknown place'}</b>
          {place && place.d >= 150 && <span> ({km(place.d)} away)</span>}
          <div className="tiny muted">{loc.me.at[0].toFixed(5)}, {loc.me.at[1].toFixed(5)} · accurate to ±{Math.round(loc.me.accuracy)} m</div>
        </div>
      )}
      {children}
    </section>
  )
}

export function Direction({ bus, direction }) {
  const dep = departureOf(bus)
  return direction === 'in'
    ? <span className="pill arrive">Arrival · to campus</span>
    : <span className="pill depart">Departure{dep ? ` ${clock(minutesOf(dep))}` : ''} · from campus</span>
}

/** One line for a bus on the road: which way, next stop, distance and ETA (approximate). Nothing when not live. */
export function TripLine({ bus, route, direction, now, paths = {} }) {
  const f = freshness(bus, now)
  if (!bus?.location || !['LIVE', 'DELAYED'].includes(f)) return null
  const p = progress(route, direction, bus.location, bus.speed_kmh, paths[bus.route_id])
  return (
    <div className="trip-line tiny">
      <Direction bus={bus} direction={direction} />
      {p && <span> Next: <b>{p.next}</b> · {p.leftKm.toFixed(1)} km to {p.destination} · ETA ~{duration(p.etaMin)}</span>}
      <span className="muted"> · {f === 'LIVE' ? 'live' : 'delayed'} GPS</span>
    </div>
  )
}

export function FullAlerts({ full, list, nowMin, onShow }) {
  if (full.length === 0) return null
  return (
    <div className="live-alerts" role="status" aria-live="polite">
      {full.map((b) => {
        const next = nextBusAfterFull(b, list, nowMin)
        const leaving = b.status === 'boarding' || b.trip?.in_depot
        return (
          <div key={b.id} className="alert bad">
            <b>Bus {b.id} is full{b.capacity ? ` (${b.occupancy ?? b.capacity}/${b.capacity})` : ''}</b>
            {leaving ? ' — leaving now' : ' — no seats until someone gets off'}
            <div className="tiny">{b.route_name}</div>
            <div className="tiny">
              {!next ? 'No other bus on this route is boarding or due later today.'
                : next.kind === 'boarding' ? <>Next: <b>Bus {next.bus.id}</b> is boarding at campus now.</>
                  : <>Next bus: <b>Bus {next.bus.id}</b> at {clock(minutesOf(next.at))}.</>}
              {next && next.bus.location && onShow && <button className="link-btn" onClick={() => onShow(next.bus.id)}>Show</button>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** "Missed your bus?": pick a stop (or start from `initialDest`; give the component a new `key` to change it)
 *  and see every bus that still gets you there. */
export function MissedBus({ routes, routesById, list, directions, nowMin, me, onAskLocation, onPick, picked, initialDest = '', startOpen = false, paths = {} }) {
  const [open, setOpen] = useState(startOpen)
  const [destName, setDestName] = useState(initialDest)
  const [all, setAll] = useState(false)
  const destinations = useMemo(() => {
    const byName = new Map()
    for (const r of routes) for (const s of r.stop_points) if (!byName.has(s.name)) byName.set(s.name, { name: s.name, at: [s.lat, s.lng] })
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [routes])
  const dest = destinations.find((d) => d.name === destName)
  const options = useMemo(() => (dest && me ? alternatives({ dest, me: me.at, buses: list, routesById, directions, nowMin, paths }) : []),
    [dest, me, list, routesById, directions, nowMin, paths])
  const shown = all ? options : options.slice(0, 5)
  const key = (o) => `${o.kind}-${o.bus.id}`

  if (!open) return <button className="btn ghost block" onClick={() => setOpen(true)}>Missed your bus? Find another bus that goes your way</button>
  return (
    <section className="card">
      <div className="row-between">
        <div className="eyebrow">Missed your bus?</div>
        <button className="link-btn" onClick={() => { setOpen(false); onPick?.(null) }}>Close</button>
      </div>
      <label className="tiny live-dest">Going to
        <select value={destName} onChange={(e) => { setDestName(e.target.value); onPick?.(null) }}>
          <option value="">Choose a stop…</option>
          {destinations.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
      </label>
      {!me && <p className="tiny muted">To work out your walk to each bus, <button className="link-btn" onClick={onAskLocation}>show my location</button>.</p>}
      {me && dest && options.length === 0 && <p className="tiny muted">No bus you can still board passes within 2 km of {dest.name} today.</p>}
      {shown.map((o) => (
        <div key={key(o)} className={`live-option ${picked && key(picked) === key(o) ? 'picked' : ''} ${o.catchable ? '' : 'faded'}`}>
          <div className="row-between">
            <b>Bus {o.bus.id} <span className="tiny muted">· {o.kind === 'live' ? 'on the road now' : `leaves campus ${clock(minutesOf(departureOf(o.bus)))}`}</span></b>
            <span className={`pill ${o.catchable ? 'good' : 'neutral'}`}>{o.catchable ? 'You can catch it' : 'Too late'}</span>
          </div>
          <div className="tiny">Walk {km(o.walkM)} (~{duration(o.walkMin)}) to <b>{o.board}</b></div>
          <div className="tiny">Bus reaches {o.board} at {clock(o.busAtMin)} (in {duration(o.busAtMin - nowMin)})</div>
          <div className={`tiny ${o.catchable ? 'good-text' : 'bad-text'}`}>
            {o.catchable ? `You'd have about ${duration(o.slackMin)} to spare` : `You'd be about ${duration(o.slackMin)} too late`}
          </div>
          <div className="tiny">Gets you to <b>{o.drop}</b> at {clock(o.arriveMin)}
            {o.dropFromDestM > 100 && <span className="warn-text"> · {km(o.dropFromDestM)} from {dest.name}</span>}
          </div>
          {onPick && (
            <button className="link-btn" onClick={() => onPick(picked && key(picked) === key(o) ? null : o)}>
              {picked && key(picked) === key(o) ? 'Hide on map' : 'Show on map'}
            </button>
          )}
        </div>
      ))}
      {options.length > shown.length && <button className="link-btn" onClick={() => setAll(true)}>Show {options.length - shown.length} more</button>}
    </section>
  )
}

/** A bus on the road, in full: freshness, full, direction, next stop/ETA, seats, and the viewer's distance to it. */
export function TripCard({ bus, route, direction, now, nowMin, me, onShow, paths = {} }) {
  const f = freshness(bus, now)
  const p = progress(route, direction, bus.location, bus.speed_kmh, paths[bus.route_id])
  const ago = Math.max(0, Math.round((now - new Date(bus.location_at).getTime()) / 1000))
  // With the viewer's location: the stop ahead of the bus nearest to them, and when the bus gets there.
  const mine = me && p && (() => {
    const ahead = p.path.nodes.filter((n) => n.along > p.along).map((n) => ({ n, d: distanceM(me.at, n.at) })).sort((a, b) => a.d - b.d)[0]
    return ahead && { stop: ahead.n, fromMe: ahead.d, busAt: nowMin + ((ahead.n.along - p.along) / 1000 / p.kmh) * 60 }
  })()
  return (
    <div className="card trip-card">
      <div className="row-between">
        <b className="bus-number small" title={bus.registration ? `Vehicle ${bus.registration}` : undefined}>Bus {bus.id}</b>
        <span className="row-gap">
          {isFull(bus) && <span className="pill bad">FULL</span>}
          <span className={`pill ${FRESH_PILL[f]}`}>{f}</span>
        </span>
      </div>
      <div className="tiny"><Direction bus={bus} direction={direction} /> <span className="muted">{bus.route_name}</span></div>
      <div className="trip-facts tiny">
        <span className="muted">Updated {ago < 60 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago · {GPS_SOURCE[bus.location_source] ?? 'GPS'}
          {bus.speed_kmh ? ` · ${Math.round(bus.speed_kmh)} km/h` : ''}</span>
        {p && <span>Next: {p.next} · {p.leftKm.toFixed(1)} km to {p.destination} · ETA ~{duration(p.etaMin)}</span>}
        {bus.capacity > 0 && <span>{bus.seats_free ?? '?'}/{bus.capacity} seats free{bus.occupancy != null ? ` · ${bus.occupancy} on board` : ''}</span>}
        {me && (
          <span className="mine">
            Bus is {km(distanceM(me.at, [bus.location.lat, bus.location.lng]))} from you
            {mine && <> · nearest stop ahead: <b>{mine.stop.name}</b> ({km(mine.fromMe)} from you), bus there ~{clock(mine.busAt)}</>}
            {onShow && <>{' '}<button className="link-btn" onClick={() => onShow(bus.id, mine?.stop)}>Show me and the bus</button></>}
          </span>
        )}
        {!me && onShow && <span><button className="link-btn" onClick={() => onShow(bus.id)}>Show on map</button></span>}
      </div>
    </div>
  )
}

/** Map key for the live pieces drawn on BusMap. */
export function MapLegend() {
  return (
    <div className="live-legend tiny">
      <span><i className="lg ring" /> Live from the driver-app GPS</span>
      <span><i className="lg arrow" /> Direction of travel</span>
      <span><i className="lg me" /> You</span>
      <span><i className="lg board" /> Board here</span>
      <span className="muted">Coloured lines are the routes' roads (the GPS project's approved path where there is one). Buses are drawn
        on their route's road and move along it; one more than 60 m off it is drawn where its GPS says. Times follow the approved
        path where there is one, else straight lines between stops, at the live bus speed ({TYPICAL_KMH} km/h when stopped).</span>
    </div>
  )
}

/** "Where is Bus 9 now?" for the student: at campus, at a stop or between two stops (along the approved road path),
 *  how fresh that is, how far the student is from it, and when they are at the same place (or riding it). */
export function BusNow({ bus, route, direction, now, me, paths = {}, onShowBoth }) {
  if (!bus) return null
  const f = freshness(bus, now)
  if (!bus.location || f === 'NO_GPS') {
    return (
      <section className="card bus-now">
        <div className="eyebrow">Where is Bus {bus.id} now?</div>
        <div className="muted">Bus {bus.id} has not shared its location yet today.</div>
      </section>
    )
  }
  const at = [bus.location.lat, bus.location.lng]
  const p = progress(route, direction, bus.location, bus.speed_kmh, paths[bus.route_id])
  const where = bus.trip?.in_depot ? 'At campus (GEU)'
    : bus.trip?.at_stop ? `At ${bus.trip.at_stop}`
      : p ? (p.previous && p.previous !== p.next ? `Between ${p.previous} and ${p.next}` : `On the way to ${p.next}`)
        : 'On the road'
  const ago = Math.max(0, Math.round((now - new Date(bus.location_at).getTime()) / 1000))
  const gap = me ? distanceM(me.at, at) : null
  const together = gap != null && gap <= 60
  const moving = (bus.speed_kmh ?? 0) >= 5
  return (
    <section className="card bus-now">
      <div className="row-between">
        <div className="eyebrow">Where is Bus {bus.id} now?</div>
        <span className={`pill ${FRESH_PILL[f]}`}>{f === 'STALE' ? 'LAST SEEN' : f}</span>
      </div>
      <b>{f === 'STALE' ? `Last seen: ${where.toLowerCase()}` : where}</b>
      <div className="tiny">
        <Direction bus={bus} direction={direction} />
        <span className="muted"> · {moving ? `${Math.round(bus.speed_kmh)} km/h` : 'not moving'} · updated {ago < 60 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago
          · {GPS_SOURCE[bus.location_source] ?? 'GPS'}</span>
      </div>
      {p && f !== 'STALE' && <div className="tiny">Next: <b>{p.next}</b> · {p.leftKm.toFixed(1)} km to {p.destination} · ETA ~{duration(p.etaMin)}</div>}
      {gap != null && (together
        ? <div className="together">You and Bus {bus.id} are at the same place{moving ? ' — moving together' : ''}</div>
        : <div className="tiny">You are {km(gap)} from Bus {bus.id} (straight line).</div>)}
      {onShowBoth && <button className="link-btn" onClick={onShowBoth}>{me ? `Show me and Bus ${bus.id} on the map` : `Show Bus ${bus.id} on the map`}</button>}
    </section>
  )
}
