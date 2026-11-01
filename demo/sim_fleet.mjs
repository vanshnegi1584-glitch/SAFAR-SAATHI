// DEMO ONLY: simulated buses for the LOCAL GPS server (dev tokens; started by demo/start-demo.ps1): one bus on each of the 7 verified test
// routes drives its approved path at ~25 km/h, sending a position every 3 s, alternating
//   DEPARTURE (campus -> first stop, the path reversed, on the 1/4/6 PM slots in turn) and
//   ARRIVAL   (first stop -> campus).
// Passengers: every departure WAITS AT THE GEU STOP while students board and leaves only when FULL;
// on the way people get off at stops. On arrivals people board at each stop, so a bus can fill up.
// Bus 18's count comes from the real webcam; the other 6 buses each get a SIMULATED door counter
// served at http://127.0.0.1:8021-8026/fusion (the same format as the vision bridge), which the
// GPS server polls when started with the SEAT_SOURCES printed below. Every bus on these 7 routes is
// confirmed for the 1/4/6 PM departures so "next bus" can name another bus. Ctrl+C stops.
import http from 'node:http';

const API = 'http://localhost:4000';
const A = { Authorization: 'Bearer dev:00000000-0000-4000-8000-00000000a001', 'Content-Type': 'application/json' };
const SPEED = 7; // m/s
const CAMERA_BUS_MAX_WAIT_S = 45; // bus 18 (41 seats) can't be filled by one webcam: it leaves after this
const STEP_S = 3;
const DEPARTURE_SLOTS = ['pm-1300', 'pm-1600', 'pm-1800'];
const CAMERA_BUS = 'bus-uk07pa1696'; // bus 18: people from the webcam, not simulated
const FLEET = [ // [driver profile id suffix, bus id, simulated counter port]
  ['d001', 'bus-uk07pa1696', null], // Clock Tower, bus 18 (the bus with the camera)
  ['d002', 'bus-uk07pa3542', 8021], // Asley Hall, bus 42
  ['d003', 'bus-uk07pa5017', 8022], // Bangali Kothi, bus 75
  ['d004', 'bus-uk07pa2623', 8023], // Doiwala, bus 34
  ['d005', 'bus-uk07pa4160', 8024], // Mokampur, bus 53
  ['d006', 'bus-uk07pa1944', 8025], // Nakrounda More, bus 15
  ['d007', 'bus-ua07q4731', 8026],  // ONGC Chowk, bus 22
];
console.log('Start the GPS server with:\n  SEAT_SOURCES=' + JSON.stringify(Object.fromEntries(FLEET.map(([, id, port]) =>
  [id, port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:8010']))) + '\n');

const C = Math.cos(30.3 * Math.PI / 180);
const seg = (a, b) => Math.hypot((b[0] - a[0]) * C * 111320, (b[1] - a[1]) * 110570);
const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const json = async (r) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(b)}`); return b; };
const post = (path, headers, body) => fetch(API + path, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
const confirm = async (busId, slot) => json(await fetch(`${API}/api/admin/slots/${busId}/${slot}`,
  { method: 'PUT', headers: A, body: JSON.stringify({ decision: 'confirmed', note: 'Test fleet (simulator)' }) }));

/** Path for a direction with cumulative metres, and where along it each stop is (nearest vertex). */
function pathFor(route, stops, direction) {
  const line = direction === 'TO_COLLEGE' ? route.geometry.slice() : route.geometry.slice().reverse();
  const cum = [0]; for (let k = 1; k < line.length; k++) cum.push(cum[k - 1] + seg(line[k - 1], line[k]));
  const stopAlong = route.stop_ids.map((id) => stops.find((s) => s.id === id)?.location).filter(Boolean).map((p) => {
    let best = 0; for (let k = 1; k < line.length; k++) if (seg(line[k], p) < seg(line[best], p)) best = k;
    return cum[best];
  }).sort((a, b) => a - b);
  return { line, cum, stopAlong };
}

const snap = await json(await fetch(API + '/api/tracking/snapshot', { headers: A }));
const buses = [];
// Every bus on these routes runs the afternoon departures, so a full bus has a named bus after it.
const fleetRoutes = new Set(FLEET.map(([, id]) => snap.buses.find((x) => x.id === id)?.route_id));
for (const bus of snap.buses.filter((x) => fleetRoutes.has(x.route_id))) for (const slot of DEPARTURE_SLOTS) await confirm(bus.id, slot);

async function startTrip(b, direction) {
  const slot = direction === 'FROM_COLLEGE' ? DEPARTURE_SLOTS[b.departures++ % DEPARTURE_SLOTS.length] : undefined;
  b.trip = await json(await post('/api/driver/trips', b.D, { direction, ...(slot ? { slot_id: slot } : {}) }));
  Object.assign(b, { direction, slot, along: 0, nextStop: 1 }, pathFor(b.route, snap.stops, direction));
  // Departures wait at campus until full; arrivals set off with a few people already on.
  b.boarding = direction === 'FROM_COLLEGE';
  if (b.port) b.people = direction === 'FROM_COLLEGE' ? 0 : rand(0, 4);
}

for (const [i, [suffix, busId, port]] of FLEET.entries()) {
  const driver = `00000000-0000-4000-8000-00000000${suffix}`;
  const D = { Authorization: `Bearer dev:${driver}`, 'Content-Type': 'application/json' };
  if (suffix !== 'd001') await json(await fetch(`${API}/api/admin/drivers/${driver}/assignment`, { method: 'PUT', headers: A, body: JSON.stringify({ bus_id: busId }) }));
  const me = await json(await fetch(API + '/api/driver/me', { headers: D }));
  const route = snap.routes.find((r) => r.id === me.route?.id);
  if (!route?.geometry) { console.log(`skip ${busId}: its route has no path`); continue; }
  const capacity = snap.buses.find((x) => x.id === busId)?.seats ?? 40;
  const b = { D, me, route, port, capacity, people: 0, departures: i, seq: Math.floor(Date.now() / 1000) % 1_000_000 + i * 1_000_000 };
  if (me.open_trip) await post(`/api/driver/trips/${me.open_trip.id}/end`, D); // a fresh trip: no GPS jump
  const departing = busId === CAMERA_BUS || i % 2 === 1;
  await startTrip(b, departing ? 'FROM_COLLEGE' : 'TO_COLLEGE');
  if (!departing) { // arrivals start part-way along, already fairly busy
    b.along = (i / FLEET.length) * b.cum.at(-1);
    b.nextStop = b.stopAlong.findIndex((m) => m > b.along);
    if (port) b.people = Math.round(capacity * (0.55 + Math.random() * 0.3));
  }
  if (port) {
    http.createServer((req, res) => {
      if (!req.url?.startsWith('/fusion')) { res.writeHead(404).end(); return; }
      const people = Math.min(b.people, b.capacity);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        bus_id: me.bus.fleet_number, capacity: b.capacity, seats_free: b.capacity - people, source: 'ir', reason: 'simulated',
        recalibration_required: false, people_on_board: people, people_source: 'ir',
      }));
    }).listen(port, '127.0.0.1');
  }
  buses.push(b);
  console.log(`bus ${me.bus.fleet_number.toString().padStart(3)} ${b.direction === 'TO_COLLEGE' ? 'ARRIVAL  ' : 'DEPARTURE'} ${b.slot ?? '       '} on ${route.name}: ${b.capacity} seats, ${port ? 'simulated counter :' + port : 'webcam counter'}`);
}

/** Bus 18 only: full by the server's latest webcam reading. */
async function cameraFull(busId) {
  const e = (await json(await fetch(API + '/api/tracking/snapshot', { headers: A }))).seats?.find((s) => s.bus_id === busId);
  return !!e && (e.seats_free === 0 || (e.people_on_board != null && e.capacity != null && e.people_on_board >= e.capacity));
}

const at = (b, m) => { const { line, cum } = b; let i = 1; while (i < line.length - 1 && cum[i] < m) i++; const t = Math.min(1, (m - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1));
  return [line[i - 1][0] + t * (line[i][0] - line[i - 1][0]), line[i - 1][1] + t * (line[i][1] - line[i - 1][1]), Math.atan2((line[i][0] - line[i - 1][0]) * C, line[i][1] - line[i - 1][1]) * 180 / Math.PI]; };

for (;;) {
  const out = [];
  for (const b of buses) {
    const n = b.me.bus.fleet_number;
    try {
      if (b.boarding) { // waiting at campus: students get on; leave once full
        if (b.port) b.people = Math.min(b.capacity, b.people + rand(2, 5));
        b.waited = (b.waited ?? 0) + STEP_S;
        const full = b.port ? b.people >= b.capacity : await cameraFull(b.me.bus.id);
        if (full || (!b.port && b.waited >= CAMERA_BUS_MAX_WAIT_S)) {
          b.boarding = false;
          b.waited = 0;
          console.log(full ? `*** Bus ${n} is FULL (${b.port ? b.people + '/' + b.capacity : 'webcam'}) - leaving GEU now`
            : `*** Bus ${n} leaves GEU after ${CAMERA_BUS_MAX_WAIT_S} s of boarding (webcam count, not full)`);
        }
      } else if (b.along > b.cum.at(-1)) { // end of the path: everyone off, then the other direction
        await post(`/api/driver/trips/${b.trip.id}/end`, b.D);
        await startTrip(b, b.direction === 'TO_COLLEGE' ? 'FROM_COLLEGE' : 'TO_COLLEGE');
      } else if (b.port && b.nextStop >= 0 && b.nextStop < b.stopAlong.length && b.along >= b.stopAlong[b.nextStop]) {
        // At a stop on the way: departures drop people off, arrivals pick people up.
        b.nextStop++;
        b.people = b.direction === 'FROM_COLLEGE'
          ? Math.max(0, b.people - Math.ceil(b.people * (0.15 + Math.random() * 0.25)))
          : Math.min(b.capacity, b.people + rand(3, 9));
      }
      const [lng, lat, heading] = at(b, b.along); b.seq += 1;
      const fix = { busId: b.me.bus.id, tripId: b.trip.id, latitude: lat, longitude: lng, accuracyMeters: 8, speedMetersPerSecond: b.boarding ? 0 : SPEED,
        headingDegrees: (heading + 360) % 360, timestamp: new Date().toISOString(), sequence: b.seq, source: 'driver_device' };
      const r = await json(await post('/api/driver/locations', b.D, { fixes: [fix] }));
      const load = b.port ? ` ${b.people}/${b.capacity}` : '';
      out.push(`${n}${b.direction === 'TO_COLLEGE' ? '↑' : '↓'}${b.boarding ? 'boarding' : (b.along / 1000).toFixed(1) + 'km'}${load}${r.acks?.[0]?.accepted ? '' : '!' + (r.acks?.[0]?.reason ?? '')}`);
    } catch (e) { out.push(`${n}:error ${e.message.slice(0, 60)}`); }
    if (!b.boarding) b.along += SPEED * STEP_S;
  }
  console.log(`${new Date().toLocaleTimeString()}  ${out.join('  ')}`);
  await new Promise((r) => setTimeout(r, STEP_S * 1000));
}
