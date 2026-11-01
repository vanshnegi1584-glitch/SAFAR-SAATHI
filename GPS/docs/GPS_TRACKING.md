# Live GPS tracking & route navigation

Real-time tracking of campus buses from the driver's phone, route-aware progress/ETA for students, and an
admin workflow to turn the text-only schedule CSV into trackable routes.

## What was built

| Piece | Where | Status |
|---|---|---|
| Schedule CSV parser, slot mapping, route plan, route matching, arrival, freshness, ETA | `packages/shared/src/{csv,schedule,routePlan,fix,tripProgress,freshness}.ts` | Unit-tested (incl. against the real CSV) |
| Tracking server (Express + Socket.IO, Postgres) | `apps/tracking-server` | End-to-end tested on PGlite (real migrations) |
| Database migrations | `Bus Management System/supabase/migrations/2026103100000{2,3}_*.sql` | Applied + RLS-tested on PGlite; **not yet applied to a real Supabase project** |
| Driver app: sign-in, start/end trip, GPS publishing, offline queue, screen-off mode | `apps/mobile/src/app/live-driver.tsx`, `src/lib/gpsPublisher.ts`, `src/tasks/driverLocation.ts` | Typechecked + bundled; **not yet run on a phone** |
| Student app: route choice, live map, freshness, next stop, ETA, own location (on-device) | `apps/mobile/src/app/live-{student,route}.tsx`, `src/components/LiveBusMap.tsx` | Typechecked + bundled; **not yet run on a phone** |
| Dispatcher: Live GPS page; admin Route Setup (stop review, road geometry) | `apps/dispatcher-web/app/{tracking,admin/routes}` | Run in a browser against the dev server |

Mock mode (`*_DATA_SOURCE=mock`) and every existing screen are unchanged.

## Data flow

```
Driver phone (expo-location, high accuracy, ~1 s fixes)
  → GpsPublisher: every 2 s moving / 5 s parked; offline → queued, flushed in order via REST
  → Socket.IO `driver:location` (ack) or POST /api/driver/locations (batch / background)
  → Tracker: payload validation → authorisation (server's trip record: driver ↔ assignment ↔ bus)
           → plausibility (future/old/out-of-order/jump) → route matching → arrival/deviation → ETA
  → broadcast `bus:location` to rooms: dispatch, route:<id>, bus:<id>   (then persisted, off the hot path)
  → student app / dispatcher: marker interpolation between real fixes only; freshness from server clock
```

Students only ever receive buses on the route they registered (`campus_student_routes`); dispatchers
see all. Rooms are assigned by the server — clients cannot join rooms by name.

## Source of truth: the schedule CSV

`parseSchedule()` reads `SafarSaathi_Bus_Schedule.csv` with an RFC 4180 parser (some Route cells contain
quoted line breaks). Results on the current file: **97 buses, 30 routes, 87 stop names, 0 errors**.

- Stable ids: `bus-<registration>` (e.g. `bus-uk07pa1696`), `stop-<slug>`, `campus-geu` / `campus-geu-gehu`,
  `route-<first stop>-<hash of stop sequence>`. Re-importing the same data gives the same ids.
- The verbatim cells of every import are stored (`campus_schedule_rows`); nothing is dropped. Duplicate
  registrations are reported and kept out of `campus_buses` until fixed, never silently merged.
- "No Service" is stored as `no_service`, never as a time.
- Review notes the importer currently raises (check these with the transport office):
  - Possible same stop, different spelling: Kargi / Kargi Chowk; Fountain Chowk / Fountain Chowk Rispana;
    Selaqui / Selaqui Chowk; Prem Nagar / Premnagar; Baliwala Chowk / Balliwalachowk. Merge only via
    `data/stop-aliases.json` after checking.
  - Garhi Cant appears twice on the Garhi Cant/Hathibadkala routes (handled: repeated stops are supported).
  - Three driver names are shared by different people (different phone numbers).
- Driver names and phone numbers stay server-side (`campus_bus_driver_contacts`, staff-only RLS) and are
  never sent to the apps. The real CSV is git-ignored for the same reason.

**Reloading the CSV** (safe while trips are running):
```bash
npm run import-schedule -w @transitlink/tracking-server -- ../../data/SafarSaathi_Bus_Schedule.csv --dry-run
npm run import-schedule -w @transitlink/tracking-server -- ../../data/SafarSaathi_Bus_Schedule.csv --aliases ../../data/stop-aliases.json
```
Admin-verified stop coordinates and route geometry are never overwritten; buses/routes no longer in the
file are deactivated, not deleted; each running trip keeps a frozen route snapshot, so a reload cannot
change it mid-trip. (Admins can also POST the CSV to `/api/admin/schedule/import`.)

## Departure slots vs. CSV shift timings

Application slots (Asia/Kolkata, table `campus_departure_slots`): pickups 07:00 and 11:00 (TO_COLLEGE),
departures 13:00, 16:00, 18:00 (FROM_COLLEGE). They are compared per bus with the CSV's Shift Timing
(1st entry ↔ 07:00, 2nd ↔ 11:00):

