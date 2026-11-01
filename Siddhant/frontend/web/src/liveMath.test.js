// Run: npm test   (Node's built-in runner; no extra packages)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAMPUS } from './geo.js'
import {
  alternatives, bearingDeg, clock, demoDrive, directionOf, distanceM, freshness, isFull, nearestPlace, nextBusAfterFull, progress, project,
  pointAlong, roadTrack, routePath, snapToRoad,
} from './liveMath.js'

// A route due north of campus: A (first pickup, ~3.3 km out), B (~2.2 km), C (~1.1 km), then campus.
const lng = CAMPUS[1]
const ROUTE = { id: 1, name: 'A via C', stop_points: [['A', 30.2987], ['B', 30.2887], ['C', 30.2787]].map(([name, lat], i) => ({ id: i, name, lat, lng })) }
const routesById = { 1: ROUTE }
const at = (lat) => ({ lat, lng })
const now = Date.now()
const bus = (id, extra = {}) => ({ id, route_id: 1, capacity: 40, seats_free: 10, status: 'scheduled', location_at: new Date(now).toISOString(), ...extra })

test('distances and bearings', () => {
  assert.ok(Math.abs(distanceM([30.0, 78.0], [30.01, 78.0]) - 1112) < 5)
  assert.ok(Math.abs(bearingDeg([30.0, 78.0], [30.01, 78.0]) - 0) < 0.5)      // north
  assert.ok(Math.abs(bearingDeg([30.0, 78.0], [30.0, 78.01]) - 90) < 0.5)     // east
})

test('route paths run first pickup -> campus inbound, and the reverse outbound', () => {
  const inb = routePath(ROUTE, 'in'), out = routePath(ROUTE, 'out')
  assert.deepEqual(inb.nodes.map((n) => n.name), ['A', 'B', 'C', 'Campus'])
  assert.deepEqual(out.nodes.map((n) => n.name), ['Campus', 'C', 'B', 'A'])
  assert.ok(Math.abs(inb.length - out.length) < 1 && Math.abs(inb.length - 3336) < 10)
})

test('direction from movement: closer to campus is an arrival; standing still falls back to time of day', () => {
  assert.equal(directionOf([30.29, lng], [30.288, lng], 15), 'in')
  assert.equal(directionOf([30.288, lng], [30.29, lng], 9), 'out')
  assert.equal(directionOf([30.29, lng], [30.29, lng], 9), 'in')
  assert.equal(directionOf(null, [30.29, lng], 16), 'out')
})

test('progress: next stop, distance left and ETA in the direction of travel', () => {
  const p = progress(ROUTE, 'in', at(30.2937), 30)          // between A and B, heading to campus
  assert.equal(p.next, 'B')
  assert.equal(p.destination, 'Campus')
  assert.ok(Math.abs(p.leftKm - 2.78) < 0.02)
  assert.ok(Math.abs(p.etaMin - p.leftKm * 2) < 0.01)       // 30 km/h = 2 min per km
  const q = progress(ROUTE, 'out', at(30.2937), 0)          // same place, leaving campus, stopped
  assert.equal(q.next, 'A')
  assert.ok(Math.abs(q.etaMin - (q.leftKm / 20) * 60) < 0.01) // typical 20 km/h when stopped
})

test('freshness and full', () => {
  assert.equal(freshness(bus(1), now + 10_000), 'LIVE')
  assert.equal(freshness(bus(1), now + 45_000), 'DELAYED')
  assert.equal(freshness(bus(1), now + 90_000), 'STALE')
  assert.equal(freshness({ id: 1 }), 'NO_GPS')
  assert.equal(isFull(bus(1, { seats_free: 0 })), true)
  assert.equal(isFull(bus(1, { status: 'full' })), true)
  assert.equal(isFull(bus(1)), false)
})

test('next bus after a full one: boarding now, else the next departure of the same route', () => {
  const full = bus(18, { seats_free: 0 })
  const boarding = bus(9, { status: 'boarding' })
  const later = bus(10, { usual_departure: '18:00' })
  const other = bus(22, { route_id: 2, status: 'boarding' })
  assert.deepEqual(nextBusAfterFull(full, [full, later, boarding, other], 16 * 60), { bus: boarding, kind: 'boarding' })
  assert.deepEqual(nextBusAfterFull(full, [full, later, other], 16 * 60), { bus: later, kind: 'later', at: '18:00' })
  assert.equal(nextBusAfterFull(full, [full, bus(11, { seats_free: 0, usual_departure: '18:00' })], 16 * 60), null)
})

