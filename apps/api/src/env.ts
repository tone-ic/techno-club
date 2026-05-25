import fs from 'node:fs'
import path from 'node:path'

function parseEnvLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
  const eq = normalized.indexOf('=')
  if (eq === -1) return null

  const key = normalized.slice(0, eq).trim()
  let value = normalized.slice(eq + 1).trim()

  if (!key) return null
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }

  return { key, value }
}

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return

  const values: Record<string, string> = {}
  const content = fs.readFileSync(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    values[parsed.key] = parsed.value
  }

  for (const [key, value] of Object.entries(values)) {
    process.env[key] ??= value
  }
}

loadEnvFile(path.resolve(__dirname, '..', '.env'))
loadEnvFile(path.resolve(__dirname, '..', '..', '..', '.env'))
