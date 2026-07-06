import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createClient } from '@supabase/supabase-js'
import type { User } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { createHmac, createPublicKey, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { splitPngIntoVerticalThirds } from '../utils/pngCrop'

export const avatarRouter = new Hono()
const requireFromHere = createRequire(__filename)

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const TRELLIS_STYLE = 'photo_preserving_avatar'
const TRELLIS_MAX_TEXTURE_SIZE = 2048
const TRELLIS_MAX_TRIANGLES = 300000
const TRELLIS_RANDOMIZE_SEED = true
const MAX_TRELLIS_SEED = 2_147_483_647
const PIXAL3D_TEXTURE_SIZE = numberFromEnv('TRELLIS_TEXTURE_SIZE', numberFromEnv('PIXAL3D_TEXTURE_SIZE', 2048))
const PIXAL3D_DECIMATION_TARGET = numberFromEnv('TRELLIS_DECIMATION_TARGET', numberFromEnv('PIXAL3D_DECIMATION_TARGET', 300_000))
const PIXAL3D_RANDOMIZE_SEED = true
const MAX_PIXAL3D_SEED = 2_147_483_647
const MAX_IMAGE_DATA_URL_BYTES = 7_000_000
const MAX_MODEL_UPLOAD_BYTES = numberFromEnv('MAX_AVATAR_MODEL_UPLOAD_BYTES', 45_000_000)
const AVATAR_GENERATION_JOB_TTL_MS = Number(process.env.AVATAR_GENERATION_JOB_TTL_MS || 15 * 60_000)
const AVATAR_GENERATION_ACTIVE_TTL_MS = Number(process.env.AVATAR_GENERATION_ACTIVE_TTL_MS || 3 * 60 * 60_000)
const HF_CONNECT_TIMEOUT_MS = 45_000
const HF_PREPROCESS_TIMEOUT_MS = 90_000
const HF_GENERATE_TIMEOUT_MS = 300_000
const KIE_API_BASE_URL = process.env.KIE_API_BASE_URL || 'https://api.kie.ai'
const KIE_FILE_UPLOAD_BASE_URL = process.env.KIE_FILE_UPLOAD_BASE_URL || 'https://kieai.redpandaai.co'
const KIE_IMAGE_PROMPT = process.env.KIE_IMAGE_PROMPT ||
  'сделай персонажа на фото без фона (на черном фоне) для последующего создания 3д модели (сохрани максимальную идентичность , не меняй внешность (одежду, черты тела и лица)). Персонаж должен быть в полный рост от головы до обуви, руки и кисти должны полностью помещаться в кадр. Если фото персонажа не видно полностью, дополни фото до полного роста и убери телефон из рук (если он имеется). Остальные аксессуары (сумка, часы, очки, украшения, головной убор) должны сохраниться с исходного фото. Руки должны быть в спокойном опущенном состоянии, слегка приподняты для лучшего последующего определения 3д модели. Лицо и взгляд персонажа должны быть направлены вперед'
const KIE_IMAGE_ASPECT_RATIO = process.env.KIE_IMAGE_ASPECT_RATIO || '9:16'
const KIE_CREATE_TIMEOUT_MS = Number(process.env.KIE_CREATE_TIMEOUT_MS || 45_000)
const KIE_POLL_TIMEOUT_MS = Number(process.env.KIE_POLL_TIMEOUT_MS || 900_000)
const KIE_DOWNLOAD_TIMEOUT_MS = Number(process.env.KIE_DOWNLOAD_TIMEOUT_MS || 90_000)
const AVATAR_MODELS_BUCKET = process.env.SUPABASE_AVATAR_MODELS_BUCKET || 'avatar-models'
const TRELLIS_COMMUNITY_SPACE_ID = 'trellis-community/TRELLIS'
const PIXAL3D_SERVER_SPACE_ID = 'TencentARC/Pixal3D-Server'
const PIXAL3D_GRADIO_LIVE_HOST_SUFFIX = '.gradio.live'
const HF_PIXAL3D_SPACE_ID = process.env.HF_TRELLIS_SPACE_ID || process.env.HF_PIXAL3D_SPACE_ID || TRELLIS_COMMUNITY_SPACE_ID
const HF_PIXAL3D_SPACE_URL = makeHuggingFaceSpaceUrl(HF_PIXAL3D_SPACE_ID)
const HF_PIXAL3D_SERVER_DISCOVERY_URL = process.env.HF_PIXAL3D_SERVER_DISCOVERY_URL || HF_PIXAL3D_SPACE_URL
const HF_PIXAL3D_CONFIGURED_INSTANCE_URLS = parsePixal3dInstanceUrls(
  process.env.HF_PIXAL3D_INSTANCE_URLS || process.env.HF_PIXAL3D_INSTANCE_URL || ''
)
const HF_PIXAL3D_DISCOVERY_TIMEOUT_MS = Number(process.env.HF_PIXAL3D_DISCOVERY_TIMEOUT_MS || 15_000)
const HF_PIXAL3D_QUEUE_TIMEOUT_MS = Number(process.env.HF_PIXAL3D_QUEUE_TIMEOUT_MS || 5_000)
const HF_PIXAL3D_INSTANCE_CACHE_MS = Number(process.env.HF_PIXAL3D_INSTANCE_CACHE_MS || 30_000)
const BLENDER_AUTORIG_TIMEOUT_MS = Number(process.env.BLENDER_AUTORIG_TIMEOUT_MS || 180_000)
const BLENDER_AUTORIG_REPLACE_MODEL_URL = process.env.BLENDER_AUTORIG_REPLACE_MODEL_URL !== '0'
  && process.env.BLENDER_AUTORIG_REPLACE_MODEL_URL !== 'false'
const PIXAL3D_HF_GENERATION_SETTINGS = {
  seed: 0,
  decimationTarget: PIXAL3D_DECIMATION_TARGET,
  textureSize: PIXAL3D_TEXTURE_SIZE,
  ssGuidanceStrength: 10,
  ssGuidanceRescale: 0.7,
  ssSamplingSteps: 50,
  ssRescaleT: 5,
  shapeGuidance: 9,
  shapeRescale: 0.5,
  shapeSamplingSteps: 50,
  shapeRescaleT: 3,
  texGuidance: 10,
  texRescale: 0,
  texSamplingSteps: 50,
  texRescaleT: 3,
  meshSimplify: numberFromEnv('TRELLIS_MESH_SIMPLIFY', 0.9),
  multiimageAlgo: 'stochastic',
  manualFov: -1,
  fovUnit: 'deg',
} as const
const avatarGenerationJobs = new Map<string, AvatarGenerationJob>()
const TRELLIS_HF_GENERATION_SETTINGS = {
  seed: 0,
  resolution: '1024',
  targetFaces: TRELLIS_MAX_TRIANGLES,
  textureSize: TRELLIS_MAX_TEXTURE_SIZE,
  ssGuidanceStrength: 10,
  ssGuidanceRescale: 0.7,
  ssSamplingSteps: 50,
  ssRescaleT: 5,
  shapeGuidance: 9,
  shapeRescale: 0.5,
  shapeSamplingSteps: 50,
  shapeRescaleT: 3,
  texGuidance: 10,
  texRescale: 0,
  texSamplingSteps: 50,
  texRescaleT: 3,
} as const

let kieKeyCursor = 0
let cachedPixal3dInstanceUrls: { urls: string[]; expiresAt: number } | null = null

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback

  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

interface AvatarAutorigInfo {
  status: 'disabled' | 'generated' | 'failed'
  modelUrl?: string
  format?: string
  error?: string
}

interface AvatarConfig {
  bodyId: string
  headId: string
  skinTone: string
  hairStyle: string
  hairColor: string
  topStyle: string
  topColor: string
  bottomStyle: string
  bottomColor: string
  shoesStyle: string
  shoesColor: string
  accessory: string | null
  mood: 'stoic' | 'chill' | 'hyper' | 'tired' | 'confident'
  faceTextureUrl: string | null
  modelUrl: string | null
  rpmGlbUrl: string | null
  bodyTextureUrl: string | null
  autorig?: AvatarAutorigInfo | null
}

interface GenerateAvatarBody {
  fullbodyImage: string
  fallbackConfig: AvatarConfig
}

interface PrepareTrellisImagesBody {
  fullbodyImage: string
}

interface GeneratePreparedAvatarBody {
  trellisImages: string[]
  fallbackConfig: AvatarConfig
}

interface MirrorModelBody {
  modelUrl: string
}

interface TrellisJsonResponse {
  modelUrl?: unknown
  format?: unknown
  triangleCount?: unknown
}

interface TrellisModelResult {
  modelUrl: string
  format: string
  triangleCount: number | null
}

interface ParsedImageDataUrl {
  extension: string
}

interface UploadedKieImage {
  url: string
  apiKey: string
}

interface KieCreateTaskResponse {
  code?: number
  msg?: string
  message?: string
  data?: {
    taskId?: string
  }
}

interface KieTaskDetailResponse {
  code?: number
  msg?: string
  message?: string
  data?: {
    state?: string
    resultJson?: string
    failCode?: string
    failMsg?: string
  }
}

interface KieFileUploadResponse {
  success?: boolean
  code?: number
  msg?: string
  message?: string
  data?: {
    fileUrl?: string
    downloadUrl?: string
  }
}

interface AutorigResponse {
  status: 'disabled' | 'generated' | 'failed'
  modelUrl?: string
  format?: string
  error?: string
}

interface PreparedTrellisImages {
  source: 'kie' | 'source'
  sheetImage: string | null
  images: string[]
}

interface PreparedModelPhoto {
  source: 'kie' | 'source'
  image: string
  originalImage: string | null
}

type AvatarPipelineStage =
  | 'source'
  | 'fallback'
  | 'kie_upload'
  | 'kie_create'
  | 'kie_wait'
  | 'kie_download'
  | 'kie_done'
  | 'trellis_connect'
  | 'trellis_session'
  | 'trellis_preprocess'
  | 'trellis_generate'
  | 'trellis_upload'
  | 'autorig'
  | 'save'
  | 'done'
  | 'failed'

interface AvatarPipelineEvent {
  type: 'progress' | 'prepared' | 'result' | 'error'
  stage: AvatarPipelineStage
  progress: number
  message: string
  sourceImage?: string
  prepared?: PreparedModelPhoto
  result?: unknown
}

type AvatarProgressEmit = (event: AvatarPipelineEvent) => Promise<void> | void

type AvatarGenerationJobStatus = 'running' | 'succeeded' | 'failed'
type AvatarGenerationSubscriber = (event: AvatarPipelineEvent) => Promise<void>

interface AvatarGenerationJob {
  id: string
  userId: string
  status: AvatarGenerationJobStatus
  createdAt: number
  updatedAt: number
  events: AvatarPipelineEvent[]
  subscribers: Set<AvatarGenerationSubscriber>
  promise: Promise<void>
  cleanupTimer: ReturnType<typeof setTimeout> | null
}

type AuthResult =
  | { user: User; error?: never }
  | { user: null; error: string }

type LocalJwtVerifyResult =
  | { user: User; error?: never }
  | { user: null; error: string }

interface JwtHeader {
  alg?: string
  kid?: string
}

interface SupabaseJwtPayload {
  sub?: string
  aud?: string | string[]
  exp?: number
  email?: string
  role?: string
  app_metadata?: Record<string, unknown>
  user_metadata?: Record<string, unknown>
}

interface SupabaseJwks {
  keys?: SupabaseJwk[]
}

type SupabaseJwk = Record<string, unknown> & { kid?: string }

let cachedSupabaseJwks: { keys: SupabaseJwk[]; expiresAt: number } | null = null

async function getAuthedUser(authHeader: string | undefined): Promise<AuthResult> {
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, error: 'Missing Authorization bearer token' }
  }

  const jwt = authHeader.slice(7)
  const { data: { user }, error } = await supabase.auth.getUser(jwt)
  if (error || !user) {
    if (error?.message === 'fetch failed') {
      const local = await verifySupabaseJwtLocally(jwt)
      if (local.user) return { user: local.user }

      return {
        user: null,
        error: `Supabase Auth fetch failed; local JWT fallback failed: ${local.error}`,
      }
    }

    const details = error?.message ? `Supabase session rejected: ${error.message}` : 'Supabase session rejected'
    return { user: null, error: details }
  }

  return { user }
}

