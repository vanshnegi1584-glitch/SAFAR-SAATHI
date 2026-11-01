import { Capacitor } from '@capacitor/core'
import { useSyncExternalStore } from 'react'

// Device-level UI preferences (not account data), kept in localStorage.
const KEY = 'safarsaathi.prefs'
const DEFAULTS = { theme: 'system', largeText: false, notifications: false, sounds: true }

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return { ...DEFAULTS }
  }
}

let prefs = read()
const listeners = new Set()
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

export function applyPrefs() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && darkQuery.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.classList.toggle('large-text', prefs.largeText)
}
darkQuery.addEventListener('change', applyPrefs)

export function setPref(key, value) {
  prefs = { ...prefs, [key]: value }
  localStorage.setItem(KEY, JSON.stringify(prefs))
  applyPrefs()
  listeners.forEach((l) => l())
}

export function usePrefs() {
  return useSyncExternalStore((l) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }, () => prefs)
}

// Android's WebView has no Notification API, so the Android app shows the same alerts through the phone's own
// notifications instead. The website never loads this plugin.
const native = Capacitor.isNativePlatform()
// Holds the module, not the plugin: a Capacitor plugin answers any property, `then` included, so a promise can't
// resolve to one.
const nativeAlerts = native ? import('@capacitor/local-notifications') : null

export const notificationsSupported = native || ('Notification' in window && window.isSecureContext)

async function requestPermission() {
  if (native) return (await (await nativeAlerts).LocalNotifications.requestPermissions()).display
  return Notification.permission === 'granted' ? 'granted' : Notification.requestPermission()
}

export async function enableNotifications() {
  if (!notificationsSupported) return false
  const result = await requestPermission()
  setPref('notifications', result === 'granted')
  return result === 'granted'
}

// Same title replaces the earlier alert, like the website's `tag: title`.
function alertId(title) {
  let h = 0
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) | 0
  return h & 0x7fffffff
}

export function notify(title, body) {
  if (prefs.notifications && native) {
    nativeAlerts
      .then((m) => m.LocalNotifications.schedule({ notifications: [{ id: alertId(title), title, body, isExactNotification: false }] }))
      .catch(() => {})
  } else if (prefs.notifications && notificationsSupported && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.svg', tag: title })
  }
  beep()
}

let audio
export function beep() {
  if (!prefs.sounds) return
  try {
    audio ??= new AudioContext()
    const o = audio.createOscillator()
    const g = audio.createGain()
    o.frequency.value = 880
    g.gain.setValueAtTime(0.15, audio.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35)
    o.connect(g).connect(audio.destination)
    o.start()
    o.stop(audio.currentTime + 0.35)
  } catch {
    // Audio can be blocked until the user interacts with the page; a missed beep is fine.
  }
}
