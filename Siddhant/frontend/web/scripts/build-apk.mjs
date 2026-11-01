// npm run android:apk — build the signed Android APK and publish it to public/downloads for the landing page.
// Needs JDK 21+ (JAVA_HOME, or Android Studio's bundled one) and the Android SDK (ANDROID_HOME or the default path).
import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const web = resolve(import.meta.dirname, '..')
const android = join(web, 'android')
const versionFile = join(android, 'app', 'version.properties')
const win = process.platform === 'win32'

function fail(message) {
  console.error(`\nandroid:apk: ${message}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const line = [cmd, ...args].join(' ')
  console.log(`\n> ${line}`)
  execSync(line, { stdio: 'inherit', ...opts })
}

function firstExisting(paths) {
  return paths.find((p) => p && existsSync(p))
}

const env = { ...process.env }
env.JAVA_HOME = firstExisting([
  env.JAVA_HOME,
  'C:/Program Files/Android/Android Studio/jbr',
  'D:/flutter/jbr', // Android Studio installed on D: on the demo laptop
  '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
])
if (!env.JAVA_HOME) fail('No JDK found. Set JAVA_HOME to a JDK 21+ (Android Studio ships one in its jbr folder).')
env.ANDROID_HOME = firstExisting([
  env.ANDROID_HOME,
  env.ANDROID_SDK_ROOT,
  env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Android', 'Sdk'),
  join(homedir(), 'Library', 'Android', 'sdk'),
  join(homedir(), 'Android', 'Sdk'),
])
if (!env.ANDROID_HOME) fail('No Android SDK found. Set ANDROID_HOME.')

const props = Object.fromEntries(readFileSync(versionFile, 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#')).map((l) => l.split('=').map((s) => s.trim())))
const versionCode = Number(props.versionCode)
const version = props.versionName
if (!Number.isInteger(versionCode) || !version) fail(`Bad ${versionFile}`)

run('npx', ['vite', 'build', '--mode', 'android'], { cwd: web, env })
if (existsSync(join(web, 'dist', 'downloads'))) fail('dist/downloads must not go into the APK')
run('npx', ['cap', 'sync', 'android'], { cwd: web, env })
run(win ? `"${join(android, 'gradlew.bat')}"` : './gradlew', ['clean', 'assembleRelease'], { cwd: android, env })

const apk = join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
if (!existsSync(apk)) {
  fail('No signed APK was produced. The upload key settings are missing: see android/README.md ("Signing").')
}

// Check the signature with the SDK's apksigner and refuse anything signed with a debug key.
const buildTools = join(env.ANDROID_HOME, 'build-tools')
const latest = readdirSync(buildTools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
const apksigner = join(buildTools, latest, 'lib', 'apksigner.jar')
const certs = execFileSync(join(env.JAVA_HOME, 'bin', 'java'), ['-jar', apksigner, 'verify', '--verbose', '--print-certs', apk])
  .toString()
console.log(`\n${certs}`)
if (/CN=Android Debug/.test(certs)) fail('The APK is signed with a debug key. Refusing to publish it.')

const bytes = readFileSync(apk)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const downloads = join(web, 'public', 'downloads')
mkdirSync(downloads, { recursive: true })
for (const old of readdirSync(downloads).filter((f) => f.endsWith('.apk'))) rmSync(join(downloads, old))
const name = `SafarSaathi-${version}.apk`
copyFileSync(apk, join(downloads, name))
const info = { version, versionCode, sizeBytes: statSync(apk).size, sha256, builtAt: new Date().toISOString() }
writeFileSync(join(downloads, 'latest.json'), `${JSON.stringify(info, null, 2)}\n`)

// The next build gets a higher versionCode (Android won't install an update with the same or a lower one).
const [major, minor, patch] = version.split('-')[0].split('.').map(Number)
const suffix = version.includes('-') ? version.slice(version.indexOf('-')) : ''
writeFileSync(versionFile, readFileSync(versionFile, 'utf8')
  .replace(/^versionCode=.*$/m, `versionCode=${versionCode + 1}`)
  .replace(/^versionName=.*$/m, `versionName=${major}.${minor}.${patch + 1}${suffix}`))

console.log(`\nPublished public/downloads/${name}`)
console.log(`  version ${version} (versionCode ${versionCode}), ${(info.sizeBytes / 1048576).toFixed(2)} MB`)
console.log(`  SHA-256 ${sha256}`)
