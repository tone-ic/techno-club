/**
 * Sanity check for SOCKS5_PROXY:  pnpm --filter api proxy:check
 * Prints the exit IP without and with the proxy, then probes the Hugging Face hosts.
 */
import '../src/env'
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
  if (!process.env.SOCKS5_PROXY) {
    console.error('SOCKS5_PROXY is not set in .env')
    process.exit(1)
  }

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