async function verifySupabaseJwtLocally(jwt: string): Promise<LocalJwtVerifyResult> {
  const parts = jwt.split('.')
  if (parts.length !== 3) return { user: null, error: 'token is not a 3-part JWT' }

  try {
    const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8')) as JwtHeader
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as SupabaseJwtPayload

    if (header.alg === 'HS256') {
      const verified = verifyHs256Jwt(parts)
      if (verified) return verified
    } else if (header.alg === 'ES256') {
      const verified = await verifyEs256Jwt(parts, header)
      if (verified) return verified
    } else {
      return { user: null, error: `token alg is ${header.alg || 'missing'}, expected HS256 or ES256` }
    }

    return payloadToUser(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'token could not be decoded as JSON'
    return { user: null, error: message }
  }
}

function verifyHs256Jwt(parts: string[]): LocalJwtVerifyResult | null {
  const secret = process.env.SUPABASE_JWT_SECRET
  if (!secret) return { user: null, error: 'SUPABASE_JWT_SECRET is not configured in the API process' }

  const expected = createHmac('sha256', secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest()
  const actual = base64UrlDecode(parts[2])
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { user: null, error: 'token signature did not match SUPABASE_JWT_SECRET' }
  }

  return null
}

async function verifyEs256Jwt(parts: string[], header: JwtHeader): Promise<LocalJwtVerifyResult | null> {
  if (!header.kid) return { user: null, error: 'ES256 token header is missing kid' }

  const jwks = await getSupabaseJwks()
  const jwk = jwks.find((key) => key.kid === header.kid)
  if (!jwk) return { user: null, error: `Supabase JWKS does not contain kid ${header.kid}` }

  const publicKey = createPublicKey({ key: jwk as JsonWebKeyInput, format: 'jwk' })
  const ok = verifySignature(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    base64UrlDecode(parts[2]),
  )

  if (!ok) return { user: null, error: 'ES256 token signature did not match Supabase JWKS' }
  return null
}

type JsonWebKeyInput = Parameters<typeof createPublicKey>[0] extends { key: infer T; format: 'jwk' } ? T : never

async function getSupabaseJwks(): Promise<SupabaseJwk[]> {
  if (cachedSupabaseJwks && cachedSupabaseJwks.expiresAt > Date.now()) return cachedSupabaseJwks.keys

  const configured = process.env.SUPABASE_JWKS
  if (configured) {
    const parsed = JSON.parse(configured) as SupabaseJwks
    if (!parsed.keys?.length) throw new Error('SUPABASE_JWKS has no keys')
    cachedSupabaseJwks = { keys: parsed.keys, expiresAt: Date.now() + 300_000 }
    return parsed.keys
  }

  if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is not configured')
  let response: Response
  try {
    response = await fetchWithTimeout(
      new URL('/auth/v1/.well-known/jwks.json', process.env.SUPABASE_URL).toString(),
      {},
      15_000,
      'Supabase JWKS fetch',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'fetch failed'
    throw new Error(`Supabase JWKS fetch failed: ${message}. Set SUPABASE_JWKS in the API .env to avoid network lookup.`)
  }
  if (!response.ok) throw new Error(`Supabase JWKS fetch failed: ${response.status}`)

  const body = await response.json() as SupabaseJwks
  if (!body.keys?.length) throw new Error('Supabase JWKS response has no keys')

  cachedSupabaseJwks = { keys: body.keys, expiresAt: Date.now() + 300_000 }
  return body.keys
}

function payloadToUser(payload: SupabaseJwtPayload): LocalJwtVerifyResult {
  if (!payload.sub) return { user: null, error: 'token payload is missing sub' }
  if (!payload.exp) return { user: null, error: 'token payload is missing exp' }
  if (payload.exp * 1000 <= Date.now()) return { user: null, error: 'token is expired' }

  const audience = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud
  if (audience && audience !== 'authenticated') {
    return { user: null, error: `token aud is ${audience}, expected authenticated` }
  }

  return {
    user: {
      id: payload.sub,
      aud: audience ?? 'authenticated',
      role: payload.role ?? 'authenticated',
      email: payload.email,
      app_metadata: payload.app_metadata ?? {},
      user_metadata: payload.user_metadata ?? {},
      created_at: '',
    } as User,
  }
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function isImageDataUrl(value: string): boolean {
  return /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value)
}

function isAvatarConfig(value: unknown): value is AvatarConfig {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as AvatarConfig).bodyId === 'string' &&
    typeof (value as AvatarConfig).skinTone === 'string' &&
    typeof (value as AvatarConfig).topColor === 'string' &&
    typeof (value as AvatarConfig).bottomColor === 'string'
  )
}

