# Vidhu — Frontend, UI/UX & Mapping (TransitLink)

Extracted from *TransitLink Architecture Blueprint.pdf*. Items marked **(explicit)** are written in the
PDF; items marked **(implied)** are not spelled out but are required for the explicit items to work.

## 1. Tech stack (explicit, §1.2)
- Next.js 14 (App Router) — Dispatcher web dashboard
- React Native (Expo) — Student app + Driver app (one app, role-based)
- Zustand — client/real-time state
- React Query — server state (routes, stops, buses, tokens)
- React-Map-GL — web live map (§5.1) → **Google Maps when a key is set** (team request for real roads)

## 2. Deliverables

### 2.1 Dispatcher Web (explicit, §5.1)
- [x] Live fleet map — routes, stops, buses coloured by occupancy
- [x] Real-road route geometry via Google Routes API on Google Maps (MapLibre fallback without a key)
- [x] Queue manager **column view** for digital tokens (one column per afternoon departure)
- [x] Fleet panel: speed, pax / capacity, GPS sats, stale/offline/resynced indicator  *(implied)*
- [x] SOS alert banner with locate / resolve  *(implied)*
- [ ] Auth / role gate (dispatcher only)  — **blocked on Siddhant's Supabase auth setup**

### 2.2 Student App (explicit, §5.1)
- [x] Live tracking of own route's bus with **ETA** to the student's stop (direction-aware)
- [x] **"JOIN QUEUE"** button → live queue position, "your turn" alert + notification, leave queue
- [x] **Fallback Alert modal** — triggered by `trip:last_bus_departed`, uses `find_fallback_route`
      (client mirror in `packages/shared/src/fallback.ts`), "Track this bus" switches tracking
- [x] Local notifications for queue call + last bus (work in Expo Go)
- [ ] Remote FCM push (§6) — code ready (`getPushToken`), **needs your Firebase project +
      `google-services.json` + a development build**, and Siddhant's `/api/devices` endpoint

### 2.3 Driver App (explicit, §5.1)
- [x] Zero-touch interface (one-time bus selection, then no interaction needed)
- [x] Giant **SOS** button, hold 2 s to confirm, haptics, false-alarm cancel
- [x] Background geofence tracking (campus + route stops) with permission explanation flow.
      Campus exit reports `geofence-events` → backend checks `is_last_bus` (§6).
      **Needs a development build to test** — Expo Go has no background location.

### 2.4 Cross-cutting (explicit, §6)
- [x] **Smooth marker interpolation** — no teleporting after GSM outage (web + mobile, tested)
- [x] Last-bus departure workflow end-to-end in mock: driver geofence exit → trip ends →
      `trip:last_bus_departed` → student fallback modal + notification

## 3. Dependencies on teammates
| Need | From | Status |
|---|---|---|
| Socket.io event names + payload shapes | Siddhant | **Proposed** in `docs/CONTRACT.md` — needs agreement |
| REST endpoints incl. fallback, geofence events, push devices | Siddhant | Proposed |
| Enum values (`role`, `bus.status`, `token.status`) | Siddhant | Assumed |
| Supabase auth (login replaces the role picker) | Siddhant | Not started |
| Fused pax count (IR + CV) field | Vansh / Siddhant | Assumed fused `current_pax_count` |
| MQTT payload (§3.2) | Rahul | Used verbatim by the simulator |

## 4. Milestones
1. **Done:** monorepo, shared contract, simulator, interpolation, Dispatcher Web, Google road routes.
2. **Done:** Expo app — Student + Driver modes, fallback engine, notifications, geofencing code.
3. Swap mock → live once Siddhant's server is up (`*_DATA_SOURCE=live`).
4. Development build (EAS) to test background geofencing + FCM on real phones.
5. Usability testing with real students/drivers; measure: ETA error (min), queue no-show rate,
   SOS press-to-dispatcher latency, % of trips auto-started by geofence without driver input.

## 5. Open questions
- Is ETA computed on the backend or the client? (Client estimate now.)
- Queue scope: per trip (assumed) or per route?
- Can students cancel their own token? (Assumed yes — needs a backend permission rule.)
