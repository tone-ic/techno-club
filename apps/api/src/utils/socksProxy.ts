import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import net from 'node:net'
import { Agent, Dispatcher, Pool, setGlobalDispatcher } from 'undici'
import type { buildConnector } from 'undici'
import { SocksClient } from 'socks'

/**
 * Optional SOCKS5 routing for the API server's outgoing HTTP(S) traffic.
 *
 * Env:
 *   SOCKS5_PROXIES      pipe-separated SOCKS5 URLs assigned persistently by user ID.
 *   SOCKS5_PROXIES_FILE file with one proxy per line; paths are relative to apps/api.
 *   SOCKS5_PROXY        optional default proxy for requests outside a user context.
 *   SOCKS5_PROXY_HOSTS  comma-separated host suffixes that go through the proxy.
 *   SOCKS5_PROXY_TIMEOUT_MS  proxy handshake timeout, default 30000
 */

const DEFAULT_PROXIED_HOSTS = ['huggingface.co', 'hf.space', 'gradio.live']
const userProxyContext = new AsyncLocalStorage<SocksProxyConfig>()

export interface SocksProxyConfig {
  host: string
  port: number
  userId?: string
  password?: string
}

export function parseSocksProxy(raw: string): SocksProxyConfig {
  const value = raw.trim()
  if (!value) throw new Error('SOCKS5 proxy URL is empty')

  // login:password@host:port (proxy-provider format)
  if (!value.includes('://') && value.includes('@')) {
    return parseSocksProxy(`socks5://${value}`)
  }

  // host:port:user:pass (common format of proxy providers)
  if (!value.includes('://')) {
    const [host, port, userId, ...rest] = value.split(':')
    if (!host || !Number(port)) throw new Error('SOCKS5 proxy must look like socks5://user:pass@host:port')
    return { host, port: Number(port), userId: userId || undefined, password: rest.length ? rest.join(':') : undefined }
  }

  const url = new URL(value)
  if (!/^socks5h?:$/i.test(url.protocol)) {
    throw new Error(`SOCKS5 proxy must use socks5:// or socks5h://, got ${url.protocol}`)
  }
  if (!url.hostname) throw new Error('SOCKS5 proxy URL is missing a hostname')
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port) || 1080,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  }
}

function readConfiguredProxies(): SocksProxyConfig[] {
  const values = (process.env.SOCKS5_PROXIES || '').split('|')
  const fileName = process.env.SOCKS5_PROXIES_FILE?.trim()
  if (fileName) {
    const apiRoot = path.resolve(__dirname, '..', '..')
    const filePath = path.resolve(apiRoot, fileName)
    let contents: string
    try {
      contents = readFileSync(filePath, 'utf8')
    } catch (error) {
      throw new Error(`Could not read SOCKS5_PROXIES_FILE at ${filePath}: ${(error as Error).message}`)
    }
    values.push(...contents.split(/\r?\n/))
  }
  return values.map((value) => value.trim()).filter(Boolean).map(parseSocksProxy)
}

function proxyKey(proxy: SocksProxyConfig): string {
  return `${proxy.host}:${proxy.port}:${proxy.userId ?? ''}:${proxy.password ?? ''}`
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

function makeAgent(proxy: SocksProxyConfig | null, timeoutMs: number): Agent {
  if (!proxy) return new Agent()

  const connector = makeSocksConnector(proxy, timeoutMs)
  return new Agent({
    factory: (origin, options) => new Pool(origin, {
      ...(options as object),
      connect: connector,
    }),
  })
}

export function socksProxyFingerprint(proxy: SocksProxyConfig): string {
  return createHash('sha256').update(proxyKey(proxy)).digest('hex')
}

function parseUserProxyMap(): Map<string, SocksProxyConfig> {
  const raw = process.env.SOCKS5_USER_PROXY_MAP || ''
  const result = new Map<string, SocksProxyConfig>()
  for (const entry of raw.split('|').map((value) => value.trim()).filter(Boolean)) {
    const separator = entry.indexOf('=')
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error('SOCKS5_USER_PROXY_MAP entries must look like supabase-user-id=socks5://host:port')
    }
    const userId = entry.slice(0, separator).trim()
    if (result.has(userId)) throw new Error(`Duplicate user in SOCKS5_USER_PROXY_MAP: ${userId}`)
    result.set(userId, parseSocksProxy(entry.slice(separator + 1)))
  }
  return result
}