function makeHuggingFaceSpaceUrl(spaceIdOrUrl: string): string {
  const value = spaceIdOrUrl.trim().replace(/\/+$/, '')
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value.toLowerCase().replace('/', '-')}.hf.space`
}

function parsePixal3dInstanceUrls(value: string): string[] {
  const urls = new Set<string>()
  for (const part of value.split(/[\s,]+/)) {
    const normalized = normalizePixal3dInstanceUrl(part)
    if (normalized) urls.add(normalized)
  }
  return [...urls]
}

function normalizePixal3dInstanceUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
}

function extractPixal3dInstanceUrls(html: string): string[] {
  const text = decodeHtmlEntities(html)
  const urls = new Set<string>()
  const arrayMatch = text.match(/INSTANCE_URLS\s*=\s*(\[[\s\S]*?\])/)

  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[1]) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item !== 'string') continue
          const normalized = normalizePixal3dInstanceUrl(item)
          if (normalized) urls.add(normalized)
        }
      }
    } catch {
      // Fall through to URL regex extraction.
    }
  }

  for (const match of text.matchAll(/https:\/\/[a-z0-9-]+\.gradio\.live/gi)) {
    const normalized = normalizePixal3dInstanceUrl(match[0])
    if (normalized) urls.add(normalized)
  }

  return [...urls]
}

function isPixal3dServerSpace(): boolean {
  const value = HF_PIXAL3D_SPACE_ID.toLowerCase()
  return value === PIXAL3D_SERVER_SPACE_ID.toLowerCase() || value.includes('pixal3d-server')
}

function isAllowedTrellisModelUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.pathname.includes('/gradio_api/file=')) return false

    const spaceOrigin = new URL(HF_PIXAL3D_SPACE_URL).origin
    if (url.origin === spaceOrigin) return true
    if (url.hostname.endsWith(PIXAL3D_GRADIO_LIVE_HOST_SUFFIX)) return true
    return HF_PIXAL3D_CONFIGURED_INSTANCE_URLS.some((instanceUrl) => {
      try {
        return url.origin === new URL(instanceUrl).origin
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number, label: string) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), ms)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function emitAvatarProgress(
  emit: AvatarProgressEmit | undefined,
  event: AvatarPipelineEvent,
) {
  if (emit) await emit(event)
}

async function emitProgress(
  emit: AvatarProgressEmit | undefined,
  stage: AvatarPipelineStage,
  progress: number,
  message: string,
) {
  await emitAvatarProgress(emit, {
    type: 'progress',
    stage,
    progress,
    message,
  })
}

function parseImageDataUrl(dataUrl: string): ParsedImageDataUrl {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Invalid image data URL')

  const contentType = match[1].toLowerCase()
  const extension = contentType.includes('png')
    ? 'png'
    : contentType.includes('webp')
      ? 'webp'
      : 'jpg'

  return {
    extension,
  }
}

function imageBufferToDataUrl(bytes: Buffer, contentType: string) {
  return `data:${contentType};base64,${bytes.toString('base64')}`
}

async function uploadKieInputImageDataUrl(dataUrl: string): Promise<UploadedKieImage> {
  const image = parseImageDataUrl(dataUrl)
  const keys = getKieApiKeys()
  if (!keys.length) throw new Error('KIE_API_KEYS is not configured')

  const startIndex = kieKeyCursor % keys.length
  let lastError = 'KIE file upload failed'

  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const keyIndex = (startIndex + attempt) % keys.length
    const apiKey = keys[keyIndex]
    const fileName = `doorclub-source-${Date.now()}-${randomUUID()}.${image.extension}`
    const response = await fetchWithTimeout(
      new URL('/api/file-base64-upload', KIE_FILE_UPLOAD_BASE_URL).toString(),
      {
        method: 'POST',
        headers: kieHeaders(apiKey),
        body: JSON.stringify({
          base64Data: dataUrl,
          uploadPath: 'images/doorclub',
          fileName,
        }),
      },
      KIE_CREATE_TIMEOUT_MS,
      'KIE file upload',
    )
    const body = await response.json().catch(() => ({} as KieFileUploadResponse)) as KieFileUploadResponse
    const code = body.code ?? response.status
    const uploadedUrl = body.data?.downloadUrl || body.data?.fileUrl

    if (response.ok && code === 200 && uploadedUrl) {
      kieKeyCursor = (keyIndex + 1) % keys.length
      return { url: uploadedUrl, apiKey }
    }

    lastError = uploadedUrl
      ? `KIE file upload failed: ${code}`
      : formatKieResponseError(body, `KIE file upload failed: ${code}`)
    if (shouldTryNextKieKey(code)) continue
    throw new Error(lastError)
  }

  throw new Error(lastError)
}

function getKieApiKeys(): string[] {
  return getRawKieApiKeys()
    .split(/[\s,;]+/)
    .map((key) => key.trim())
    .filter(Boolean)
}

function getRawKieApiKeys(): string {
  const fromEnv = process.env.KIE_API_KEYS || process.env.KIE_API_KEY
  if (fromEnv?.trim()) return fromEnv

  const configuredFile = process.env.KIE_API_KEYS_FILE
  const candidateFiles = [
    configuredFile,
    path.resolve(process.cwd(), 'kie.txt'),
    path.resolve(__dirname, '..', '..', '..', 'kie.txt'),
  ].filter(Boolean) as string[]

  for (const filePath of candidateFiles) {
    if (existsSync(filePath)) return readFileSync(filePath, 'utf8')
  }

  return ''
}

function kieHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

function shouldTryNextKieKey(statusCode: number | undefined): boolean {
  return statusCode === 401 || statusCode === 402 || statusCode === 433
}

function formatKieResponseError(
  body: KieCreateTaskResponse | KieTaskDetailResponse | KieFileUploadResponse,
  fallback: string,
) {
  return body.msg || body.message || fallback
}

function makeKieCreateTaskBody(inputUrl: string, includeOutputFormat: boolean) {
  const input: Record<string, unknown> = {
    prompt: KIE_IMAGE_PROMPT,
    input_urls: [inputUrl],
    aspect_ratio: KIE_IMAGE_ASPECT_RATIO,
    resolution: '1K',
  }

  if (includeOutputFormat) input.output_format = 'png'

  return {
    model: 'gpt-image-2-image-to-image',
    input,
  }
}

async function postKieCreateTask(apiKey: string, inputUrl: string, includeOutputFormat: boolean) {
  const response = await fetchWithTimeout(
    new URL('/api/v1/jobs/createTask', KIE_API_BASE_URL).toString(),
    {
      method: 'POST',
      headers: kieHeaders(apiKey),
      body: JSON.stringify(makeKieCreateTaskBody(inputUrl, includeOutputFormat)),
    },
    KIE_CREATE_TIMEOUT_MS,
    'KIE GPT Image 2 task create',
  )

  const body = await response.json().catch(() => ({} as KieCreateTaskResponse)) as KieCreateTaskResponse
  return { response, body }
}

async function createKieImageTask(inputUrl: string, preferredApiKey?: string): Promise<{ taskId: string; apiKey: string }> {
  const keys = getKieApiKeys()
  if (!keys.length) throw new Error('KIE_API_KEYS is not configured')

  const orderedKeys = preferredApiKey
    ? [preferredApiKey, ...keys.filter((key) => key !== preferredApiKey)]
    : keys
  const startIndex = preferredApiKey ? 0 : kieKeyCursor % orderedKeys.length
  let lastError = 'KIE task create failed'

  for (let attempt = 0; attempt < orderedKeys.length; attempt += 1) {
    const apiKey = orderedKeys[(startIndex + attempt) % orderedKeys.length]

    for (const includeOutputFormat of [true, false]) {
      const { response, body } = await postKieCreateTask(apiKey, inputUrl, includeOutputFormat)
      const code = body.code ?? response.status
      if (response.ok && code === 200 && body.data?.taskId) {
        const keyIndex = keys.indexOf(apiKey)
        if (keyIndex !== -1) kieKeyCursor = (keyIndex + 1) % keys.length
        return { taskId: body.data.taskId, apiKey }
      }

      lastError = formatKieResponseError(body, `KIE task create failed: ${code}`)
      if (code === 422 && includeOutputFormat) continue
      if (shouldTryNextKieKey(code)) break
      throw new Error(lastError)
    }
  }

  throw new Error(lastError)
}

async function pollKieImageTask(taskId: string, apiKey: string): Promise<string> {
  const startedAt = Date.now()
  let intervalMs = 2500

  while (Date.now() - startedAt < KIE_POLL_TIMEOUT_MS) {
    const url = new URL('/api/v1/jobs/recordInfo', KIE_API_BASE_URL)
    url.searchParams.set('taskId', taskId)
    const response = await fetchWithTimeout(
      url.toString(),
      { headers: { Authorization: `Bearer ${apiKey}` } },
      KIE_CREATE_TIMEOUT_MS,
      'KIE GPT Image 2 task poll',
    )
    const body = await response.json().catch(() => ({} as KieTaskDetailResponse)) as KieTaskDetailResponse
    const code = body.code ?? response.status

    if (!response.ok || code !== 200) {
      throw new Error(formatKieResponseError(body, `KIE task poll failed: ${code}`))
    }

    const state = body.data?.state
    if (state === 'success') {
      const resultUrl = findFirstImageUrlFromKieResult(body.data?.resultJson)
      if (!resultUrl) throw new Error('KIE task result is missing an image URL')
      return resultUrl
    }

    if (state === 'fail') {
      const details = [body.data?.failCode, body.data?.failMsg].filter(Boolean).join(': ')
      throw new Error(details || 'KIE task failed')
    }

    await delay(intervalMs)
    intervalMs = Math.min(15_000, Math.round(intervalMs * 1.4))
  }

  throw new Error(`KIE task timed out after ${Math.round(KIE_POLL_TIMEOUT_MS / 1000)}s`)
}

function findFirstImageUrlFromKieResult(resultJson: string | undefined): string | null {
  if (!resultJson) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(resultJson)
  } catch {
    return null
  }

  return findFirstImageUrl(parsed)
}

function findFirstImageUrl(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return value
    return null
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstImageUrl(item)
      if (found) return found
    }
    return null
  }

  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of ['resultUrls', 'urls', 'images', 'imageUrls', 'url']) {
    const found = findFirstImageUrl(record[key])
    if (found) return found
  }

  for (const item of Object.values(record)) {
    const found = findFirstImageUrl(item)
    if (found) return found
  }

  return null
}

async function downloadKiePng(url: string): Promise<Buffer> {
  const response = await fetchWithTimeout(
    url,
    {},
    KIE_DOWNLOAD_TIMEOUT_MS,
    'KIE GPT Image 2 result download',
  )
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`KIE result download failed: ${response.status} ${text}`.trim())
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('KIE result was not returned as PNG')
  }

  return bytes
}

async function generateKieMultiViewImages(sourceImage: string): Promise<PreparedTrellisImages> {
  const uploaded = await uploadKieInputImageDataUrl(sourceImage)
  const { taskId, apiKey } = await createKieImageTask(uploaded.url, uploaded.apiKey)
  const resultUrl = await pollKieImageTask(taskId, apiKey)
  const sheet = await downloadKiePng(resultUrl)
  return {
    source: 'kie',
    sheetImage: imageBufferToDataUrl(sheet, 'image/png'),
    images: splitPngIntoVerticalThirds(sheet).map((image) => imageBufferToDataUrl(image, 'image/png')),
  }
}

async function prepareTrellisImages(sourceImage: string): Promise<PreparedTrellisImages> {
  if (!getKieApiKeys().length) {
    throw new Error('KIE_API_KEYS is not configured; add KIE_API_KEYS to API .env or set KIE_API_KEYS_FILE/kie.txt')
  }

  return generateKieMultiViewImages(sourceImage)
}

async function generateKieSingleModelPhoto(
  sourceImage: string,
  emit?: AvatarProgressEmit,
): Promise<PreparedModelPhoto> {
  await emitProgress(emit, 'kie_upload', 30, 'Загружаем исходное фото')
  const uploaded = await uploadKieInputImageDataUrl(sourceImage)
  await emitProgress(emit, 'kie_create', 36, 'Запускаем подготовку фото')
  const { taskId, apiKey } = await createKieImageTask(uploaded.url, uploaded.apiKey)
  await emitProgress(emit, 'kie_wait', 44, 'Готовим фото для 3D-модели')
  const resultUrl = await pollKieImageTask(taskId, apiKey)
  await emitProgress(emit, 'kie_download', 52, 'Забираем подготовленное фото')
  const image = await downloadKiePng(resultUrl)
  const prepared = {
    source: 'kie',
    image: imageBufferToDataUrl(image, 'image/png'),
    originalImage: sourceImage,
  } satisfies PreparedModelPhoto
  await emitAvatarProgress(emit, {
    type: 'prepared',
    stage: 'kie_done',
    progress: 58,
    message: 'Фото готово, собираем 3D-модель',
    prepared,
  })
  return prepared
}

async function prepareSingleModelPhoto(
  sourceImage: string,
  emit?: AvatarProgressEmit,
): Promise<PreparedModelPhoto> {
  if (!getKieApiKeys().length) {
    throw new Error('KIE_API_KEYS is not configured; add KIE_API_KEYS to API .env or set KIE_API_KEYS_FILE/kie.txt')
  }
  return generateKieSingleModelPhoto(sourceImage, emit)
}

function areImageDataUrls(images: string[]): boolean {
  return images.length > 0 &&
    images.length <= 3 &&
    images.every((image) => isImageDataUrl(image) && image.length <= MAX_IMAGE_DATA_URL_BYTES)
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)}KB`
  return `${bytes}B`
}

