// Run: npm test   (Node's built-in runner; no extra packages)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findPlaces, nearestStops, searchBox, stopPositions, WALKABLE_M } from './stopFinder.js'

const lng = 78.0
const routes = [
  { id: 1, stop_points: [{ name: 'A', lat: 30.30, lng }, { name: 'B', lat: 30.29, lng }, { name: 'C', lat: 30.28, lng }] },
  { id: 2, stop_points: [{ name: 'B', lat: 30.2901, lng }, { name: 'D', lat: 30.10, lng }] },   // B again, slightly off
]
const stops = [
  { name: 'A', routes: [1], buses: [9] }, { name: 'B', routes: [1, 2], buses: [9, 22] },
  { name: 'C', routes: [1], buses: [9] }, { name: 'D', routes: [2], buses: [22] }, { name: 'No position', routes: [3], buses: [] },
]

test('stop positions come from the routes; a stop on two routes keeps its first position', () => {
  const at = stopPositions(routes)
  assert.deepEqual(at.B, [30.29, lng])
  assert.deepEqual(Object.keys(at).sort(), ['A', 'B', 'C', 'D'])
})

test('nearest stops: closest first, with distance, walking time, and a plain "too far to walk"', () => {
  const at = stopPositions(routes)
  const near = nearestStops(stops, at, [30.2905, lng + 0.001])           // ~110 m from B
  assert.deepEqual(near.map((s) => s.name), ['B', 'A', 'C'])
  assert.ok(near[0].distanceM > 90 && near[0].distanceM < 130)
  assert.equal(near[0].walkMin, 1)
  assert.deepEqual(near[0].buses, [9, 22])                             // which buses stop there
  assert.equal(near[0].walkable, true)
  const [far] = nearestStops(stops, at, [30.60, lng], 1)               // ~33 km away
  assert.equal(far.walkable, false)
  assert.ok(far.distanceM > WALKABLE_M)
  assert.ok(!nearestStops(stops, at, [30.29, lng], 10).some((s) => s.name === 'No position'))
})

test('place search: looks only near the bus network, sends just the typed text, and needs 3+ letters', async () => {
  const at = stopPositions(routes)
  const box = searchBox(at)
  assert.deepEqual(box.map((x) => +x.toFixed(2)), [77.9, 30.4, 78.1, 30.0])
  const urls = []
  const fake = async (url) => {
    urls.push(url)
    return { ok: true, json: async () => [{ display_name: 'Prem Nagar, Dehradun, Uttarakhand, 248007, India', lat: '30.335', lon: '77.96' }] }
  }
  const [p] = await findPlaces('  prem nagar ', box, fake)
  assert.equal(p.name, 'Prem Nagar, Dehradun, Uttarakhand')
  assert.deepEqual(p.at, [30.335, 77.96])
  const u = new URL(urls[0])
  assert.equal(u.searchParams.get('q'), 'prem nagar')
  assert.equal(u.searchParams.get('bounded'), '1')
  assert.deepEqual(await findPlaces('pn', box, fake), [])
  assert.equal(urls.length, 1)                                            // too short: no request at all
  // Not found as typed: one more try without the spaces ("Prem Nagar" is "Premnagar" on OpenStreetMap).
  const asked = []
  const onlyOneWord = async (url) => {
    const q = new URL(url).searchParams.get('q'); asked.push(q)
    return { ok: true, json: async () => (q === 'premnagar' ? [{ display_name: 'Premnagar, Dehradun, Uttarakhand', lat: '30.335', lon: '77.964' }] : []) }
  }
  const [again] = await findPlaces('prem  nagar', box, onlyOneWord, 0)
  assert.deepEqual(asked, ['prem nagar', 'premnagar'])
  assert.equal(again.name, 'Premnagar, Dehradun, Uttarakhand')
  asked.length = 0
  assert.deepEqual(await findPlaces('nowhere', box, onlyOneWord, 0), [])
  assert.deepEqual(asked, ['nowhere'])                                    // one word: no second request
  await assert.rejects(findPlaces('prem nagar', box, async () => ({ ok: false, status: 429 })), /Place search failed \(429\)/)
})