test('missed your bus: board a live bus at a stop ahead you can walk to in time', () => {
  const live = bus(18, { location: at(30.2937), speed_kmh: 20 })           // inbound, between A and B
  const [o] = alternatives({ dest: { name: 'Campus', at: CAMPUS }, me: [30.2787, lng + 0.001], buses: [live],
    routesById, directions: { 18: 'in' }, nowMin: 600 })
  assert.equal(o.kind, 'live')
  assert.equal(o.board, 'C')                                              // ~100 m walk, bus ~6 min away
  assert.equal(o.catchable, true)
  assert.equal(o.drop, 'Campus')
  assert.ok(o.arriveMin > o.busAtMin)
})

test('missed your bus: later departures from campus, a nearby drop-off, and never boarding at the destination', () => {
  const later = bus(42, { usual_departure: '16:00' })
  const opts = alternatives({ dest: { name: 'Near B', at: [30.2887, lng + 0.005] }, me: CAMPUS, buses: [later],
    routesById, directions: {}, nowMin: 15 * 60 })
  assert.equal(opts.length, 1)
  const [o] = opts
  assert.equal(o.kind, 'scheduled')
  assert.equal(o.board, 'Campus')
  assert.equal(o.drop, 'B')
  assert.ok(o.dropFromDestM > 400 && o.dropFromDestM < 600)               // ~480 m from where they are going
  assert.equal(clock(o.busAtMin), '4:00 PM')
  // Going to C while standing at C: the board stop must come before the drop stop.
  const [p] = alternatives({ dest: { name: 'C', at: [30.2787, lng] }, me: [30.2787, lng], buses: [later],
    routesById, directions: {}, nowMin: 15 * 60 })
  assert.notEqual(p.board, p.drop)
})

test('a full bus is never offered, and a far-away walker is told plainly they are too late', () => {
  const full = bus(18, { location: at(30.2937), speed_kmh: 20, seats_free: 0 })
  assert.deepEqual(alternatives({ dest: { name: 'Campus', at: CAMPUS }, me: CAMPUS, buses: [full], routesById,
    directions: { 18: 'in' }, nowMin: 600 }), [])
  const live = bus(19, { location: at(30.2937), speed_kmh: 20 })
  const [o] = alternatives({ dest: { name: 'Campus', at: CAMPUS }, me: [30.20, lng], buses: [live], routesById,
    directions: { 19: 'in' }, nowMin: 600 })
  assert.equal(o.catchable, false)
  assert.ok(o.slackMin < 0)
})

// The approved road path from the GPS project: from A it goes 1 km east first, then south to campus (an L),
// so the road is longer than the straight stop-to-stop line.
const EAST = lng + 0.0104 // ~1 km east at this latitude
const ROAD = [[30.2987, lng], [30.2987, EAST], [30.2687, EAST], [CAMPUS[0], lng]]
const LROUTE = { id: 2, name: 'A road', stop_points: [{ id: 1, name: 'A', lat: 30.2987, lng }, { id: 2, name: 'Corner', lat: 30.2987, lng: EAST }] }

test('with an approved road path, distances follow the road, not the straight line', () => {
  const straight = routePath(LROUTE, 'in'), road = routePath(LROUTE, 'in', ROAD)
  assert.equal(road.road, true)
  // A -> corner (1 km) -> south (3.3 km) -> west (1 km) = ~5.3 km by road; A -> corner -> straight to campus = ~4.5 km
  assert.ok(Math.abs(road.length - 5330) < 40 && road.length > straight.length + 700)
  assert.deepEqual(road.nodes.map((n) => n.name), ['A', 'Corner', 'Campus'])
  assert.ok(Math.abs(road.nodes[1].along - 1000) < 15)                         // the corner is 1 km along the road
  const out = routePath(LROUTE, 'out', ROAD)
  assert.equal(out.nodes[0].along, 0)
  assert.ok(Math.abs(out.nodes.at(-1).along - out.length) < 1)                 // outbound ends at A, the far end
})