async function uploadModelBytes(userId: string, bytes: ArrayBuffer, contentType = 'model/gltf-binary') {
  if (bytes.byteLength > MAX_MODEL_UPLOAD_BYTES) {
    throw new Error(
      `GLB upload too large: ${formatByteSize(bytes.byteLength)} exceeds configured limit ${formatByteSize(MAX_MODEL_UPLOAD_BYTES)}`,
    )
  }

  const path = `${userId}/avatar-${Date.now()}.glb`
  const { error } = await supabase.storage
    .from(AVATAR_MODELS_BUCKET)
    .upload(path, Buffer.from(bytes), {
      contentType,
      upsert: true,
    })

  if (error) throw new Error(`Supabase model upload failed: ${error.message}`)

  const { data } = supabase.storage.from(AVATAR_MODELS_BUCKET).getPublicUrl(path)
  if (!data.publicUrl) throw new Error('Supabase model public URL missing')

  return data.publicUrl
}

async function uploadModelFromUrl(
  userId: string,
  modelUrl: string,
  workerUrl: string,
  headers: Record<string, string> = {},
  label = 'TRELLIS',
) {
  const resolvedModelUrl = new URL(modelUrl, workerUrl).toString()

  let response: Response
  try {
    response = await fetch(resolvedModelUrl, { headers })
  } catch (error) {
    const url = new URL(resolvedModelUrl)
    throw new Error(
      `${label} model download request failed from ${url.origin}: ${formatExternalError(error, 'fetch failed')}`,
    )
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${label} model download failed: ${response.status} ${text}`.trim())
  }

  return uploadModelBytes(
    userId,
    await response.arrayBuffer(),
    response.headers.get('content-type') || 'model/gltf-binary',
  )
}

function isGlbBytes(bytes: ArrayBuffer): boolean {
  const buffer = Buffer.from(bytes)
  return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'glTF'
}

function bufferToExactArrayBuffer(buffer: Buffer): ArrayBuffer {
  const exact = new ArrayBuffer(buffer.byteLength)
  new Uint8Array(exact).set(buffer)
  return exact
}

async function uploadAndMaybeAutorigModelBytes(
  userId: string,
  bytes: ArrayBuffer,
  contentType = 'model/gltf-binary',
) {
  const modelUrl = await uploadModelBytes(userId, bytes, contentType)
  const autorig = await applyBlenderAutorig(userId, modelUrl)
  return {
    modelUrl: BLENDER_AUTORIG_REPLACE_MODEL_URL && autorig.status === 'generated' && autorig.modelUrl
      ? autorig.modelUrl
      : modelUrl,
    format: 'glb',
    triangleCount: null,
    autorig,
  }
}

function blenderAutorigEnabled(): boolean {
  return process.env.BLENDER_AUTORIG_ENABLED !== '0' && process.env.BLENDER_AUTORIG_ENABLED !== 'false'
}

let cachedBlenderExecutable: string | null | undefined

function blenderExecutable(): string {
  if (cachedBlenderExecutable !== undefined) return cachedBlenderExecutable || 'blender'

  const configured = process.env.BLENDER_PATH?.trim()
  if (configured) {
    const resolvedConfigured = resolveConfiguredBlenderExecutable(configured)
    if (resolvedConfigured) {
      cachedBlenderExecutable = resolvedConfigured
      return resolvedConfigured
    }
  }

  cachedBlenderExecutable = findWindowsBlenderExecutable()
  return cachedBlenderExecutable || configured || 'blender'
}

function resolveConfiguredBlenderExecutable(configured: string): string | null {
  const hasPathSeparator = configured.includes('/') || configured.includes('\\')
  if (hasPathSeparator || path.isAbsolute(configured)) return configured

  const commandPath = findCommandOnPath(configured)
  if (commandPath) return commandPath

  if (process.platform === 'win32' && configured.toLowerCase() === 'blender') {
    return findWindowsBlenderExecutable()
  }

  return configured
}

function findCommandOnPath(command: string): string | null {
  const pathEnv = process.env.PATH || ''
  if (!pathEnv) return null
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']

  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === 'win32' && path.extname(command) ? command : `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }

  return null
}

function findWindowsBlenderExecutable(): string | null {
  if (process.platform !== 'win32') return null

  const roots = [
    process.env.BLENDER_INSTALL_DIR,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Blender Foundation') : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)']!, 'Blender Foundation') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Blender Foundation') : null,
  ].filter(Boolean) as string[]

  for (const root of roots) {
    try {
      if (!existsSync(root)) continue

      const candidates = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name, 'blender.exe'))
        .filter((candidate) => existsSync(candidate))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))

      if (candidates[0]) return candidates[0]
    } catch {
      // Fall through to the next root, then to PATH.
    }
  }

  return null
}

function blenderAutorigScriptPath(): string {
  const configured = process.env.BLENDER_AUTORIG_SCRIPT?.trim()
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured)
  }

  const candidates = [
    path.resolve(__dirname, '../../scripts/avatar-autorig.blender.py'),
    path.resolve(process.cwd(), 'scripts/avatar-autorig.blender.py'),
    path.resolve(process.cwd(), 'apps/api/scripts/avatar-autorig.blender.py'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function runBlenderAutorig(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = blenderAutorigScriptPath()
    if (!existsSync(scriptPath)) {
      reject(new Error(`Blender autorig script not found: ${scriptPath}`))
      return
    }

    const args = [
      '--background',
      '--factory-startup',
      '--python',
      scriptPath,
      '--',
      inputPath,
      outputPath,
    ]
    const child = spawn(blenderExecutable(), args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }

    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`Blender autorig timed out after ${Math.round(BLENDER_AUTORIG_TIMEOUT_MS / 1000)}s`))
    }, BLENDER_AUTORIG_TIMEOUT_MS)

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-4000)
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.on('error', (error) => {
      finish(new Error(`Blender autorig failed to start: ${error.message}`))
    })
    child.on('close', (code) => {
      if (code === 0) {
        finish()
        return
      }

      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').slice(-4000)
      finish(new Error(`Blender autorig exited with code ${code}${details ? `: ${details}` : ''}`))
    })
  })
}