export async function withUserSocksProxy<T>(
  userId: string,
  resolveAssignment: (proxyFingerprints: string[]) => Promise<string>,
  work: () => Promise<T>,
): Promise<T> {
  const proxies = readConfiguredProxies()
  const explicitAssignment = parseUserProxyMap().get(userId)
  let selected = explicitAssignment
  if (!selected && proxies.length) {
    const assignedFingerprint = await resolveAssignment(proxies.map(socksProxyFingerprint))
    selected = proxies.find((proxy) => socksProxyFingerprint(proxy) === assignedFingerprint)
    if (!selected) throw new Error('Assigned SOCKS5 proxy is missing from SOCKS5_PROXIES')
  }
  if (!selected) return work()
  return userProxyContext.run(selected, work)
}

export function maskProxy(proxy: SocksProxyConfig): string {
  return `${proxy.userId ? `${proxy.userId}:***@` : ''}${proxy.host}:${proxy.port}`
}

let installed = false

export function installSocksProxyFromEnv(): void {
  if (installed) return

  const proxies = readConfiguredProxies()
  const userProxyMap = parseUserProxyMap()
  const defaultProxy = process.env.SOCKS5_PROXY?.trim()
    ? parseSocksProxy(process.env.SOCKS5_PROXY)
    : null
  if (!proxies.length && !userProxyMap.size && !defaultProxy) return

  const rules = (process.env.SOCKS5_PROXY_HOSTS || DEFAULT_PROXIED_HOSTS.join(','))
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean)
  const timeoutMs = Number(process.env.SOCKS5_PROXY_TIMEOUT_MS || 30_000)
  const agents = new Map<string, Agent>()
  const directAgent = makeAgent(null, timeoutMs)

  const getAgent = (proxy: SocksProxyConfig | null): Agent => {
    if (!proxy) return directAgent
    const key = proxyKey(proxy)
    let agent = agents.get(key)
    if (!agent) {
      agent = makeAgent(proxy, timeoutMs)
      agents.set(key, agent)
    }
    return agent
  }

  class UserProxyDispatcher extends Dispatcher {
    dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
      const origin = options.origin ? new URL(options.origin) : null
      const proxy = origin && hostMatches(origin.hostname, rules)
        ? userProxyContext.getStore() ?? defaultProxy
        : null
      return getAgent(proxy).dispatch(options, handler)
    }

    close(): Promise<void>
    close(callback: () => void): void
    close(callback?: () => void): Promise<void> | void {
      const closing = Promise.all([directAgent, ...agents.values()].map((agent) => agent.close())).then(() => undefined)
      if (callback) {
        closing.then(callback)
        return
      }
      return closing
    }

    destroy(): Promise<void>
    destroy(error: Error | null): Promise<void>
    destroy(callback: () => void): void
    destroy(error: Error | null, callback: () => void): void
    destroy(errorOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
      const error = typeof errorOrCallback === 'function' ? null : errorOrCallback ?? null
      const done = typeof errorOrCallback === 'function' ? errorOrCallback : callback
      const destroying = Promise.all([directAgent, ...agents.values()].map((agent) => agent.destroy(error))).then(() => undefined)
      if (done) {
        destroying.then(done)
        return
      }
      return destroying
    }
  }

  setGlobalDispatcher(new UserProxyDispatcher())
  installed = true
  const configured = proxies.map(maskProxy)
  const mappedProxies = new Map([...userProxyMap.values()].map((proxy) => [proxyKey(proxy), proxy]))
  configured.push(...[...mappedProxies.values()].map((proxy) => `mapped:${maskProxy(proxy)}`))
  if (defaultProxy) configured.push(`default:${maskProxy(defaultProxy)}`)
  console.log(`[Proxy] SOCKS5 pool enabled (${configured.length} proxy entr${configured.length === 1 ? 'y' : 'ies'}) for: ${rules.join(', ')}`)
}