test('a bus on the road is placed along it: last stop passed, next stop, km left, and how far off the road it is', () => {
  const onRoad = { lat: 30.2837, lng: EAST }                                   // halfway down the south leg
  const p = progress(LROUTE, 'in', onRoad, 30, ROAD)
  assert.equal(p.previous, 'Corner')
  assert.equal(p.next, 'Campus')
  assert.ok(p.off < 5)
  const straightLeft = distanceM([onRoad.lat, onRoad.lng], CAMPUS) / 1000
  assert.ok(p.leftKm > straightLeft + 0.3)                                     // road distance, not as the crow flies
  const offRoad = project(routePath(LROUTE, 'in', ROAD), [30.2837, EAST - 0.003])
  assert.ok(offRoad.off > 250 && Math.abs(offRoad.at[1] - EAST) < 1e-9)       // snapped back onto the road
})

test('direction follows the road: a loop that comes back towards campus is still a departure', () => {
  const inPath = routePath(LROUTE, 'in', ROAD)
  // Outbound on the top leg the bus heads west from the corner to A: closer to campus as the crow flies (campus is
  // due south of A), yet further from it along the road.
  const prev = [30.2987, EAST - 0.002], cur = [30.2987, EAST - 0.004]
  assert.ok(distanceM(cur, CAMPUS) < distanceM(prev, CAMPUS))                  // crow-flies says "arriving"
  assert.equal(directionOf(prev, cur, 9), 'in')
  assert.equal(directionOf(prev, cur, 9, inPath), 'out')                       // the road says "departing"
  assert.equal(directionOf(cur, prev, 15, inPath), 'in')
  assert.equal(directionOf([30.20, lng], [30.21, lng], 15, inPath), 'in')     // far off the road: crow-flies fallback
})

test('nearest named place for "you are near ..."', () => {
  assert.equal(nearestPlace([ROUTE], [30.2790, lng + 0.0005]).name, 'C')
  assert.equal(nearestPlace([ROUTE], CAMPUS).name, 'Campus')
  assert.ok(nearestPlace([ROUTE], [30.2790, lng]).d < 40)
})

test('a GPS fix drifting beside the road is drawn on the road; a real detour is not', () => {
  const track = roadTrack(ROAD)
  const beside = snapToRoad(track, [30.2837, EAST + 0.0003])                    // ~30 m east of the south leg
  assert.equal(beside.onRoad, true)
  assert.ok(Math.abs(beside.at[1] - EAST) < 1e-9 && Math.abs(beside.off - 29) < 3)
  assert.equal(snapToRoad(track, [30.2837, EAST - 0.003]).onRoad, false)        // ~290 m off: drawn where it is
  assert.equal(snapToRoad(null, [30.28, lng]), null)
})

test('points along the road, and the right pass where the road comes back on itself', () => {
  const track = roadTrack(ROAD)
  assert.deepEqual(pointAlong(track, 0), ROAD[0])
  assert.deepEqual(pointAlong(track, 1e9), ROAD.at(-1))
  const p = pointAlong(track, 2000)                                            // 1 km down the south leg
  assert.ok(Math.abs(p[1] - EAST) < 1e-9 && Math.abs(distanceM(p, [30.2987, EAST]) - 1000) < 15)
  // Out and back on one road: the same spot is ~150 m and ~450 m along it.
  const back = roadTrack([[30.28, lng], [30.28, lng + 0.0031], [30.28, lng]])
  const spot = [30.28, lng + 0.00155]
  assert.ok(Math.abs(snapToRoad(back, spot, 140).along - 150) < 5)
  assert.ok(Math.abs(snapToRoad(back, spot, 460).along - 450) < 5)
})

test('the demo drive stays on the road, waits at stops, and loops back without a jump', () => {
  const line = [...ROAD].reverse()                                             // campus -> A, as the map draws it
  const stops = LROUTE.stop_points.map((p) => [p.lat, p.lng])
  const drive = demoDrive(line, stops, 50, 2)
  const track = roadTrack(line)
  assert.deepEqual(drive[0], line[0])
  for (const p of drive) assert.ok(snapToRoad(track, p).off < 1)                // never off the blue line
  const loop = [...drive, drive[0]]
  for (let i = 1; i < loop.length; i++) assert.ok(distanceM(loop[i - 1], loop[i]) <= 50.5) // small steps, no jump back
  // Out to A (the far end) and back, holding at the corner stop each way and at A.
  const held = (p) => drive.filter((q, i) => i && distanceM(q, p) < 1 && distanceM(drive[i - 1], q) < 1).length
  assert.equal(held(stops[1]), 4)
  assert.equal(held(stops[0]), 2)
  assert.ok(drive.some((p) => distanceM(p, stops[0]) < 1))
  assert.deepEqual(demoDrive([[30.28, lng]], stops, 50, 2), [])
})