async function downloadModelToFile(modelUrl: string, targetPath: string) {
  const response = await fetch(modelUrl)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Autorig model download failed: ${response.status} ${text}`.trim())
  }

  await writeFile(targetPath, Buffer.from(await response.arrayBuffer()))
}

function findBlenderAutorigOutputPath(tmpRoot: string, preferredPath: string): string | null {
  if (existsSync(preferredPath)) return preferredPath

  const candidates = readdirSync(tmpRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.glb'))
    .map((entry) => path.join(tmpRoot, entry.name))
    .filter((candidate) => candidate !== path.join(tmpRoot, 'input.glb'))

  return candidates[0] ?? null
}

async function requestBlenderAutorigModel(userId: string, modelUrl: string): Promise<TrellisModelResult | null> {
  if (!blenderAutorigEnabled()) return null

  const tmpRoot = path.join(os.tmpdir(), `doorclub-autorig-${randomUUID()}`)
  const inputPath = path.join(tmpRoot, 'input.glb')
  const outputPath = path.join(tmpRoot, 'rigged.glb')

  try {
    await mkdir(tmpRoot, { recursive: true })
    await downloadModelToFile(modelUrl, inputPath)
    await runBlenderAutorig(inputPath, outputPath)
    const riggedPath = findBlenderAutorigOutputPath(tmpRoot, outputPath)
    if (!riggedPath) {
      throw new Error('Подготовка движений не создала файл 3D-модели')
    }

    const riggedBytes = await readFile(riggedPath)
    const riggedUrl = await uploadModelBytes(userId, riggedBytes.buffer.slice(
      riggedBytes.byteOffset,
      riggedBytes.byteOffset + riggedBytes.byteLength,
    ), 'model/gltf-binary')
    return { modelUrl: riggedUrl, format: 'glb', triangleCount: null }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

async function applyBlenderAutorig(
  userId: string,
  modelUrl: string,
): Promise<AutorigResponse> {
  if (!blenderAutorigEnabled()) return { status: 'disabled' }

  try {
    const rigged = await requestBlenderAutorigModel(userId, modelUrl)
    if (!rigged) return { status: 'disabled' }
    return { status: 'generated', modelUrl: rigged.modelUrl, format: rigged.format }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Blender autorig failed'
    console.error('[Avatar Blender autorig] Error:', message)
    return { status: 'failed', error: message }
  }
}

function findGlbUrl(value: unknown, baseUrl = HF_PIXAL3D_SPACE_URL): string | null {
  if (!value) return null

  if (typeof value === 'string') {
    if (value.toLowerCase().includes('.glb')) return new URL(value, baseUrl).toString()
    return null
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGlbUrl(item, baseUrl)
      if (found) return found
    }
    return null
  }

  if (typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  for (const key of ['url', 'path', 'name']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.toLowerCase().includes('.glb')) {
      if (candidate.startsWith('/') && !candidate.startsWith('/gradio_api/')) {
        return `${baseUrl}/gradio_api/file=${candidate}`
      }
      return new URL(candidate, baseUrl).toString()
    }
  }

  for (const item of Object.values(record)) {
    const found = findGlbUrl(item, baseUrl)
    if (found) return found
  }

  return null
}

function getHuggingFaceToken(): string | null {
  return process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || null
}

interface GradioPredictResult<T = unknown> {
  data: T
}

interface GradioEndpointParameter {
  parameter_name?: unknown
}

interface GradioEndpointInfo {
  parameters?: GradioEndpointParameter[]
}

interface GradioApiInfo {
  named_endpoints?: Record<string, GradioEndpointInfo | undefined>
}

interface GradioClientInstance {
  api_info?: GradioApiInfo
  predict<T = unknown>(endpoint: string, data?: unknown[] | Record<string, unknown>): Promise<GradioPredictResult<T>>
  close(): void
}

interface GradioClientModule {
  Client: {
    connect(appReference: string, options?: { token?: string }): Promise<GradioClientInstance>
  }
  handle_file(file: Blob | Buffer | string): unknown
}

interface Pixal3dTarget {
  reference: string
  url: string
  name: string
  queueSize: number | null
  queueError?: string
}

interface Pixal3dClientConnection {
  gradio: GradioClientInstance
  baseUrl: string
  name: string
  queueSize: number | null
  downloadHeaders: Record<string, string>
}

async function importGradioClient(): Promise<GradioClientModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as
    (specifier: string) => Promise<GradioClientModule>
  return dynamicImport(pathToFileURL(requireFromHere.resolve('@gradio/client')).href)
}

function getGradioNamedEndpoint(apiInfo: GradioApiInfo | undefined, endpoint: string): GradioEndpointInfo | null {
  const namedEndpoints = apiInfo?.named_endpoints
  if (!namedEndpoints) return null

  const trimmed = endpoint.replace(/^\//, '')
  return namedEndpoints[endpoint] ?? namedEndpoints[trimmed] ?? namedEndpoints[`/${trimmed}`] ?? null
}

function filterGradioEndpointArgs(
  gradio: GradioClientInstance,
  endpoint: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const endpointInfo = getGradioNamedEndpoint(gradio.api_info, endpoint)
  const acceptedNames = new Set(
    endpointInfo?.parameters
      ?.map((parameter) => parameter.parameter_name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0) ?? []
  )

  if (!acceptedNames.size) return args

  const filtered: Record<string, unknown> = {}
  const omitted: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (acceptedNames.has(key)) {
      filtered[key] = value
    } else {
      omitted.push(key)
    }
  }

  if (omitted.length) {
    console.warn(`[Avatar TRELLIS] ${endpoint} does not accept ${omitted.join(', ')}; omitting.`)
  }

  return filtered
}

async function discoverPixal3dInstanceUrls(): Promise<string[]> {
  if (HF_PIXAL3D_CONFIGURED_INSTANCE_URLS.length) return HF_PIXAL3D_CONFIGURED_INSTANCE_URLS

  const directUrl = normalizePixal3dInstanceUrl(HF_PIXAL3D_SPACE_ID) || normalizePixal3dInstanceUrl(HF_PIXAL3D_SPACE_URL)
  if (directUrl && !directUrl.includes('pixal3d-server')) return [directUrl]

  if (cachedPixal3dInstanceUrls && cachedPixal3dInstanceUrls.expiresAt > Date.now()) {
    return cachedPixal3dInstanceUrls.urls
  }

  const response = await fetchWithTimeout(
    HF_PIXAL3D_SERVER_DISCOVERY_URL,
    { headers: huggingFaceHeaders(false) },
    HF_PIXAL3D_DISCOVERY_TIMEOUT_MS,
    'Hugging Face Pixal3D-Server discovery',
  )

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Hugging Face Pixal3D-Server discovery failed: ${response.status} ${text}`.trim())
  }

  let urls = extractPixal3dInstanceUrls(await response.text())
  if (!urls.length) {
    const configResponse = await fetchWithTimeout(
      new URL('/config', HF_PIXAL3D_SERVER_DISCOVERY_URL).toString(),
      { headers: huggingFaceHeaders(false) },
      HF_PIXAL3D_DISCOVERY_TIMEOUT_MS,
      'Hugging Face Pixal3D-Server config discovery',
    )
    if (configResponse.ok) {
      urls = extractPixal3dInstanceUrls(await configResponse.text())
    }
  }

  cachedPixal3dInstanceUrls = {
    urls,
    expiresAt: Date.now() + HF_PIXAL3D_INSTANCE_CACHE_MS,
  }
  return urls
}

function fallbackPixal3dTarget(): Pixal3dTarget | null {
  if (isPixal3dServerSpace()) return null
  return {
    reference: HF_PIXAL3D_SPACE_ID,
    url: HF_PIXAL3D_SPACE_URL,
    name: HF_PIXAL3D_SPACE_ID,
    queueSize: null,
  }
}

async function getPixal3dTargets(): Promise<Pixal3dTarget[]> {
  const urls = await discoverPixal3dInstanceUrls()
  if (urls.length) {
    return urls.map((url, index) => ({
      reference: url,
      url,
      name: `Instance ${index}`,
      queueSize: null,
    }))
  }

  const fallback = fallbackPixal3dTarget()
  if (fallback) return [fallback]

  throw new Error('Pixal3D-Server did not publish any available gradio.live instances')
}