| Slot | matched | conflict | no service | unconfirmed |
|---|---|---|---|---|
| 07:00 | 60 | 37 (CSV 06:10/06:35/06:45) | — | — |
| 11:00 | 60 | 24 (CSV 10:35/10:45) | 13 | — |
| 13:00 / 16:00 / 18:00 | — | — | — | 97 each (CSV has no afternoon times) |

Only `matched` or admin-`confirmed` slots can be attached to a trip; conflicts and unconfirmed slots never
get a time assigned implicitly (`PUT /api/admin/slots/:bus/:slot`). A driver can always start an
*unscheduled* run. Starting a trip is always an explicit driver action — a departure time arriving never
creates one.

Open question for the transport office: is a CSV time (e.g. 06:45) the departure from the first stop with
arrival at college by 07:00? If so, the mapping rule should treat it as matching the 07:00 slot.

## Direction

`TO_COLLEGE` = the CSV stop order (first listed stop → GEU/GEHU). `FROM_COLLEGE` = the reverse sequence
and reversed geometry. Direction is chosen when the trip starts and is never inferred from GPS, screen
position or longitude; GPS only moves the bus along the directed route.

## Route geometry and stop coordinates

The CSV has stop *names* only. A route becomes "ready" (route matching, next stop, arrival, ETA) only when
every stop has admin-**verified** coordinates and the route has admin-**verified** road geometry. Until
then the bus position is still shown, with an explicit "route not configured" warning and no ETA.

Workflow (dispatcher web → **Route Setup**, admin accounts):
1. Pick a route → pick a stop → *Search OpenStreetMap* for suggestions, or click the map at the boarding
   point. Suggestions are never accepted automatically: in testing, "ISBT" returned an ISBT ~30 km away
   near Rishikesh, "Rispana" returned a river, a drain and a bridge, and "Geu/Gehu" returned nothing.
2. Set the arrival radius, *Save as verified*. Stops are shared across routes (Rispana is on 12).
3. When all stops are verified: *Suggest road path* (OSRM through the stops in order), inspect it, *Approve*.

Each change bumps the route version; trips already running keep their snapshot.

## Matching, arrival, freshness, ETA

- **Fix gate** (`fix.ts`): rejects malformed payloads, timestamps > 30 s in the future or > 30 min old,
  out-of-order sequence/time, and jumps faster than 40 m/s beyond the reported accuracy (accepted again
  after 3 mutually consistent fixes, so one bad *previous* fix cannot freeze tracking). Fixes older than
  60 s are stored as history but never shown as live.
- **Accuracy vs. freshness**: poor-accuracy fixes are still shown (labelled), but fixes worse than 50 m
  don't move route progress or trigger arrival. Quality: ≤10 m good, ≤30 m fair, else poor.
- **Route matching** (`tripProgress.ts`): projection onto the directed geometry within a corridor
  (40–150 m, widened by accuracy), choosing the candidate consistent with expected progress — this resolves
  repeated stops, roads travelled both ways and nearby parallel roads. 3 consecutive off-corridor fixes →
  `route:deviation`; next stop never moves backwards on jitter.
- **Arrival**: inside the stop geofence, accuracy compatible with the radius, route progress consistent
  with having reached it, and 3 consecutive fixes (or ≥10 s dwell). Passing near the college earlier in a
  trip, or sitting at the college at the start of a FROM_COLLEGE trip, does not count.
- **Freshness** (server clock; `min(device time, receipt time)` so a fast phone clock can't fake
  freshness): LIVE ≤ 5 s, DELAYED ≤ 15 s, STALE beyond, WAITING FOR GPS, TRIP ENDED. `bus:stale` and
  `bus:offline` (60 s) fire once per transition; live resumes on the next fix. Markers interpolate between
  real fixes only and stop at the last one.
- **ETA** (`freshness.ts`): remaining *route* distance ÷ speed, where speed is a transparent baseline
  (18 km/h incl. stops) blended 40/60 with current speed when moving and accurate. No ETA when the route
  isn't verified, GPS is stale, or the bus has been stationary > 90 s. There is no traffic data and no trip
  history yet (`historicalMps` is the hook for it). Every ETA is labelled with its basis.

## Free seats (vision module)

Seat counts come from Vansh's vision module (separate repo `ai_face`, `vision/service.py`): one small
FastAPI service per bus fuses the door IR counter with the seat camera and serves `GET /fusion`. The
tracking server (`apps/tracking-server/src/seats.ts`) polls each configured service every 2 s and sends
`bus:seats` to the same rooms as that bus's location (dispatch, students on its route, its driver).

- Configure with `SEAT_SOURCES={"bus-<registration>": "http://<host>:<port>"}`; off when empty.
- Start each vision service with `VISION_BUS_ID=<fleet number>` (e.g. `18` for `bus-uk07pa1696`).
- A reading is published as **unavailable** (no number) when the service is unreachable or returns an
  invalid body, reports a different bus (`bus_mismatch`), uses a capacity different from the schedule
  (`capacity_mismatch`), or itself reports stale sensors. Apps hide readings older than 15 s.
