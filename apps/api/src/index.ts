import './env'
import { installSocksProxyFromEnv } from './utils/socksProxy'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { livekitRouter } from './routes/livekit'
import { avatarRouter } from './routes/avatar'

installSocksProxyFromEnv()

const app = new Hono()
const PORT = Number(process.env.API_PORT || process.env.PORT) || 3001
const configuredClientOrigins = (process.env.CLIENT_URL?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [])
  .concat(['http://localhost:5173', 'http://127.0.0.1:5173'])
const clientOrigins = new Set(configuredClientOrigins)

function isPrivateDevHost(hostname: string) {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true
  const match = hostname.match(/^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/)
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31)
}

function resolveCorsOrigin(origin: string) {
  if (clientOrigins.has(origin)) return origin
  if (process.env.NODE_ENV === 'production') return undefined

  try {
    const url = new URL(origin)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && isPrivateDevHost(url.hostname)) {
      return origin
    }
  } catch {}

  return undefined
}

app.use('*', cors({
  origin: resolveCorsOrigin,
  allowMethods: ['GET', 'POST', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

app.get('/health', (c) => c.json({ status: 'ok', ts: Date.now() }))

app.route('/livekit', livekitRouter)
app.route('/avatar', avatarRouter)

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`✅ API listening on http://localhost:${PORT}`)
})
