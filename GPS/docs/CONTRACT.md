# Frontend ↔ Backend Contract (PROPOSAL — for Siddhant to review)

Source of truth for types: `packages/shared/src/types.ts`. Everything here is a proposal derived from
the Blueprint; the Blueprint does not define API routes, socket events, or enum values.

## Enum values (Blueprint lists these as enums without values)
| Column | Proposed values |
|---|---|
| `users.role` | `student`, `driver`, `dispatcher`, `admin` |
| `buses.status` | `active`, `idle`, `maintenance`, `offline` |
| `digital_tokens.status` | `waiting`, `called`, `boarded`, `expired`, `cancelled` |

## Coordinates
All coordinates sent to the frontend are **GeoJSON order `[lng, lat]`**. (Note the MQTT payload uses
named `lat`/`lon` fields — the backend converts.)

## Socket.io — server → client
| Event | Payload | When |
|---|---|---|
| `telemetry:update` | `TelemetryUpdate` | Each MQTT message (~2 s/bus), after IR+CV fusion |
| `telemetry:batch` | `TelemetryUpdate[]` (oldest → newest) | ESP32 bulk-publishes after GSM reconnect (§6). **Please forward as one batch, not N single updates** — the UI replays it as a smooth path |
| `token:update` | `DigitalToken` | Any token create/status change |
| `sos:alert` | `SosAlert` | `sos_active` becomes true |
| `sos:cleared` | `{ bus_id }` | Dispatcher resolves SOS |
| `trip:last_bus_departed` | `{ route_id, trip_id }` | Geofence exit of a trip with `is_last_bus = true` (§6) |
| `fallback:suggestion` | `FallbackSuggestion` | Result of `find_fallback_route` for an affected student |

`TelemetryUpdate.timestamp` must be the **device** timestamp, not server receive time — the UI uses it
to drop out-of-order samples and to detect stale buses (> 10 s).

Auth: socket handshake `auth.token` = Supabase access token. Server should put dispatchers in a
`dispatch` room and students in `route:<id>` rooms so students don't receive the whole fleet.

## REST
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/fleet/snapshot` | — | `{ routes, stops, buses, trips }` — each bus has `fleet_number` (the allotted number shown to people, e.g. `"18"`) |
| GET | `/api/tokens?active=true` | — | `DigitalToken[]` (include `student_name` for dispatcher) |
| POST | `/api/tokens` | `{ trip_id }` | `DigitalToken` — **idempotent**: return existing active token for same student+trip. Student id from auth, never from body |
| PATCH | `/api/tokens/:id` | `{ status }` | `DigitalToken` (dispatcher only) |
| POST | `/api/sos` | `{ bus_id }` | 204 (driver app) |
| DELETE | `/api/sos/:bus_id` | — | 204 (dispatcher) |
| GET | `/api/students/me/fallback` | — | `FallbackSuggestion \| null` (reference logic: `packages/shared/src/fallback.ts`) |
| PATCH | `/api/tokens/:id` (student) | `{ status: "cancelled" }` | Students may cancel **their own** token only |
| POST | `/api/geofence-events` | `{ bus_id, region_id, event: "enter"\|"exit", timestamp }` | 204. `region_id` is `campus` or `stop:<id>`. Campus `exit` on an `is_last_bus` trip → end trip, emit `trip:last_bus_departed`, send FCM (§6) |
| POST | `/api/devices` | `{ platform: "android"\|"ios", token }` | 204. Native FCM/APNs token from `getDevicePushTokenAsync` |

## Road geometry
`routes.polyline` should hold the **road-following** path. The frontend currently fetches it from Google
Routes at runtime (`packages/shared/src/googleRoutes.ts` has the request builder/parser — reusable from
Node). Google's terms limit storing Routes API content, so check the Maps Platform terms before persisting
Google polylines in the DB; an alternative is drawing routes once by hand / from OSM and storing those.

## Questions for the team
1. Which pax value is authoritative in telemetry — fused (Vansh) or raw IR `net_current`? UI assumes fused.
2. Is ETA computed server-side? UI currently estimates client-side (`packages/shared/src/eta.ts`).
3. Queue scope: per trip (assumed) or per route?