- The vision service decides camera vs. IR; the apps show which one ("counted by the bus camera" /
  "from the door passenger counter"). `recalibration_required` is shown to dispatchers.
- Only numbers cross between the two systems — no frames or faces.

Tested with a stand-in service returning the exact `/fusion` response shape
(`apps/tracking-server/test/seats.test.ts`); **not yet tested against the real vision service or a bus
camera.** Running the real service needs its own Python setup (PyTorch, YOLO, OpenCV — see its README).

## Privacy

- Student location never leaves the phone: it is requested only after an explanation, never re-prompted
  after a refusal, and used only for the map and the distance to their stop.
- Driver location is published only while the driver has explicitly started a trip; screen-off mode shows
  a persistent Android notification.
- Location history is staff-only and purged after `LOCATION_RETENTION_DAYS` (default 30).

## Security fixes in the existing schema (migration 3)

- Signup trusted `raw_user_meta_data.role`, so anyone could register as `admin`; now only
  `passenger`/`student` can be self-chosen.
- Users could change their own `role` via the "update own profile" policy; now blocked by trigger.
- `bus_locations` (intercity module) was readable by anonymous users and writable by any driver for any bus;
  now staff / the trip's driver / booked passengers only.

## Running it

**Local, no Supabase or Docker** (in-memory Postgres, real migrations, real CSV, dev tokens printed):
```bash
npm install
npm run dev:local -w @transitlink/tracking-server
```
Then the dispatcher with the printed admin token (dev only):
```bash
NEXT_PUBLIC_DATA_SOURCE=live NEXT_PUBLIC_DEV_TOKEN=dev:<admin uuid> npm run dev:web
```

**With Supabase:**
1. In the `Bus Management System` repo: `npx supabase db push` (applies migrations 2 and 3).
2. Create accounts in Supabase Auth; set staff/driver roles in `profiles.role` (SQL editor — users can
   no longer self-assign them).
3. `apps/tracking-server/.env` from `.env.example`, then import the CSV (above) and `npm run dev:server`.
4. Route Setup → verify stops and geometry; assign drivers: `PUT /api/admin/drivers/:userId/assignment`.
5. Apps: set `*_DATA_SOURCE=live`, `*_API_URL`, `*_SUPABASE_URL`, `*_SUPABASE_ANON_KEY` (see `.env.example`).
   Screen-off driver tracking needs a development build (`npx eas-cli@latest build --profile development`).

## Tests

```bash
npm test                 # shared: 63 tests (parser, slots, direction, matching, arrival, gate, freshness, ETA)
npm run test:server      # migrations + RLS on PGlite; full trip end-to-end over Socket.IO; seat relay
```

## Not verified yet — do these before relying on it

1. **Real phones.** Nothing here has run on a physical device. Drive a route with two phones (driver +
   student) and log: fix accuracy, fixes accepted/rejected, measurement → server latency (logged by the
   server every minute as p50/p95), server → student delivery, battery use per hour.
2. **5 m accuracy.** The software requests the best accuracy the phone offers and reports what it gets; it
   cannot guarantee 5 m. Compare accepted fixes against surveyed points (e.g. stop poles) on a few runs.
3. **Real Supabase.** Migrations were tested on PGlite with stubbed `auth` objects; apply them to a staging
   project first. Supabase token verification (`SupabaseAuthenticator`) is untested against a live project.
4. **Background tracking** under Android battery optimisation and iOS (needs a development build).
5. **Thresholds** (corridor, dwell, freshness, baseline speed) are first guesses — tune from real trips.
6. **Scale:** single server instance, in-memory trip state. More than one instance needs a Socket.IO adapter
   (e.g. Redis) and shared trip state.
7. **Vehicle GPS trackers** (ESP32/MQTT in the blueprint) are not wired in; the server only accepts
   `driver_device` fixes today so the two sources can't be mixed silently.

## Event and API reference

Server → client: `trip:started`, `trip:updated`, `trip:ended`, `bus:location`, `bus:stale`, `bus:offline`,
`bus:arrived`, `route:deviation`, `bus:seats`, `tracking:error` (types: `packages/shared/src/trackingTypes.ts`).
Client → server: `driver:location` (ack), `track:subscribe`, `track:unsubscribe`.

REST: `GET /api/me`, `GET /api/tracking/snapshot`, `PUT /api/students/me/route`, `GET /api/driver/me`,
`POST /api/driver/trips`, `POST /api/driver/trips/:id/end`, `POST /api/driver/locations`,
admin: `POST /api/admin/schedule/import`, `GET /api/admin/schedule/report`, `GET|PUT /api/admin/slots…`,
`GET /api/admin/stops`, `POST /api/admin/stops/:id/geocode`, `PUT /api/admin/stops/:id`,
`POST /api/admin/routes/:id/geometry/suggest`, `PUT /api/admin/routes/:id/geometry`,
`PUT /api/admin/drivers/:userId/assignment`.