async function readPixal3dQueueSize(target: Pixal3dTarget): Promise<number> {
  const response = await fetchWithTimeout(
    new URL('/queue?session_id=', target.url).toString(),
    {},
    HF_PIXAL3D_QUEUE_TIMEOUT_MS,
    `Pixal3D queue check (${target.name})`,
  )

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${response.status} ${text}`.trim())
  }

  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  const totalWaitingValue = Number(data.total_waiting)
  const totalWaiting = Number.isFinite(totalWaitingValue) ? totalWaitingValue : 0
  return Math.max(0, totalWaiting) + (data.gpu_busy ? 1 : 0)
}

async function selectPixal3dTarget(): Promise<Pixal3dTarget> {
  const targets = await getPixal3dTargets()
  const checked = await Promise.all(targets.map(async (target) => {
    try {
      return {
        ...target,
        queueSize: await readPixal3dQueueSize(target),
        queueError: undefined,
      } satisfies Pixal3dTarget
    } catch (error) {
      return {
        ...target,
        queueSize: null,
        queueError: formatExternalError(error, 'queue unavailable'),
      } satisfies Pixal3dTarget
    }
  }))

  const online = checked.filter((target) => target.queueSize !== null)
  if (online.length) {
    return online.sort((a, b) => (a.queueSize ?? 0) - (b.queueSize ?? 0))[0]
  }

  console.warn('[Avatar Pixal3D] Queue check failed for all instances:', checked.map((target) => ({
    url: target.url,
    error: target.queueError,
  })))
  return checked[0]
}

function shouldSendHuggingFaceToken(target: Pixal3dTarget): boolean {
  return !/^https?:\/\//i.test(target.reference)
}

async function connectHuggingFaceTrellisClient(): Promise<Pixal3dClientConnection> {
  const target = await selectPixal3dTarget()
  const { Client } = await importGradioClient()
  const token = shouldSendHuggingFaceToken(target) ? getHuggingFaceToken() : null
  const gradio = await withTimeout(
    Client.connect(target.reference, token ? { token } : undefined),
    HF_CONNECT_TIMEOUT_MS,
    `Hugging Face TRELLIS connect (${target.name})`,
  )
  return {
    gradio,
    baseUrl: target.url,
    name: target.name,
    queueSize: target.queueSize,
    downloadHeaders: token ? huggingFaceHeaders(false) : {},
  }
}

function huggingFaceHeaders(includeContentType = true) {
  const headers: Record<string, string> = {}
  if (includeContentType) headers['Content-Type'] = 'application/json'

  const token = getHuggingFaceToken()
  if (token) headers.Authorization = `Bearer ${token}`

  return headers
}

function makeGradioImageBlob(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Invalid image data URL')

  return new Blob([Buffer.from(match[2], 'base64')], { type: match[1] })
}

function parseGradioSse(text: string, label: string): unknown {
  const errorLine = text
    .split(/\r?\n/)
    .find((line) => line.startsWith('event: error') || line.startsWith('data: {"error"'))
  if (errorLine) {
    const details = text.includes('data: null') ? 'Space returned event:error with no details' : text.slice(0, 500)
    throw new Error(`${label} failed: ${details}`)
  }

  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))

  if (!dataLines.length) return null

  const lastData = dataLines[dataLines.length - 1]
  return JSON.parse(lastData)
}

function cleanExternalErrorMessage(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatExternalError(error: unknown, fallback: string): string {
  if (error instanceof Error) return cleanExternalErrorMessage(error.message || fallback)

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title : ''
    const message = typeof record.message === 'string' ? record.message : ''
    const detail = typeof record.detail === 'string' ? record.detail : ''
    const bodyError = typeof record.error === 'string' ? record.error : ''
    const combined = [title, message || detail || bodyError].filter(Boolean).join(': ')
    if (combined) return cleanExternalErrorMessage(combined)
  }

  try {
    return cleanExternalErrorMessage(JSON.stringify(error) || fallback)
  } catch {
    return fallback
  }
}

async function callHuggingFaceEndpoint(
  endpoint: string,
  data: unknown[],
  timeoutMs: number,
  baseUrl = HF_PIXAL3D_SPACE_URL,
) {
  const label = `Hugging Face Pixal3D ${endpoint}`
  const callResponse = await fetchWithTimeout(
    `${baseUrl}/gradio_api/call/${endpoint}`,
    {
      method: 'POST',
      headers: huggingFaceHeaders(),
      body: JSON.stringify({ data }),
    },
    HF_CONNECT_TIMEOUT_MS,
    label,
  )

  if (!callResponse.ok) {
    const text = await callResponse.text().catch(() => '')
    throw new Error(`${label} call failed: ${callResponse.status} ${text}`.trim())
  }

  const callBody = await callResponse.json() as { event_id?: string }
  if (!callBody.event_id) throw new Error(`${label} missing event_id`)

  const pollResponse = await fetchWithTimeout(
    `${baseUrl}/gradio_api/call/${endpoint}/${callBody.event_id}`,
    { headers: huggingFaceHeaders() },
    timeoutMs,
    label,
  )

  if (!pollResponse.ok) {
    const text = await pollResponse.text().catch(() => '')
    throw new Error(`${label} poll failed: ${pollResponse.status} ${text}`.trim())
  }

  return parseGradioSse(await pollResponse.text(), label)
}

function makePixal3dGenerateArgs(image: unknown, sessionId: string): Record<string, unknown> {
  return {
    image,
    multiimages: [],
    seed: getPixal3dSeed(),
    ss_guidance_strength: PIXAL3D_HF_GENERATION_SETTINGS.ssGuidanceStrength,
    ss_sampling_steps: PIXAL3D_HF_GENERATION_SETTINGS.ssSamplingSteps,
    slat_guidance_strength: PIXAL3D_HF_GENERATION_SETTINGS.shapeGuidance,
    slat_sampling_steps: PIXAL3D_HF_GENERATION_SETTINGS.shapeSamplingSteps,
    multiimage_algo: PIXAL3D_HF_GENERATION_SETTINGS.multiimageAlgo,
    mesh_simplify: PIXAL3D_HF_GENERATION_SETTINGS.meshSimplify,
    texture_size: PIXAL3D_HF_GENERATION_SETTINGS.textureSize,
    session_id: sessionId,
  }
}

function makePixal3dExtractGlbArgs(statePath: string, sessionId: string): Record<string, unknown> {
  return {
    state_path: statePath,
    decimation_target: PIXAL3D_HF_GENERATION_SETTINGS.decimationTarget,
    texture_size: PIXAL3D_HF_GENERATION_SETTINGS.textureSize,
    session_id: sessionId,
  }
}

function findPixal3dStatePath(value: unknown): string | null {
  if (!value) return null

  if (typeof value === 'string') {
    const text = value.trim()
    if (/\.(npz|safetensors)(\?|$)/i.test(text)) return text
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return findPixal3dStatePath(JSON.parse(text))
      } catch {
        return null
      }
    }
    return null
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPixal3dStatePath(item)
      if (found) return found
    }
    return null
  }

  if (typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  for (const key of ['state_path', 'statePath']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate) return candidate
  }

  for (const item of Object.values(record)) {
    const found = findPixal3dStatePath(item)
    if (found) return found
  }

  return null
}

function unwrapSingleGradioOutput(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value
}

function getTrellisSeed() {
  if (!TRELLIS_RANDOMIZE_SEED) return TRELLIS_HF_GENERATION_SETTINGS.seed
  return Math.floor(Math.random() * (MAX_TRELLIS_SEED + 1))
}

function getPixal3dSeed() {
  if (!PIXAL3D_RANDOMIZE_SEED) return PIXAL3D_HF_GENERATION_SETTINGS.seed
  return Math.floor(Math.random() * (MAX_PIXAL3D_SEED + 1))
}

async function callHuggingFaceGenerateGlb(
  gradio: GradioClientInstance,
  image: unknown,
  sessionId: string,
): Promise<unknown> {
  const generateArgs = filterGradioEndpointArgs(
    gradio,
    '/generate_and_extract_glb',
    makePixal3dGenerateArgs(image, sessionId),
  )
  const generated = await withTimeout(
    gradio.predict(
      '/generate_and_extract_glb',
      generateArgs,
    ),
    HF_GENERATE_TIMEOUT_MS,
    'Hugging Face TRELLIS generate_and_extract_glb',
  )
  return generated.data
}

async function callHuggingFacePreprocessImage(
  gradio: GradioClientInstance,
  image: string,
): Promise<unknown> {
  const { handle_file } = await importGradioClient()
  const preprocessed = await withTimeout(
    gradio.predict('/preprocess_image', { image: handle_file(makeGradioImageBlob(image)) }),
    HF_PREPROCESS_TIMEOUT_MS,
    'Hugging Face TRELLIS preprocess_image',
  )
  const imageForGeneration = unwrapSingleGradioOutput(preprocessed.data)
  if (!imageForGeneration) throw new Error('Hugging Face TRELLIS preprocess returned no image')
  return imageForGeneration
}

async function requestHuggingFaceTrellisModel(
  userId: string,
  images: string[],
  emit?: AvatarProgressEmit,
): Promise<TrellisModelResult> {
  const firstImage = images[0]
  if (!firstImage) throw new Error('3D-сборке нужно хотя бы одно фото')

  await emitProgress(emit, 'trellis_connect', 61, 'Подключаем модуль 3D-сборки')
  const pixal3d = await connectHuggingFaceTrellisClient()
  const gradio = pixal3d.gradio
  const sessionId = `doorclub-${userId}-${randomUUID()}`

  try {
    const queueLabel = pixal3d.queueSize === null ? '' : `, очередь ${pixal3d.queueSize}`
    await emitProgress(emit, 'trellis_session', 65, `Запускаем очередь 3D-сборки${queueLabel}`)
    await emitProgress(emit, 'trellis_preprocess', 70, 'Очищаем и нормализуем фото')
    const imageForGeneration = await callHuggingFacePreprocessImage(gradio, firstImage)
    await emitProgress(emit, 'trellis_generate', 78, 'Собираем 3D-модель')
    const generated = await callHuggingFaceGenerateGlb(gradio, imageForGeneration, sessionId)

    const glbUrl = findGlbUrl(generated, pixal3d.baseUrl)
    if (!glbUrl) throw new Error('Hugging Face TRELLIS response missing GLB URL')

    await emitProgress(emit, 'trellis_upload', 90, 'Сохраняем 3D-модель')
    const modelUrl = await uploadModelFromUrl(
      userId,
      glbUrl,
      pixal3d.baseUrl,
      pixal3d.downloadHeaders,
      'Hugging Face TRELLIS',
    )
    return { modelUrl, format: 'glb', triangleCount: null }
  } finally {
    gradio.close()
  }
}

async function requestPrivateTrellisModel(
  userId: string,
  images: string[],
  emit?: AvatarProgressEmit,
): Promise<TrellisModelResult | null> {
  const workerUrl = process.env.TRELLIS_WORKER_URL
  if (!workerUrl) return null

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (process.env.TRELLIS_WORKER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.TRELLIS_WORKER_TOKEN}`
  }

  await emitProgress(emit, 'trellis_generate', 70, 'Отправляем фото в 3D-сборку')
  const response = await fetch(new URL('/generate', workerUrl).toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      image: images[0],
      images,
      multiImages: images,
      multiimages: images,
      isMultiimage: images.length > 1,
      style: TRELLIS_STYLE,
      qualityPreset: 'max',
      preserveIdentity: true,
      preserveTextureDetail: true,
      textureQuality: 'max',
      maxTextureSize: TRELLIS_MAX_TEXTURE_SIZE,
      maxTriangles: TRELLIS_MAX_TRIANGLES,
      seed: getTrellisSeed(),
      randomizeSeed: TRELLIS_RANDOMIZE_SEED,
      generationResolution: TRELLIS_HF_GENERATION_SETTINGS.resolution,
      resolution: TRELLIS_HF_GENERATION_SETTINGS.resolution,
      targetFaces: TRELLIS_HF_GENERATION_SETTINGS.targetFaces,
      decimationTarget: TRELLIS_HF_GENERATION_SETTINGS.targetFaces,
      textureSize: TRELLIS_HF_GENERATION_SETTINGS.textureSize,
      ssGuidanceStrength: TRELLIS_HF_GENERATION_SETTINGS.ssGuidanceStrength,
      ssGuidanceRescale: TRELLIS_HF_GENERATION_SETTINGS.ssGuidanceRescale,
      ssSamplingSteps: TRELLIS_HF_GENERATION_SETTINGS.ssSamplingSteps,
      ssRescaleT: TRELLIS_HF_GENERATION_SETTINGS.ssRescaleT,
      shapeGuidance: TRELLIS_HF_GENERATION_SETTINGS.shapeGuidance,
      shapeGuidanceStrength: TRELLIS_HF_GENERATION_SETTINGS.shapeGuidance,
      shapeRescale: TRELLIS_HF_GENERATION_SETTINGS.shapeRescale,
      shapeSamplingSteps: TRELLIS_HF_GENERATION_SETTINGS.shapeSamplingSteps,
      shapeSteps: TRELLIS_HF_GENERATION_SETTINGS.shapeSamplingSteps,
      shapeRescaleT: TRELLIS_HF_GENERATION_SETTINGS.shapeRescaleT,
      texGuidance: TRELLIS_HF_GENERATION_SETTINGS.texGuidance,
      texGuidanceStrength: TRELLIS_HF_GENERATION_SETTINGS.texGuidance,
      texRescale: TRELLIS_HF_GENERATION_SETTINGS.texRescale,
      texSamplingSteps: TRELLIS_HF_GENERATION_SETTINGS.texSamplingSteps,
      texSteps: TRELLIS_HF_GENERATION_SETTINGS.texSamplingSteps,
      texRescaleT: TRELLIS_HF_GENERATION_SETTINGS.texRescaleT,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`TRELLIS worker failed: ${response.status} ${text}`.trim())
  }

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const body = await response.json() as TrellisJsonResponse
    if (typeof body.modelUrl !== 'string' || !body.modelUrl) {
      throw new Error('TRELLIS worker response missing modelUrl')
    }

    const downloadHeaders: Record<string, string> = {}
    if (process.env.TRELLIS_WORKER_TOKEN) {
      downloadHeaders.Authorization = `Bearer ${process.env.TRELLIS_WORKER_TOKEN}`
    }

    await emitProgress(emit, 'trellis_upload', 90, 'Сохраняем 3D-модель')
    const modelUrl = await uploadModelFromUrl(userId, body.modelUrl, workerUrl, downloadHeaders)
    return {
      modelUrl,
      format: typeof body.format === 'string' ? body.format : 'glb',
      triangleCount: typeof body.triangleCount === 'number' ? body.triangleCount : null,
    }
  }

  await emitProgress(emit, 'trellis_upload', 90, 'Сохраняем 3D-модель')
  const modelUrl = await uploadModelBytes(userId, await response.arrayBuffer(), contentType || 'model/gltf-binary')
  return { modelUrl, format: 'glb', triangleCount: null }
}

