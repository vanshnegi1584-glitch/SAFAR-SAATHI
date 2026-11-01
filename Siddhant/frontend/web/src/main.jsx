import { Capacitor } from '@capacitor/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './theme.css'
import App from './App.jsx'
import { applyPrefs } from './prefs'

applyPrefs()

// Offline app shell. Dev builds skip it so Vite's hot reload isn't served from cache, and the Android app skips it
// because its files are already on the phone.
if (Capacitor.isNativePlatform()) {
  import('./native').then((m) => m.setupNative())
} else if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
