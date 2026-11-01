# SafarSaathi Android app (prototype)

The APK is the same React web app (`frontend/web/src`) packaged with [Capacitor](https://capacitorjs.com). The web
files are bundled inside the APK; it talks to the same FastAPI backend and Supabase project as the website.

## Build

```
cd frontend/web
copy .env.android.example .env.android     # once; set VITE_API_BASE
npm run android:apk
```

This runs `vite build --mode android`, `npx cap sync android` and `gradlew assembleRelease`, checks the signature, then
copies the APK to `public/downloads/SafarSaathi-<version>.apk` and writes `public/downloads/latest.json`, which the
landing page's "Download Android app" button reads. APKs are not committed.

Needs a JDK 21 or newer (`JAVA_HOME`, or Android Studio's bundled `jbr`) and the Android SDK (`ANDROID_HOME`, or
the default `%LOCALAPPDATA%\Android\Sdk`).

## Version

`app/version.properties` holds the version the next build gets. `npm run android:apk` raises `versionCode` and the
patch number of `versionName` after every successful build, because Android only installs an update over an older
`versionCode`. Commit the file after publishing a build.

## Signing

Release APKs are signed with the team's upload key, which is never in the repo. Gradle reads
`%USERPROFILE%\.safarsaathi\keystore.properties` (or the file named in `SAFARSAATHI_KEYSTORE_PROPERTIES`):

```
storeFile=C:/Users/<you>/.safarsaathi/safarsaathi-upload.jks
storePassword=...
keyAlias=safarsaathi-upload
keyPassword=...
```

Every future version must be signed with the same key, or phones refuse to install it as an update. Keep a backup of
the `.jks` file and its password somewhere safe and private. Without the key settings the release build comes out unsigned
and `npm run android:apk` stops. It never falls back to a debug key.

## Backend address

`VITE_API_BASE` in `.env.android` is the backend as the phone sees it. For the demo that is the laptop on its Windows
Mobile Hotspot, `http://192.168.137.1:8000` (start the demo with `demo\start-demo.ps1 -Lan`). Plain HTTP is allowed for
that one host only, in `app/src/main/res/xml/network_security_config.xml`. If the address changes, change it there too.
Once the backend has an HTTPS address, set it in `.env.android` and rebuild; the cleartext exception is then no longer needed.

## Driver GPS with the screen off

On the website, a driver's phone stops sending GPS when the screen turns off. In the app, "Share live location"
on the Staff page uses `@capacitor-community/background-geolocation` (`src/nativeGps.js`): a foreground service
that keeps sending while the phone is locked or another app is open, with an ongoing "Sharing your bus location"
notification. It needs only the "while using the app" location permission, never "Allow all the time". "Stop
sharing" ends it. The plugin's service is overridden to `exported="false"` in `AndroidManifest.xml`.

`app/proguard-rules.pro` keeps Capacitor's annotations: without that, R8 strips them and every Capacitor
permission request (notifications, driver GPS) hangs without showing a dialog.

## Icons

Launcher icons and splash images in `app/src/main/res` were generated from `public/icon-512.png` on the
brand blue `#1e3a8a`. The notification icon is `drawable/ic_stat_safarsaathi.xml`, the bus from `favicon.svg`.
