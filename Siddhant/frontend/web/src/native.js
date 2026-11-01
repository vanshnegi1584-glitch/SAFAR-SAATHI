import { App } from '@capacitor/app'

// Only loaded inside the Android app (see main.jsx). The website never imports this file.
export function setupNative() {
  // Android back button: go back like the browser's back button; leave the app from the start page.
  App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack && location.pathname !== '/') history.back()
    else App.exitApp()
  })
}
