import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import BusMap from '../components/BusMap'
import { FullAlerts, LocationCard, MapLegend, MissedBus, TripCard } from '../components/LivePanels'
import { trackedBuses, useLiveTrips, useMyLocation } from '../liveHooks'
import { Logo } from '../components/ui'
import { freshness, isFull } from '../liveMath'
import { useLiveBuses, useRoutes } from '../live'
import { FindMyStop } from '../components/DailyPlans'
import { useStops } from '../plans'

/** Public live view: every bus sharing its position, which way it is going, what is next, full buses and the bus
 *  that takes over, the viewer's own location, and "missed your bus?" — from the same live feed as the home page. */
export default function LiveBuses() {
  const { buses, connected } = useLiveBuses()
  const routes = useRoutes()
  const { routesById, now, nowMin, headings, directions, paths } = useLiveTrips(buses, routes)
  const loc = useMyLocation()
  const stops = useStops()
  const [focusId, setFocusId] = useState(null)
  const [walk, setWalk] = useState(null)
  const [picked, setPicked] = useState(null)
  // What the map keeps in view: you, a bus, or both (updated as either moves).
  const [follow, setFollow] = useState({ me: true, busId: null })

  const list = useMemo(() => Object.values(buses), [buses])
  const tracked = trackedBuses(list, now)
  const lastSeen = list.filter((b) => b.location && freshness(b, now) === 'STALE').length

  const show = (busId, stop) => {
    setFollow({ me: !!loc.me, busId })
    setPicked(null)
    setWalk(stop && loc.me ? { from: loc.me.at, to: stop.at, label: `Board at ${stop.name}` } : null)
  }
  const followBus = follow.busId != null ? buses[follow.busId] : null
  const followPoints = [
    ...(follow.points ?? []),
    ...(follow.me && loc.me ? [loc.me.at] : []),
    ...(followBus?.location ? [[followBus.location.lat, followBus.location.lng]] : []),
  ]
  const followLabel = [follow.me && loc.me ? 'you' : null, followBus ? `Bus ${followBus.id}` : null].filter(Boolean).join(' and ')
  const pick = (o) => {
    setPicked(o)
    setWalk(o && loc.me ? { from: loc.me.at, to: o.boardAt, label: `Board at ${o.board}` } : null)
    setFocusId(o?.kind === 'live' ? o.bus.id : null)
    setFollow({ me: !!o, busId: o?.kind === 'live' ? o.bus.id : null })
  }

  return (
    <div className="live-wrap">
      <header className="topbar">
        <div className="topbar-main-wrap">
          <Link to="/" className="topbar-left">
            <Logo />
            <div><div className="brand">SafarSaathi</div><div className="topbar-sub">Live buses</div></div>
          </Link>
          <div className="topbar-right">
            <span className={`live-dot ${connected ? 'on' : ''}`}>{connected ? 'Live' : 'Connecting…'}</span>
          </div>
        </div>
      </header>

      <main className="live-page">
        <section className="live-side">
          <LocationCard loc={loc} routes={routes} title={`${tracked.length} buses sharing their location`} />
          <section className="card">
            <FindMyStop stops={stops} routes={routes} title="Find your stop: from where you are, or an area or landmark"
              onPick={(s, from) => {
                setPicked(null)
                setWalk({ from: from.at, to: s.at, label: `${s.name} · Bus ${s.buses.slice(0, 4).join(', ') || '–'}` })
                setFollow({ me: false, busId: null, points: [from.at, s.at] })
              }} />
          </section>
          <FullAlerts full={tracked.filter(isFull)} list={list} nowMin={nowMin} onShow={(id) => show(id)} />
          <MissedBus routes={routes} routesById={routesById} list={list} directions={directions} nowMin={nowMin} me={loc.me}
            onAskLocation={loc.start} onPick={pick} picked={picked} paths={paths} />

          {tracked.length === 0 && <p className="muted">No bus is sharing its location right now.</p>}
          {tracked.map((b) => (
            <TripCard key={b.id} bus={b} route={routesById[b.route_id]} direction={directions[b.id]} now={now} nowMin={nowMin}
              me={loc.me} onShow={show} paths={paths} />
          ))}
          {lastSeen > 0 && <p className="tiny muted">{lastSeen} more bus{lastSeen === 1 ? '' : 'es'} last seen over a minute ago (not listed).</p>}
        </section>

        <section className="live-map-col">
          <BusMap buses={list.filter((b) => b.location)} routes={routes} height="calc(100vh - 140px)" zoom={12}
            focusId={focusId} onSelect={(id) => { setFocusId(id); setFollow({ me: false, busId: id }) }} headings={headings}
            me={loc.me} walk={walk} follow={followPoints} followLabel={followLabel} />
          <MapLegend />
        </section>
      </main>
    </div>
  )
}

