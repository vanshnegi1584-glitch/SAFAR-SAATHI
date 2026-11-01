# TransitLink — Frontend (Vidhu)

Frontend for the AI-driven college bus fleet system described in *TransitLink Architecture Blueprint.pdf*.

```
packages/shared        Types, data-source interface, mock simulator, interpolation, ETA, queue logic (+ tests)
apps/dispatcher-web    Next.js 14 dispatcher dashboard: live map + queue manager
apps/mobile            Expo (SDK 58) app — Student + Driver roles (own node_modules, see below)
apps/tracking-server   Live GPS tracking backend: Express + Socket.IO + Supabase Postgres
docs/GPS_TRACKING.md   Live GPS tracking: design, setup, CSV reload, what is/isn't verified
docs/VIDHU_TASKS.md    Task breakdown extracted from the blueprint
docs/CONTRACT.md       Proposed API/socket contract for the backend
```

**Live GPS tracking** (real driver-phone GPS, route-aware ETA, admin route setup) is documented in
[docs/GPS_TRACKING.md](docs/GPS_TRACKING.md). Try it locally without Supabase:
`npm run dev:local -w @transitlink/tracking-server` (needs `data/SafarSaathi_Bus_Schedule.csv`, which is
git-ignored because it contains drivers' phone numbers).

## Run
```bash
npm install
npm run dev:web      # http://localhost:3000 — runs on mock data, no backend needed
npm test             # shared logic tests
npm run build:web
```

Copy `apps/dispatcher-web/.env.example` to `.env.local` to switch to the live backend
(`NEXT_PUBLIC_DATA_SOURCE=live`).

### Mobile app
```bash
cd apps/mobile
npm install
npx expo start       # scan the QR code with Expo Go (Android/iOS)
```
`apps/mobile` is **not** an npm workspace: Expo SDK 58 needs React 19, Next.js 14 needs React 18, and one
workspace would install duplicate Reacts (a runtime crash). Metro reaches `packages/shared` via
`metro.config.js`; TypeScript via `tsconfig.json` paths.

**Works in Expo Go:** role picker, live tracking + ETA, queue (join/position/called), fallback modal, SOS,
local notifications, Google map on Android. Demo buttons trigger the last-bus workflow without leaving campus.

**Needs a development build** (`npx eas-cli@latest build --profile development`): background geofencing
(Expo Go has no background location) and remote FCM push (removed from Expo Go on Android in SDK 53).
For FCM also add your Firebase `google-services.json` and FCM V1 credentials in EAS.

For Google road routes on the phone, run the web app and set `EXPO_PUBLIC_WEB_URL` to your PC's **LAN IP**
(see `apps/mobile/.env.example`); the phone uses the web app's `/api/road-route` proxy.

## Design decisions
- **One `TransitDataSource` interface** (`packages/shared/src/source.ts`). The mock simulator emits Rahul's
  exact MQTT payload format; the live source talks Socket.io/REST. UI code never knows which one is active.
- **Zustand for telemetry, React Query for server records.** Telemetry is a high-frequency stream; tokens and
  routes are cacheable records with mutations (optimistic updates on dispatcher actions).
- **Animation outside React.** `MarkerMotion` interpolates each bus; the map's GeoJSON source is updated per
  frame directly, so React doesn't re-render 60×/s.
- **Network partition (§6):** the mock drops B-404 offline for 20 s every 90 s, then sends a
  `telemetry:batch`. The marker greys out ("No signal") and then replays the missed path in ≤ 3 s instead of teleporting.
- **Google Maps + Google Routes API for real roads.** With keys set, each route's stops are sent (once per
  session, cached server-side) to `computeRoutes`; the road polyline replaces the straight line, stops snap to
  the road, and mock buses drive along it. The call goes through `app/api/road-route` so the Routes key never
  reaches the browser. Google's terms forbid showing Routes data on a non-Google map, hence the Google map.
- **Keyless fallback:** without a Google key the app uses MapLibre + OpenFreeMap (straight-line mock routes),
  so anyone can run it without a billing account.

## Google Maps setup
1. Google Cloud Console → create a project → attach a billing account (free monthly credit covers dev use).
2. Enable **Maps JavaScript API** and **Routes API**.
3. Create two API keys (Credentials):
   - Browser key → restrict to *HTTP referrers* (`http://localhost:3000/*`, your deploy domain) and to Maps JavaScript API.
   - Server key → restrict to *Routes API* only (no referrer restriction; it's called from the server).
4. Copy `apps/dispatcher-web/.env.example` → `.env.local`, fill `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and
   `GOOGLE_ROUTES_API_KEY`, restart `npm run dev:web`. **Never commit `.env.local`** (it's git-ignored).

The map shows a status chip: "N/N routes on real roads", or the error if the Routes call failed.

## Known limitations
- Without Google keys, mock route polylines are straight lines between approximate Dehradun points.
- Stop coordinates are approximate; Google snaps them to the nearest road, which may be the wrong side of a
  divided road. Replace with surveyed stop locations from Siddhant's `stops` table.
- Routes with more than 10 intermediate stops are rejected by the proxy (Google bills those at a higher rate).
- ETA is a naive distance/speed estimate — a baseline to compare against a historical model later.
- No auth yet; the live source is written but untested until the backend exists.
