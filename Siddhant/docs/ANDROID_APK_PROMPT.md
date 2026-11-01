# Prompt: package the SafarSaathi web app as an Android APK (prototype)

Copy everything below the line into Claude Code, opened in `D:\SAFAR-SAATHI\Siddhant`.

---

## Goal

Package the existing SafarSaathi web app (`frontend/web`, Vite + React 19, react-router-dom 7, Supabase auth,
Leaflet maps) as an installable Android APK for a prototype demo. This is a **wrapper, not a rewrite**: the APK must
run the same React code, so every screen, feature, algorithm and route behaves exactly as on the website.
When the APK is built and tested, make it downloadable from a button on the website's landing page.

Use **Capacitor** (bundled web assets inside the APK). Do not rewrite in React Native, Flutter or Kotlin, and do not
use a Trusted Web Activity (that needs a public HTTPS site with Digital Asset Links, which we don't have yet).
Before starting, read `frontend/web/package.json`, `vite.config.js`, `src/api.js`, `src/live.js`, `src/supabase.js`,
`src/App.jsx`, `src/prefs.js`, `src/main.jsx`, `src/pages/Landing.jsx`, `src/pages/Staff.jsx` and `public/sw.js`.

## Hard rules: nothing about the app's behaviour changes

1. **Same UI.** Same pages, components, CSS (`index.css`, `theme.css`), icons, text and layout. Only add what Android
   strictly needs: safe-area padding for the status/navigation bars, and hiding the "Download app" button inside the APK.
2. **Same logic.** Do not change `liveMath.js`, `geo.js`, `routing.js`, `plans.js`, `outbox.js`, queueing, fallback,
   ETA, seat-count or SOS logic. `npm test` (liveMath tests) must pass unchanged.
3. **Same routes.** Keep `BrowserRouter` and every path exactly: `/`, `/live`, `/login`, `/settings`, `/passenger`,
   `/staff`, `/office`, `/office/analytics`, `/office/admin`, and the role guards (passenger / driver / conductor /
   dispatcher via `app_metadata.role`). Deep links and refreshes inside the APK must land on the same page.
4. **Same backend and database.** Same FastAPI endpoints (`/buses`, `/me/*`, `/routes`, `/stops`, `/announcements`,
   `/issues`, `/analytics`, `/planner`, the `/ws` WebSocket, …), same Supabase project, same `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY`. Only the **anon/publishable** key may go into the APK (it is public by design; Row Level
   Security protects the data). Never put the `service_role` key, `backend/.env` secrets or device tokens in the app.
   Do not change any backend route or database schema for this task.
5. **Web build must not break.** `npm run dev` and `npm run build` for the website behave exactly as before.

## Required changes (the minimum the APK needs)

### A. API and WebSocket base URL
Today `src/api.js` calls `fetch('/api' + path)` and `src/live.js` opens `ws://<location.host>/ws`; both rely on the
Vite dev proxy, which does not exist inside an APK. Add one optional variable:

- `VITE_API_BASE` — empty for the website (keep `/api` and the current `/ws` exactly as now);
  for the APK, the backend's full URL, e.g. `https://<backend-host>`.
- `api()` uses `${VITE_API_BASE}${path}` when set, otherwise `/api${path}`.
- `live.js` derives `wss://<host>/ws` (or `ws://` for `http://`) from `VITE_API_BASE` when set.
- Put the APK values in `frontend/web/.env.android` (git-ignored) plus a committed `.env.android.example`, and
  build with `vite build --mode android`.
- Make sure `.env.android` is actually ignored. Today `.gitignore` may only cover `.env.local`, so check it and add the
  file if it's missing.

### A2. Backend over the laptop's LAN IP (decided)
The phone reaches the backend running on the demo laptop over the local network, plain HTTP:
`VITE_API_BASE=http://192.168.137.1:8000`.

- **Network:** the phone joins the laptop's **Windows Mobile Hotspot**. Windows always gives the laptop
  `192.168.137.1` on that hotspot, so the address baked into the APK doesn't change between demos. Don't use the campus
  network IP (`172.20.x.x`): it comes from DHCP and can change, and campus Wi-Fi often stops devices from talking to each
  other. The hotspot shares the laptop's internet, which the phone still needs for Supabase, map tiles and OSRM.
- **Make the IP a build setting, not code:** read it only from `.env.android`. If the IP ever changes, the fix is to
  edit that one line and rebuild.
- **Backend and website must listen on the LAN:** `demo/start-demo.ps1` (in `D:\SAFAR-SAATHI`) starts the backend with
  `--host 127.0.0.1 --port 8000` and the website with `--host 127.0.0.1 --port 5173`, so other devices can't reach
  them. Add an opt-in `-Lan` switch that binds **only those two** to `0.0.0.0`. Leave the default as `127.0.0.1`, and
  leave the vision bridge (8010), GPS server (4000) and camera agent on localhost. Print the phone URLs when `-Lan` is on.
- **Windows Firewall:** inbound TCP 8000 and 5173 must be allowed on the hotspot network. Don't change firewall
  settings yourself. Tell me the exact rule to add, and I'll add it.
- **Cleartext HTTP, for this one host only:** add `res/xml/network_security_config.xml` that permits cleartext for
  `192.168.137.1` and nothing else, referenced from the manifest. Never set `usesCleartextTraffic="true"` app-wide.
- **Mixed content:** with `androidScheme: 'https'`, the WebView blocks `http://` calls from the `https://localhost` page.
  Use `server.androidScheme: 'http'` instead, then **verify** that `window.isSecureContext` is still `true` inside the
  APK (geolocation depends on it). Only if it isn't, go back to `https` with `android.allowMixedContent: true`, and tell
  me which one you used and why.
- **Same backend, no changes:** CORS already allows `*`. Confirm the REST calls and the `ws://192.168.137.1:8000/ws`
  live updates work from the APK.
- **Limitation to state in the report:** this APK works only on the laptop's hotspot while the demo is running. Away
  from it, it shows the existing offline banner and errors. A deployed HTTPS backend later needs only a new
  `VITE_API_BASE` and a rebuild.

### B. Capacitor setup (`frontend/web`)
- Add `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, and only these plugins: `@capacitor/app` (Android back
  button → `history.back()`, exit on `/`), `@capacitor/geolocation` (only if WebView geolocation proves unreliable),
  `@capacitor/local-notifications` (see D). Pin exact versions. No other plugins.
- `capacitor.config.ts`: `appId: in.ac.gehu.safarsaathi`, `appName: SafarSaathi`, `webDir: dist`,
  `server.androidScheme: https` (keeps `window.isSecureContext` true, so the existing geolocation checks still pass).
- Do not register `public/sw.js` inside the native app (assets are already local); keep it for the website.
  Detect with `Capacitor.isNativePlatform()`.
- Generate the launcher icon and splash from the existing `public/icon-512.png`, colour `#1e3a8a` (same as the manifest).

### C. Android permissions — only what existing features use
- `INTERNET`, `ACCESS_NETWORK_STATE` (offline banner).
- `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` (Staff GPS sharing, Settings home stop, missed-bus fallback),
  requested at the moment the feature is used, exactly like the website.
- `POST_NOTIFICATIONS` (Android 13+) only when the user turns on notifications in Settings.
- `WAKE_LOCK` only if needed for the existing screen wake lock in `Staff.jsx`.
- **Not allowed:** background location, camera, microphone, contacts, SMS, storage, `REQUEST_INSTALL_PACKAGES`,
  accessibility services, overlay, boot receivers. Staff GPS stays foreground-only, the same as the website.

### D. Notifications
The browser `Notification` API in `src/prefs.js` does not work in an Android WebView. Inside the APK only, route
`notify()` / `enableNotifications()` through `@capacitor/local-notifications` with the same title, body and on/off
preference. The website keeps the current code path. Same triggers, same text.

### E. Camera agent
`VITE_CAMERA_AGENT_URL` is for the bus computer only. Leave it unset in the APK build so `CameraAgentCard` behaves as on
any phone browser.

## Play Protect: build it to pass a scan cleanly

We cannot and must not try to stop Play Protect from scanning; every sideloaded APK is scanned. The goal is that the
scan finds nothing suspicious:

- Build a **release** APK signed with our own upload keystore (`keytool`, RSA 2048+). Never ship a debug-signed APK.
  Keep the keystore and its passwords **outside the repo** (git-ignore `*.jks`, `*.keystore`, `keystore.properties`);
  tell me where it is so the team can sign every future version with the same key.
- `targetSdkVersion` and `compileSdkVersion` = the latest stable Android API supported by the Capacitor version used;
  `minSdkVersion` 24 or higher.
- No dynamic code loading, no downloaded executable code, no hidden or obfuscated network endpoints, no ad or
  tracking SDKs, `android:debuggable` false, `allowBackup` false (sessions stay on the phone).
- Only the permissions listed in C.
- Stable `versionCode` / `versionName` (start at 1 / 0.1.0-prototype) and increment on every rebuild.
- After building, run `apksigner verify --print-certs` and record the SHA-256 of the APK file.
- Tell me (do not do it yourself) that if Play Protect still shows "unrecognised app" on test phones, the team can
  submit the APK for review through Google's Play Protect appeal process, and check whether Google's Android developer
  verification requirement applies in our region by the demo date.

## APK size: affordable

Target **under 10 MB** for the universal release APK.
- Enable R8: `minifyEnabled true`, `shrinkResources true` in the release build type.
- Ship only `dist/` (no source maps in the APK: `build.sourcemap: false` in android mode); no unused fonts or images.
- Map tiles (OpenStreetMap) and routing (OSRM) stay online, the same as the website — do not bundle tiles.
- Report the final APK size and the size of `dist/`. If it is over 10 MB, show me what takes the space before trimming.

## Download from the landing page

- Build script `npm run android:apk` (in `frontend/web`): `vite build --mode android` → `npx cap sync android` →
  `gradlew assembleRelease` → copy the signed APK to `public/downloads/SafarSaathi-<versionName>.apk` and write
  `public/downloads/latest.json` with `{ version, versionCode, sizeBytes, sha256, builtAt }`.
- Git-ignore `public/downloads/*.apk` (do not commit binaries).
- In `src/pages/Landing.jsx`, add a **"Download Android app (prototype)"** button in the hero next to "Log in", in the
  same `btn` styling. It reads `latest.json` and shows version and size (for example "v0.1.0 · 6.2 MB"); it links to
  the APK with the `download` attribute. Hide the button when `latest.json` is missing and inside the APK itself.
- Under the button, one small line: "Android 7+. Your phone may ask you to allow installs from this browser."
- Confirm the file is served with `Content-Type: application/vnd.android.package-archive` by both `vite preview` and
  the dev server; if not, fix it in `vite.config.js`.

## Test plan (do this before calling it done; report results honestly)

1. `npm test` and `npm run build` pass for the website; the website looks and behaves as before.
2. Start the demo with `-Lan`, connect a real Android phone to the laptop hotspot, open
   `http://192.168.137.1:5173`, and download the APK from the landing page. Chrome may warn that the download is
   insecure, because it is served over HTTP. Report exactly what it shows and what the user has to tap. Install it, and
   also test the same APK on an emulator at minSdk running on this laptop. The emulator can normally reach
   `192.168.137.1` because it's one of the host's own addresses. Confirm that, and don't build a separate emulator APK.
3. Walk every route with each role (passenger, driver/conductor, dispatcher test accounts from the seed):
   login/signup, Live buses map and seat counts updating over the WebSocket, join/leave queue, missed-bus fallback with
   location, Staff GPS sharing and SOS long press, Office fleet/incidents/announcements, Analytics, Admin, Settings
   (home stop, notifications), offline banner with airplane mode, Android back button, app restart keeps the session.
4. Side by side with the website, the same account sees the same buses, seats, queue position and announcements.
5. Play Protect: install on a phone with Play Protect on and report exactly what it shows.
6. Report: APK size, versionCode/versionName, SHA-256, permissions from `aapt dump permissions`, and any feature that
   behaves differently in the APK, with the reason. Do not hide failures.

## Out of scope
Publishing on the Play Store, iOS, push notifications from the server, background GPS, backend or database changes.