async function requestTrellisModelFromImages(
  userId: string,
  images: string[],
  emit?: AvatarProgressEmit,
): Promise<TrellisModelResult | null> {
  const provider = (process.env.TRELLIS_WORKER_PROVIDER || '').toLowerCase()
  if (provider === 'disabled' || provider === 'none') return null

  if (provider === 'huggingface' || !process.env.TRELLIS_WORKER_URL) {
    return requestHuggingFaceTrellisModel(userId, images, emit)
  }

  await emitProgress(emit, 'trellis_connect', 61, 'Подключаем модуль 3D-сборки')
  return requestPrivateTrellisModel(userId, images, emit)
}

async function saveAvatar(userId: string, config: AvatarConfig) {
  const payload = {
    user_id: userId,
    glb_url: config.modelUrl ?? config.rpmGlbUrl,
    face_tex_url: config.faceTextureUrl,
    config_json: config,
  }

  const { data: existing, error: selectError } = await supabase
    .from('avatars')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (selectError) throw selectError

  const { data, error } = existing?.id
    ? await supabase
      .from('avatars')
      .update(payload)
      .eq('id', existing.id)
      .select('id')
      .single()
    : await supabase
      .from('avatars')
      .insert(payload)
      .select('id')
    .single()

  if (error) throw error

  if (data?.id) {
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ avatar_id: data.id })
      .eq('user_id', userId)

    if (profileError) console.error('[Avatar] profile avatar_id update failed:', profileError)
  }
}

async function generateAndSaveAvatarFromTrellisImages(
  userId: string,
  fallbackConfig: AvatarConfig,
  images: string[],
  emit?: AvatarProgressEmit,
): Promise<{
  avatar: AvatarConfig
  trellis:
    | { status: 'generated'; modelUrl: string; format: string; triangleCount: number | null }
    | { status: 'skipped' | 'failed'; error?: string }
  autorig: AutorigResponse
}> {
  let trellis:
    | { status: 'generated'; modelUrl: string; format: string; triangleCount: number | null }
    | { status: 'skipped' | 'failed'; error?: string }
  let autorig: AutorigResponse = { status: 'disabled' }

  let finalConfig: AvatarConfig = {
    ...fallbackConfig,
    modelUrl: fallbackConfig.modelUrl ?? null,
    rpmGlbUrl: fallbackConfig.rpmGlbUrl ?? null,
  }

  try {
    const generated = await requestTrellisModelFromImages(userId, images, emit)
    if (generated) {
      finalConfig = {
        ...finalConfig,
        modelUrl: generated.modelUrl,
        rpmGlbUrl: null,
      }
      trellis = { status: 'generated', ...generated }
      await emitProgress(emit, 'autorig', 94, 'Подготавливаем модель для движения')
      autorig = await applyBlenderAutorig(userId, generated.modelUrl)
      if (BLENDER_AUTORIG_REPLACE_MODEL_URL && autorig.status === 'generated' && autorig.modelUrl) {
        finalConfig = {
          ...finalConfig,
          modelUrl: autorig.modelUrl,
          rpmGlbUrl: null,
        }
      }
      finalConfig = {
        ...finalConfig,
        autorig,
      }
    } else {
      trellis = { status: 'skipped', error: '3D-сборка выключена' }
    }
  } catch (error) {
    const message = formatExternalError(error, '3D-сборка не удалась')
    console.error('[Avatar Pixal3D] Error:', message)
    trellis = { status: 'failed', error: message }
  }

  await emitProgress(emit, 'save', 98, 'Сохраняем аватар')
  await saveAvatar(userId, finalConfig)
  await emitProgress(emit, 'done', 100, 'Аватар готов')
  return { avatar: finalConfig, trellis, autorig }
}

function terminalAvatarJobDelay(job: AvatarGenerationJob) {
  return job.status === 'running' ? AVATAR_GENERATION_ACTIVE_TTL_MS : AVATAR_GENERATION_JOB_TTL_MS
}

function scheduleAvatarJobCleanup(job: AvatarGenerationJob) {
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer)
  job.cleanupTimer = setTimeout(() => {
    const current = avatarGenerationJobs.get(job.userId)
    if (current?.id === job.id) avatarGenerationJobs.delete(job.userId)
  }, terminalAvatarJobDelay(job))
}

function isExpiredRunningAvatarJob(job: AvatarGenerationJob) {
  return job.status === 'running' && Date.now() - job.createdAt > AVATAR_GENERATION_ACTIVE_TTL_MS
}

function avatarJobSnapshot(job: AvatarGenerationJob) {
  const lastEvent = job.events.at(-1) ?? null
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastEvent,
    result: lastEvent?.type === 'result' ? lastEvent.result ?? null : null,
  }
}

async function publishAvatarJobEvent(job: AvatarGenerationJob, event: AvatarPipelineEvent) {
  job.events.push(event)
  job.updatedAt = Date.now()

  for (const subscriber of Array.from(job.subscribers)) {
    try {
      await subscriber(event)
    } catch {
      job.subscribers.delete(subscriber)
    }
  }
}

function startAvatarGenerationJob(userId: string, body: GenerateAvatarBody) {
  const existing = avatarGenerationJobs.get(userId)
  if (existing?.status === 'running' && !isExpiredRunningAvatarJob(existing)) return existing
  if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer)

  const job: AvatarGenerationJob = {
    id: randomUUID(),
    userId,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    events: [],
    subscribers: new Set(),
    promise: Promise.resolve(),
    cleanupTimer: null,
  }

  avatarGenerationJobs.set(userId, job)
  scheduleAvatarJobCleanup(job)
  job.promise = runAvatarGenerationJob(job, body)
  return job
}

async function runAvatarGenerationJob(job: AvatarGenerationJob, body: GenerateAvatarBody) {
  const emit: AvatarProgressEmit = (event) => publishAvatarJobEvent(job, event)

  try {
    await emitAvatarProgress(emit, {
      type: 'progress',
      stage: 'source',
      progress: 5,
      message: 'Готовим исходное фото',
      sourceImage: body.fullbodyImage,
    })
    await emitAvatarProgress(emit, {
      type: 'progress',
      stage: 'fallback',
      progress: 22,
      message: 'Быстрый аватар готов',
      sourceImage: body.fullbodyImage,
    })

    const prepared = await prepareSingleModelPhoto(body.fullbodyImage, emit)
    const result = await generateAndSaveAvatarFromTrellisImages(
      job.userId,
      body.fallbackConfig,
      [prepared.image],
      emit,
    )
    await emitAvatarProgress(emit, {
      type: 'result',
      stage: 'done',
      progress: 100,
      message: 'Аватар готов',
      result: { ...result, prepared },
    })
    job.status = 'succeeded'
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Avatar generation failed'
    job.status = 'failed'
    console.error('[Avatar stream] Error:', message)
    await emitAvatarProgress(emit, {
      type: 'error',
      stage: 'failed',
      progress: 100,
      message,
    })
  } finally {
    job.updatedAt = Date.now()
    scheduleAvatarJobCleanup(job)
  }
}

async function writeAvatarSseEvent(
  stream: { writeSSE: (message: { event: string; data: string }) => Promise<void> },
  event: AvatarPipelineEvent,
) {
  await stream.writeSSE({
    event: event.type,
    data: JSON.stringify(event),
  })
}

async function streamAvatarGenerationJob(
  stream: {
    writeSSE: (message: { event: string; data: string }) => Promise<void>
    onAbort?: (callback: () => void) => void
  },
  job: AvatarGenerationJob,
) {
  for (const event of job.events) {
    await writeAvatarSseEvent(stream, event)
  }

  if (job.status !== 'running') return

  let done = false
  const subscriber: AvatarGenerationSubscriber = async (event) => {
    await writeAvatarSseEvent(stream, event)
    if (event.type === 'result' || event.type === 'error') done = true
  }
  job.subscribers.add(subscriber)

  await new Promise<void>((resolve) => {
    const finish = () => {
      done = true
      job.subscribers.delete(subscriber)
      resolve()
    }

    stream.onAbort?.(finish)
    const interval = setInterval(() => {
      if (done || job.status !== 'running' || !job.subscribers.has(subscriber)) {
        clearInterval(interval)
        finish()
      }
    }, 500)
  })
}

/**
 * POST /avatar/prepare-images
 * Runs KIE GPT Image 2 I2I and returns the generated 4:3 sheet plus the 3 PNG views
 * that will be sent into TRELLIS.
 */
avatarRouter.post('/prepare-images', async (c) => {
  const auth = await getAuthedUser(c.req.header('Authorization'))
  if (!auth.user) return c.json({ error: auth.error }, 401)

  const body = await c.req.json<PrepareTrellisImagesBody>().catch(() => null)
  if (!body?.fullbodyImage) {
    return c.json({ error: 'fullbodyImage required' }, 400)
  }

  if (!isImageDataUrl(body.fullbodyImage) || body.fullbodyImage.length > MAX_IMAGE_DATA_URL_BYTES) {
    return c.json({ error: 'fullbodyImage must be a compressed image data URL' }, 400)
  }

  try {
    const prepared = await prepareTrellisImages(body.fullbodyImage)
    return c.json({ prepared })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'KIE image preparation failed'
    console.error('[Avatar KIE] Prepare error:', message)
    return c.json({ error: message }, 500)
  }
})

