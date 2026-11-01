import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const backend = process.env.SAFAR_API || 'http://localhost:8000'

// Vite sends .apk files with an empty Content-Type; phones need this one to offer to install the download.
function serveApk(dir) {
  return (req, res, next) => {
    const name = /^\/downloads\/([\w.-]+\.apk)$/.exec(req.url.split('?')[0])?.[1]
    const file = name && resolve(dir, name)
    if (!file || !existsSync(file)) return next()
    res.setHeader('Content-Type', 'application/vnd.android.package-archive')
    res.setHeader('Content-Length', statSync(file).size)
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).pipe(res)
  }
}

const apkDownloads = {
  name: 'apk-downloads',
  configureServer(server) {
    server.middlewares.use(serveApk(resolve(server.config.publicDir, 'downloads')))
  },
  configurePreviewServer(server) {
    server.middlewares.use(serveApk(resolve(server.config.root, server.config.build.outDir, 'downloads')))
  },
}

// `vite build --mode android` builds the web files for the APK: no source maps, and not public/downloads (the
// website's copy of earlier APKs) inside the new APK.
const androidOnly = {
  name: 'android-skip-downloads',
  apply: 'build',
  closeBundle() {
    rmSync(resolve(this.environment?.config.build.outDir ?? 'dist', 'downloads'), { recursive: true, force: true })
  },
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), apkDownloads, mode === 'android' && androidOnly],
  build: { sourcemap: false },
  server: {
    host: true,
    proxy: {
      '/api': { target: backend, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
}))
