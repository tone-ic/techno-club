import tls from 'node:tls'
import net from 'node:net'
import { Agent, Pool, setGlobalDispatcher } from 'undici'
import type { buildConnector } from 'undici'
import { SocksClient } from 'socks'

/**
 * Optional SOCKS5 routing for the API server's outgoing HTTP(S) traffic.
 *
 * Node's built-in `fetch` (and therefore @gradio/client, supabase-js, etc.) does not
 * understand proxies. We install a global undici dispatcher that opens the TCP connection
 * to selected hosts through a SOCKS5 proxy and leaves every other host untouched.
 *
 * Env:
 *   SOCKS5_PROXY        socks5://user:pass@host:1080  (also socks5h://, or host:port[:user:pass])
 *   SOCKS5_PROXY_HOSTS  comma-separated host suffixes that go through the proxy.
 *                       Default: huggingface.co,hf.space,gradio.live
 *                       Use "*" to send everything (KIE, Supabase, ...) through the proxy.
 *   SOCKS5_PROXY_TIMEOUT_MS  proxy handshake timeout, default 30000
 */

const DEFAULT_PROXIED_HOSTS = ['huggingface.co', 'hf.space', 'gradio.live']

export interface SocksProxyConfig {
  host: string
  port: number
  userId?: string
  password?: string
}

export function parseSocksProxy(raw: string): SocksProxyConfig {
  const value = raw.trim()
  if (!value) throw new Error('SOCKS5_PROXY is empty')

  // host:port:user:pass  (common format of proxy providers)
  if (!value.includes('://')) {
    const [host, port, userId, ...rest] = value.split(':')
    if (!host || !Number(port)) throw new Error('SOCKS5_PROXY must look like socks5://user:pass@host:port')
    return { host, port: Number(port), userId: userId || undefined, password: rest.length ? rest.join(':') : undefined }
  }

  const url = new URL(value)
  if (!/^socks5h?:$/i.test(url.protocol)) {
    throw new Error(`SOCKS5_PROXY must use socks5:// or socks5h://, got ${url.protocol}`)
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port) || 1080,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  }
}

function makeSocksConnector(proxy: SocksProxyConfig, timeoutMs: number): buildConnector.connector {
  return (opts, callback) => {
    const isTls = opts.protocol === 'https:'
    const port = Number(opts.port) || (isTls ? 443 : 80)
    // Passing the hostname (not a resolved IP) makes the proxy resolve DNS = socks5h behaviour.
    const hostname = opts.hostname.replace(/^\[|\]$/g, '')

    SocksClient.createConnection({
      proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.userId, password: proxy.password },
      command: 'connect',
      destination: { host: hostname, port },
      timeout: timeoutMs,
    })
      .then(({ socket }) => {
        if (!isTls) {
          callback(null, socket)
          return
        }
        const servername = opts.servername || (net.isIP(hostname) ? undefined : hostname)
        const tlsSocket = tls.connect({ socket, servername, ALPNProtocols: ['http/1.1'] })
        tlsSocket.once('secureConnect', () => callback(null, tlsSocket))
        tlsSocket.once('error', (error) => callback(error, null))
      })
      .catch((error: Error) => callback(error, null))
  }
}

function hostMatches(hostname: string, rules: string[]): boolean {
  const host = hostname.toLowerCase()
  return rules.some((rule) => rule === '*' || host === rule || host.endsWith(`.${rule}`))
}

export function maskProxy(proxy: SocksProxyConfig): string {
  return `${proxy.userId ? `${proxy.userId}:***@` : ''}${proxy.host}:${proxy.port}`
}

let installed = false

export function installSocksProxyFromEnv(): void {
  const raw = process.env.SOCKS5_PROXY?.trim()
  if (!raw || installed) return

  const proxy = parseSocksProxy(raw)
  const rules = (process.env.SOCKS5_PROXY_HOSTS || DEFAULT_PROXIED_HOSTS.join(','))
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean)
  const timeoutMs = Number(process.env.SOCKS5_PROXY_TIMEOUT_MS || 30_000)
  const connector = makeSocksConnector(proxy, timeoutMs)

  // One connection pool per origin; only origins that match the rules get the SOCKS connector.
  const agent = new Agent({
    factory: (origin, options) => {
      const hostname = new URL(String(origin)).hostname
      return new Pool(origin, {
        ...(options as object),
        ...(hostMatches(hostname, rules) ? { connect: connector } : {}),
      })
    },
  })

  setGlobalDispatcher(agent)
  installed = true
  console.log(`[Proxy] SOCKS5 ${maskProxy(proxy)} enabled for: ${rules.join(', ')}`)
}