/**
 * POST /avatar/generate-from-images
 * Generates a TRELLIS avatar from already prepared single/multi-image inputs.
 */
avatarRouter.post('/generate-from-images', async (c) => {
  const auth = await getAuthedUser(c.req.header('Authorization'))
  if (!auth.user) return c.json({ error: auth.error }, 401)

  const body = await c.req.json<GeneratePreparedAvatarBody>().catch(() => null)
  if (!body?.fallbackConfig || !Array.isArray(body.trellisImages)) {
    return c.json({ error: 'trellisImages and fallbackConfig required' }, 400)
  }

  if (!areImageDataUrls(body.trellisImages)) {
    return c.json({ error: 'trellisImages must contain 1-3 compressed image data URLs' }, 400)
  }

  if (!isAvatarConfig(body.fallbackConfig)) {
    return c.json({ error: 'fallbackConfig invalid' }, 400)
  }

  try {
    return c.json(await generateAndSaveAvatarFromTrellisImages(auth.user.id, body.fallbackConfig, body.trellisImages))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Avatar save failed'
    console.error('[Avatar] Generate-from-images error:', message)
    return c.json({ error: message }, 500)
  }
})

/**
 * POST /avatar/generate-stream
 * Starts or resumes the user's server-side avatar generation job and streams progress.
 */
avatarRouter.post('/generate-stream', async (c) => {
  const auth = await getAuthedUser(c.req.header('Authorization'))
  if (!auth.user) return c.json({ error: auth.error }, 401)
  const user = auth.user

  const body = await c.req.json<GenerateAvatarBody>().catch(() => null)
  if (!body?.fullbodyImage || !body?.fallbackConfig) {
    return c.json({ error: 'fullbodyImage and fallbackConfig required' }, 400)
  }

  if (!isImageDataUrl(body.fullbodyImage) || body.fullbodyImage.length > MAX_IMAGE_DATA_URL_BYTES) {
    return c.json({ error: 'fullbodyImage must be a compressed image data URL' }, 400)
  }

  if (!isAvatarConfig(body.fallbackConfig)) {
    return c.json({ error: 'fallbackConfig invalid' }, 400)
  }

  const job = startAvatarGenerationJob(user.id, body)
  return streamSSE(c, async (stream) => {
    await streamAvatarGenerationJob(stream, job)
  }, async (error, stream) => {
    await stream.writeSSE({
      event: 'error',
      data: JSON.stringify({
        type: 'error',
        stage: 'failed',
        progress: 100,
        message: error.message,
      } satisfies AvatarPipelineEvent),
    })
  })
})

avatarRouter.get('/generate-stream', async (c) => {
  const auth = await getAuthedUser(c.req.header('Authorization'))
  if (!auth.user) return c.json({ error: auth.error }, 401)

  const job = avatarGenerationJobs.get(auth.user.id)
  if (!job || isExpiredRunningAvatarJob(job)) {
    if (job) avatarGenerationJobs.delete(auth.user.id)
    return c.json({ error: 'No active avatar generation job' }, 404)
  }

  return streamSSE(c, async (stream) => {
    await streamAvatarGenerationJob(stream, job)
  }, async (error, stream) => {
    await stream.writeSSE({
      event: 'error',
      data: JSON.stringify({
        type: 'error',
        stage: 'failed',
        progress: 100,
        message: error.message,
      } satisfies AvatarPipelineEvent),
    })
  })
})

avatarRouter.get('/generation-status', async (c) => {
  const auth = await getAuthedUser(c.req.header('Authorization'))
  if (!auth.user) return c.json({ error: auth.error }, 401)

  const job = avatarGenerationJobs.get(auth.user.id)
  if (!job || isExpiredRunningAvatarJob(job)) {
    if (job) avatarGenerationJobs.delete(auth.user.id)
    return c.json({ active: false })
  }

  return c.json({ active: true, job: avatarJobSnapshot(job) })
})

/**
 * POST /avatar/generate
 * Создает аватар из уже сжатого fullbody photo через TRELLIS.
 * Если worker не настроен или упал, сохраняет переданный procedural fallback.
 * Header: Authorization: Bearer <supabase-jwt>
 * Body: { fullbodyImage: dataUrl, fallbackConfig: AvatarConfig }
 */
avatarRouter.post('/generate', async (c) => {
  const auth = await getAuthedUser(c.req.header('Authorization'))
  if (!auth.user) return c.json({ error: auth.error }, 401)
  const user = auth.user

  const body = await c.req.json<GenerateAvatarBody>().catch(() => null)
  if (!body?.fullbodyImage || !body?.fallbackConfig) {
    return c.json({ error: 'fullbodyImage and fallbackConfig required' }, 400)
  }

  if (!isImageDataUrl(body.fullbodyImage) || body.fullbodyImage.length > MAX_IMAGE_DATA_URL_BYTES) {
    return c.json({ error: 'fullbodyImage must be a compressed image data URL' }, 400)
  }

  if (!isAvatarConfig(body.fallbackConfig)) {
    return c.json({ error: 'fallbackConfig invalid' }, 400)
  }

  try {
    const prepared = await prepareSingleModelPhoto(body.fullbodyImage)
    const result = await generateAndSaveAvatarFromTrellisImages(
      user.id,
      body.fallbackConfig,
      [prepared.image],
    )
    return c.json({ ...result, prepared })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Avatar save failed'
    console.error('[Avatar] Save error:', message)
    return c.json({ error: message }, 500)
  }
})

/**
 * POST /avatar/mirror-model
 * Browser-side Gradio generation uses the player's own IP/quota and returns a temporary HF file URL.
 * This endpoint only mirrors that GLB into Supabase Storage; it does not call ZeroGPU.
 */
avatarRouter.post('/mirror-model', async (c) => {
  const auth = await getAuthedUser(c.req.header('Authorization'))
  if (!auth.user) return c.json({ error: auth.error }, 401)
  const user = auth.user

  const body = await c.req.json<MirrorModelBody>().catch(() => null)
  if (!body?.modelUrl || typeof body.modelUrl !== 'string') {
    return c.json({ error: 'modelUrl required' }, 400)
  }

  if (!isAllowedTrellisModelUrl(body.modelUrl) || !body.modelUrl.toLowerCase().includes('.glb')) {
    return c.json({ error: 'modelUrl must be a TRELLIS GLB file URL' }, 400)
  }

  try {
    const modelOrigin = new URL(body.modelUrl).origin
    const modelUrl = await uploadModelFromUrl(user.id, body.modelUrl, modelOrigin)
    const autorig = await applyBlenderAutorig(user.id, modelUrl)
    return c.json({
      modelUrl: BLENDER_AUTORIG_REPLACE_MODEL_URL && autorig.status === 'generated' && autorig.modelUrl
        ? autorig.modelUrl
        : modelUrl,
      format: 'glb',
      triangleCount: null,
      autorig,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Model mirror failed'
    console.error('[Avatar Pixal3D] Mirror error:', message)
    return c.json({ error: message }, 500)
  }
})

/**
 * POST /avatar/upload-model
 * Browser fallback for public Hugging Face temp files: if the API host cannot fetch
 * the temporary GLB URL directly, the browser uploads the GLB bytes it can read.
 */
avatarRouter.post('/upload-model', async (c) => {
  const auth = await getAuthedUser(c.req.header('Authorization'))
  if (!auth.user) return c.json({ error: auth.error }, 401)

  const contentLength = Number(c.req.header('content-length') || 0)
  if (contentLength > MAX_MODEL_UPLOAD_BYTES) {
    return c.json({ error: `GLB upload too large: max ${Math.round(MAX_MODEL_UPLOAD_BYTES / 1_000_000)}MB` }, 413)
  }

  try {
    const bytes = await c.req.arrayBuffer()
    if (!bytes.byteLength) return c.json({ error: 'GLB upload body is empty' }, 400)
    if (bytes.byteLength > MAX_MODEL_UPLOAD_BYTES) {
      return c.json({ error: `GLB upload too large: max ${Math.round(MAX_MODEL_UPLOAD_BYTES / 1_000_000)}MB` }, 413)
    }
    if (!isGlbBytes(bytes)) return c.json({ error: 'Uploaded model must be a GLB binary' }, 400)

    const contentType = c.req.header('content-type') || 'model/gltf-binary'
    return c.json(await uploadAndMaybeAutorigModelBytes(auth.user.id, bytes, contentType))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Model upload failed'
    console.error('[Avatar Pixal3D] Browser model upload error:', message)
    return c.json({ error: message }, 500)
  }
})

/**
 * DELETE /avatar/originals
 * Удаляет оригинальные фото из Supabase Storage.
 * Вызывается после генерации аватара.
 * Header: Authorization: Bearer <supabase-jwt>
 * Body: { paths: string[] }  — пути файлов в bucket 'temp-photos'
 */
avatarRouter.delete('/originals', async (c) => {
  const auth = await getAuthedUser(c.req.header('Authorization'))
  if (!auth.user) return c.json({ error: auth.error }, 401)
  const user = auth.user

  const { paths } = await c.req.json<{ paths: string[] }>()
  if (!paths?.length) return c.json({ error: 'paths required' }, 400)

  // Удаляем только файлы, принадлежащие этому пользователю (путь должен начинаться с user.id)
  const safePaths = paths.filter((p) => p.startsWith(user.id + '/'))

  if (safePaths.length === 0) {
    return c.json({ error: 'No valid paths' }, 400)
  }

  const { error: deleteError } = await supabase.storage
    .from('temp-photos')
    .remove(safePaths)

  if (deleteError) {
    console.error('[Avatar cleanup] Error:', deleteError)
    return c.json({ error: deleteError.message }, 500)
  }

  console.log(`[Avatar cleanup] Deleted ${safePaths.length} originals for user ${user.id}`)
  return c.json({ deleted: safePaths.length })
})
