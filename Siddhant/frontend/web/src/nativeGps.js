import { registerPlugin } from '@capacitor/core'

// Driver GPS in the Android app only. A WebView stops getting GPS when the screen is off or the driver switches
// apps; this plugin keeps it coming through a foreground service with an ongoing notification. It uses the same
// "while using the app" location permission as the website, never background location.
const BackgroundGeolocation = registerPlugin('BackgroundGeolocation')

// Same shape as the browser's GeolocationPositionError, so Staff.jsx handles both alike.
const PERMISSION_DENIED = 1
function positionError(err) {
  const denied = err.code === 'NOT_AUTHORIZED' && /permission/i.test(err.message)
  return { code: denied ? PERMISSION_DENIED : 2, PERMISSION_DENIED, message: err.message }
}

/** Like navigator.geolocation.watchPosition, but keeps going in the background. Returns a stop function. */
export function watchDriverPosition(onPosition, onError) {
  let id = null
  let stopped = false
  // Ask for notifications first: Android 13+ hides the ongoing notification without them, and doesn't show it
  // later if they're allowed after sharing started. Sharing works whatever the driver answers, and starts anyway
  // if there's no answer within 20 s.
  const notifications = import('@capacitor/local-notifications')
    .then((m) => m.LocalNotifications.requestPermissions())
    .catch(() => {})
  Promise.race([notifications, new Promise((resolve) => setTimeout(resolve, 20000))])
    .then(() => stopped ? null : BackgroundGeolocation.addWatcher({
      backgroundTitle: 'Sharing your bus location',
      backgroundMessage: 'Students can see your bus. Open SafarSaathi and tap Stop sharing to end.',
      requestPermissions: true,
      stale: false,
    }, (loc, err) => {
      if (err) return onError(positionError(err))
      if (loc) onPosition({ coords: { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, speed: loc.speed } })
    }))
    .then((watcher) => {
      if (watcher && stopped) BackgroundGeolocation.removeWatcher({ id: watcher })
      else if (watcher) id = watcher
    })
    .catch((err) => onError(positionError(err)))
  return () => {
    stopped = true
    if (id) BackgroundGeolocation.removeWatcher({ id })
  }
}
