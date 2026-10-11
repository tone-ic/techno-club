/**
 * Sanity check for SOCKS5_PROXY:  pnpm --filter api proxy:check
 * Prints the exit IP without and with the proxy, then probes the Hugging Face hosts.
 */
import '../src/env'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { installSocksProxyFromEnv } from '../src/utils/socksProxy'

async function ip(label: string) {
  try {
    const response = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(20_000) })
    console.log(`${label}:`.padEnd(22), ((await response.json()) as { ip: string }).ip)
  } catch (error) {
    const cause = (error as { cause?: Error }).cause
    console.log(`${label}:`.padEnd(22), `FAIL (${cause?.message || (error as Error).message})`)
  }
}

async function probe(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    console.log(`  ${response.status} ${url}`)
  } catch (error) {
    const cause = (error as { cause?: Error }).cause
    console.log(`  FAIL ${url} -> ${cause?.message || (error as Error).message}`)
  }
}

async function main() {
  const hasProxyPool = Boolean(process.env.SOCKS5_PROXIES?.trim() || process.env.SOCKS5_PROXIES_FILE?.trim())
  const defaultProxy = process.env.SOCKS5_PROXY?.trim()
  let proxy = defaultProxy || process.env.SOCKS5_PROXIES?.split('|').map((value) => value.trim()).find(Boolean)
  if (!proxy && process.env.SOCKS5_PROXIES_FILE?.trim()) {
    const apiRoot = path.resolve(__dirname, '..')
    const filePath = path.resolve(apiRoot, process.env.SOCKS5_PROXIES_FILE.trim())
    proxy = readFileSync(filePath, 'utf8').split(/\r?\n/).map((value) => value.trim()).find(Boolean)
  }
  if (!proxy) {
    console.error('SOCKS5_PROXY, SOCKS5_PROXIES, or SOCKS5_PROXIES_FILE is not set/configured')
    process.exit(1)
  }

  // This standalone diagnostic checks the default proxy or the first proxy in the pool.
  process.env.SOCKS5_PROXY = proxy
  delete process.env.SOCKS5_PROXIES
  delete process.env.SOCKS5_PROXIES_FILE
  delete process.env.SOCKS5_USER_PROXY_MAP
  if (hasProxyPool && !defaultProxy) console.log('Checking the first proxy in the configured pool')

  await ip('direct IP')

  // Route api.ipify.org through the proxy too, only for this check.
  const rules = process.env.SOCKS5_PROXY_HOSTS || 'huggingface.co,hf.space,gradio.live'
  process.env.SOCKS5_PROXY_HOSTS = `${rules},ipify.org`
  installSocksProxyFromEnv()

  await ip('IP via SOCKS5')
  console.log('Hugging Face through the proxy:')
  await probe('https://huggingface.co/api/spaces/microsoft/TRELLIS.2')
  await probe('https://microsoft-trellis-2.hf.space/config')
}

main().then(() => process.exit(0), (error) => {
  console.error(error)
  process.exit(1)
})
