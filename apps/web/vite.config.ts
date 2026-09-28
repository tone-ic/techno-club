import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import fs from 'fs'
import path from 'path'

const MUSIC_EXTENSIONS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac', '.webm'])

function musicManifest() {
  const musicDir = path.resolve(__dirname, 'public/music')
  const manifestPath = path.join(musicDir, 'manifest.json')

  function scanTracks() {
    if (!fs.existsSync(musicDir)) return []
    return fs.readdirSync(musicDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && MUSIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => {
        const fullPath = path.join(musicDir, entry.name)
        const stat = fs.statSync(fullPath)
        const version = `${Math.round(stat.mtimeMs)}-${stat.size}`
        const name = entry.name.replace(/\.[^.]+$/, '')
        return {
          src: `/music/${encodeURIComponent(entry.name)}?v=${version}`,
          name,
          size: stat.size,
          mtimeMs: Math.round(stat.mtimeMs),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }

  function manifestJson() {
    const tracks = scanTracks()
    return JSON.stringify({
      tracks,
      generatedAt: tracks.reduce((latest, track) => Math.max(latest, track.mtimeMs), 0),
    }, null, 2)
  }

  function writeManifest() {
    fs.mkdirSync(musicDir, { recursive: true })
    fs.writeFileSync(manifestPath, `${manifestJson()}\n`)
  }

  return {
    name: 'doorclub-music-manifest',
    buildStart() {
      writeManifest()
    },
    configureServer(server) {
      server.middlewares.use('/music/manifest.json', (_req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(manifestJson())
      })
    },
  }
}

export default defineConfig({
  plugins: [
    musicManifest(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registration is handled in src/main.tsx so the app can explicitly
      // check for a new worker on every launch instead of waiting for the
      // browser's (up to 24-hour) service-worker update interval.
      injectRegister: false,
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'DOOR//CLUB',
        short_name: 'DOOR//CLUB',
        description: 'Виртуальный техно-клуб',
        theme_color: '#1a1a2e',
        background_color: '#0d0d1a',
        display: 'fullscreen',
        orientation: 'portrait',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  server: {
    port: 5173,
    host: true,  // чтобы был доступен через LAN / Cloudflare Tunnel
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        // Разбиваем бандл: PlayCanvas отдельно, остальное отдельно
        manualChunks: {
          playcanvas: ['playcanvas'],
          livekit: ['livekit-client', '@livekit/components-react'],
          supabase: ['@supabase/supabase-js'],
          colyseus: ['colyseus.js'],
        },
      },
    },
  },
})
