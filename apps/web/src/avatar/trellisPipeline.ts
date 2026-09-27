import type { AvatarConfig } from '@shared/types'
import { Client, handle_file } from '@gradio/client'
import { supabase } from '@/utils/supabase'
import { resolveRuntimeUrl } from '@/utils/runtimeUrls'

const API_URL = resolveRuntimeUrl(import.meta.env.VITE_API_URL || 'http://localhost:3001', {
  httpProtocol: 'http:',
  httpsProtocol: 'https:',
})
const PIXAL3D_SPACE_ID = 'TencentARC/Pixal3D'
const PIXAL3D_SERVER_SPACE_ID = 'TencentARC/Pixal3D-Server'
const HF_PIXAL3D_SPACE_ID = import.meta.env.VITE_HF_PIXAL3D_SPACE_ID || PIXAL3D_SPACE_ID
const HF_PIXAL3D_SPACE_URL = makeHuggingFaceSpaceUrl(HF_PIXAL3D_SPACE_ID)
const HF_PIXAL3D_SERVER_DISCOVERY_URL = import.meta.env.VITE_HF_PIXAL3D_SERVER_DISCOVERY_URL || HF_PIXAL3D_SPACE_URL
const HF_PIXAL3D_CONFIGURED_INSTANCE_URLS = parsePixal3dInstanceUrls(
  import.meta.env.VITE_HF_PIXAL3D_INSTANCE_URLS || import.meta.env.VITE_HF_PIXAL3D_INSTANCE_URL || ''
)
const HF_PIXAL3D_DISCOVERY_TIMEOUT_MS = Number(import.meta.env.VITE_HF_PIXAL3D_DISCOVERY_TIMEOUT_MS || 15_000)
const HF_PIXAL3D_QUEUE_TIMEOUT_MS = Number(import.meta.env.VITE_HF_PIXAL3D_QUEUE_TIMEOUT_MS || 5_000)
const HF_PIXAL3D_CONNECT_TIMEOUT_MS = Number(import.meta.env.VITE_HF_PIXAL3D_CONNECT_TIMEOUT_MS || 45_000)
const HF_PIXAL3D_INSTANCE_CACHE_MS = Number(import.meta.env.VITE_HF_PIXAL3D_INSTANCE_CACHE_MS || 30_000)
const HF_GENERATE_TIMEOUT_MS = Number(
  import.meta.env.VITE_PIXAL3D_GENERATE_TIMEOUT_MS || import.meta.env.VITE_TRELLIS_GENERATE_TIMEOUT_MS || 300_000
)
const MAX_PIXAL3D_SEED = 2_147_483_647
const PIXAL3D_DECIMATION_TARGET = numberFromEnv(import.meta.env.VITE_TRELLIS_DECIMATION_TARGET || import.meta.env.VITE_PIXAL3D_DECIMATION_TARGET, 300_000)
const PIXAL3D_TEXTURE_SIZE = numberFromEnv(import.meta.env.VITE_TRELLIS_TEXTURE_SIZE || import.meta.env.VITE_PIXAL3D_TEXTURE_SIZE, 2048)
const PIXAL3D_HF_GENERATION_SETTINGS = {
  seed: 0,
  resolution: numberFromEnv(import.meta.env.VITE_PIXAL3D_GENERATION_RESOLUTION, 1024),
  randomizeSeed: true,
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
  meshSimplify: Number(import.meta.env.VITE_TRELLIS_MESH_SIMPLIFY || 0.9),
  multiimageAlgo: 'stochastic',
  manualFov: -1,
  fovUnit: 'deg',
} as const

let cachedPixal3dInstanceUrls: { urls: string[]; expiresAt: number } | null = null

function numberFromEnv(raw: unknown, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

interface Pixal3dTarget {
  reference: string
  url: string
  name: string
  queueSize: number | null
}

type BrowserGradioClient = Awaited<ReturnType<typeof Client.connect>>

interface BrowserPixal3dClient {
  gradio: BrowserGradioClient
  baseUrl: string
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

export interface TrellisAvatarResult {
  avatar: AvatarConfig
  trellis: {
    status: 'generated' | 'skipped' | 'failed'
    modelUrl?: string
    format?: string
    triangleCount?: number | null
    error?: string
  }
  autorig?: AvatarConfig['autorig']
}

export interface PreparedTrellisImages {
  source: 'kie' | 'source'
  sheetImage: string | null
  images: string[]
}

export interface PreparedModelPhoto {
  source: 'kie' | 'source'
  image: string
  originalImage: string | null
}

interface PreparedModelPhotoJobResponse {
  status: 'running' | 'succeeded' | 'failed'
  prepared?: PreparedModelPhoto
  pixalImage?: unknown
  error?: string
}

export type AvatarPipelineStage =
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

export interface AvatarPipelineEvent {
  type: 'progress' | 'prepared' | 'result' | 'error'
  stage: AvatarPipelineStage
  progress: number
  message: string
  sourceImage?: string
  prepared?: PreparedModelPhoto
  result?: StreamedTrellisAvatarResult
}

export type StreamedTrellisAvatarResult = TrellisAvatarResult & {
  prepared?: PreparedModelPhoto
}

export interface AvatarGenerationStatus {
  active: boolean
  job?: {
    id: string
    status: 'running' | 'succeeded' | 'failed'
    createdAt: number
    updatedAt: number
    lastEvent: AvatarPipelineEvent | null
    result: StreamedTrellisAvatarResult | null
  }
}

export async function generateTrellisAvatar(
  fullbodyImage: string,
  fallbackConfig: AvatarConfig,
): Promise<TrellisAvatarResult> {
  return apiJson<TrellisAvatarResult>('/avatar/generate', {
    method: 'POST',
    body: JSON.stringify({ fullbodyImage, fallbackConfig }),
  })
}

export async function generateTrellisAvatarStream(
  fullbodyImage: string,
  fallbackConfig: AvatarConfig,
  onEvent: (event: AvatarPipelineEvent) => void,
): Promise<StreamedTrellisAvatarResult> {
  return openTrellisAvatarStream(onEvent, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullbodyImage, fallbackConfig }),
  })
}

export async function resumeTrellisAvatarStream(
  onEvent: (event: AvatarPipelineEvent) => void,
): Promise<StreamedTrellisAvatarResult> {
  return openTrellisAvatarStream(onEvent, { method: 'GET' })
}

export async function getTrellisAvatarGenerationStatus(): Promise<AvatarGenerationStatus> {
  const accessToken = await getFreshAccessToken()
  if (!accessToken) return { active: false }

  const response = await fetch(`${API_URL}/avatar/generation-status`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => null)

  if (!response?.ok) return { active: false }
  return response.json() as Promise<AvatarGenerationStatus>
}

async function openTrellisAvatarStream(
  onEvent: (event: AvatarPipelineEvent) => void,
  init: RequestInit,
): Promise<StreamedTrellisAvatarResult> {
  const accessToken = await getFreshAccessToken()
  if (!accessToken) throw new Error('Нужна авторизация для генерации 3D-модели')

  const response = await fetch(`${API_URL}/avatar/generate-stream`, {
    ...init,
    headers: {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
  }).catch((error) => {
    throw new Error(
      `Не удалось подключиться к API ${API_URL}. Запусти pnpm dev:api или общий pnpm dev. ${error?.message ?? ''}`.trim()
    )
  })

  if (!response.ok) {
    throw new Error(await readApiError(response, `API error: ${response.status}`))
  }

  if (!response.body) throw new Error('API did not return a generation stream')

  let result: StreamedTrellisAvatarResult | null = null
  for await (const event of readSseEvents(response.body)) {
    onEvent(event)
    if (event.type === 'error') throw new Error(event.message)
    if (event.type === 'result' && event.result) result = event.result
  }

  if (!result) throw new Error('Avatar generation stream ended without a result')
  return result
}

async function* readSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<AvatarPipelineEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      let block = takeSseBlock(buffer)
      while (block) {
        buffer = block.rest
        const event = parseSseBlock(block.value)
        if (event) yield event
        block = takeSseBlock(buffer)
      }
    }

    buffer += decoder.decode()
    const event = parseSseBlock(buffer)
    if (event) yield event
  } finally {
    reader.releaseLock()
  }
}

function takeSseBlock(buffer: string): { value: string; rest: string } | null {
  const match = buffer.match(/\r?\n\r?\n/)
  if (!match || match.index === undefined) return null

  return {
    value: buffer.slice(0, match.index),
    rest: buffer.slice(match.index + match[0].length),
  }
}

function parseSseBlock(block: string): AvatarPipelineEvent | null {
  if (!block.trim()) return null

  let eventName = 'message'
  const dataLines: string[] = []
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim()
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }

  const data = dataLines.join('\n')
  if (!data) return null

  try {
    const parsed = JSON.parse(data) as Partial<AvatarPipelineEvent>
    const fallbackType = eventName === 'error' ? 'error' : 'progress'
    return {
      type: parsed.type ?? fallbackType,
      stage: parsed.stage ?? (fallbackType === 'error' ? 'failed' : 'done'),
      progress: typeof parsed.progress === 'number' ? parsed.progress : 0,
      message: typeof parsed.message === 'string' ? parsed.message : data,
      sourceImage: typeof parsed.sourceImage === 'string' ? parsed.sourceImage : undefined,
      prepared: parsed.prepared,
      result: parsed.result,
    }
  } catch {
    return {
      type: 'error',
      stage: 'failed',
      progress: 100,
      message: data,
    }
  }
}

export async function prepareTrellisImages(fullbodyImage: string): Promise<{ prepared: PreparedTrellisImages }> {
  const accessToken = await getFreshAccessToken()
  if (!accessToken) throw new Error('Нужна авторизация для подготовки KIE-ракурсов')

  const response = await fetch(`${API_URL}/avatar/prepare-images`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ fullbodyImage }),
  }).catch((error) => {
    throw new Error(
      `Не удалось подключиться к API ${API_URL}. Запусти pnpm dev:api или общий pnpm dev. ${error?.message ?? ''}`.trim()
    )
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({} as { error?: string }))
    if (response.status === 401) {
      throw new Error(`API не принял Supabase-сессию: ${body.error || 'Unauthorized'}`)
    }
    throw new Error(body.error || `KIE preparation error: ${response.status}`)
  }

  return response.json() as Promise<{ prepared: PreparedTrellisImages }>
}

/**
 * KIE and the non-GPU file upload run on the API to keep keys private and avoid
 * Safari's unreliable cross-origin multipart upload. generate_3d itself still
 * runs in the visitor's browser and uses that visitor's ZeroGPU allowance.
 */
export async function prepareTrellisModelPhoto(fullbodyImage: string): Promise<{
  prepared: PreparedModelPhoto
  pixalImage: unknown
}> {
  const requestId = makePixal3dSessionId()
  const started = await retryTransientApiRequest(() => apiJson<PreparedModelPhotoJobResponse>('/avatar/prepare-model-photo', {
    method: 'POST',
    body: JSON.stringify({ fullbodyImage, requestId, poll: true }),
  }))
  const initialResult = unwrapPreparedModelPhotoJob(started)
  if (initialResult) return initialResult

  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    await waitFor(2_500)
    try {
      const status = await apiJson<PreparedModelPhotoJobResponse>(`/avatar/prepare-model-photo/${encodeURIComponent(requestId)}`, {
        method: 'GET',
      })
      const result = unwrapPreparedModelPhotoJob(status)
      if (result) return result
    } catch (error) {
      if (!isTransientApiConnectionError(error)) throw error
      // The background job is still running on Railway; keep polling after a
      // short network interruption instead of losing the prepared KIE result.
    }
  }

  throw new Error('Подготовка фото заняла слишком много времени. Попробуй ещё раз.')
}

function unwrapPreparedModelPhotoJob(response: PreparedModelPhotoJobResponse) {
  if (response.status === 'failed') throw new Error(response.error || 'Не удалось подготовить фото')
  if (response.status !== 'succeeded') return null
  if (!response.prepared || !response.pixalImage) throw new Error('Подготовленное фото не получено')
  return { prepared: response.prepared, pixalImage: response.pixalImage }
}

async function retryTransientApiRequest<T>(request: () => Promise<T>): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await request()
    } catch (error) {
      lastError = error
      if (attempt === 2 || !isTransientApiConnectionError(error)) throw error
      await waitFor(1_500)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Не удалось подключиться к API')
}

function isTransientApiConnectionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /failed to fetch|fetch failed|networkerror|network request failed|timed out/i.test(message)
}

function waitFor(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export async function generateTrellisAvatarFromPreparedImages(
  trellisImages: string[],
  fallbackConfig: AvatarConfig,
): Promise<TrellisAvatarResult> {
  const accessToken = await getFreshAccessToken()
  if (!accessToken) throw new Error('Нужна авторизация для генерации аватара')

  const response = await fetch(`${API_URL}/avatar/generate-from-images`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ trellisImages, fallbackConfig }),
  }).catch((error) => {
    throw new Error(
      `Не удалось подключиться к API ${API_URL}. Запусти pnpm dev:api или общий pnpm dev. ${error?.message ?? ''}`.trim()
    )
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({} as { error?: string }))
    if (response.status === 401) {
      throw new Error(`API не принял Supabase-сессию: ${body.error || 'Unauthorized'}`)
    }
    throw new Error(body.error || `Avatar generation error: ${response.status}`)
  }

  return response.json() as Promise<TrellisAvatarResult>
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
      // Regex extraction below still covers the rendered cards.
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

async function discoverPixal3dInstanceUrls(): Promise<string[]> {
  if (HF_PIXAL3D_CONFIGURED_INSTANCE_URLS.length) return HF_PIXAL3D_CONFIGURED_INSTANCE_URLS

  const directUrl = normalizePixal3dInstanceUrl(HF_PIXAL3D_SPACE_ID) || normalizePixal3dInstanceUrl(HF_PIXAL3D_SPACE_URL)
  if (directUrl && !directUrl.includes('pixal3d-server')) return [directUrl]

  if (cachedPixal3dInstanceUrls && cachedPixal3dInstanceUrls.expiresAt > Date.now()) {
    return cachedPixal3dInstanceUrls.urls
  }

  const response = await withTimeout(fetch(HF_PIXAL3D_SERVER_DISCOVERY_URL), HF_PIXAL3D_DISCOVERY_TIMEOUT_MS, 'Pixal3D-Server discovery')
  if (!response.ok) throw new Error(`Pixal3D-Server discovery failed: ${response.status}`)

  let urls = extractPixal3dInstanceUrls(await response.text())
  if (!urls.length) {
    const configResponse = await withTimeout(
      fetch(new URL('/config', HF_PIXAL3D_SERVER_DISCOVERY_URL).toString()),
      HF_PIXAL3D_DISCOVERY_TIMEOUT_MS,
      'Pixal3D-Server config discovery',
    )
    if (configResponse.ok) urls = extractPixal3dInstanceUrls(await configResponse.text())
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
  const response = await withTimeout(
    fetch(new URL('/queue?session_id=', target.url).toString()),
    HF_PIXAL3D_QUEUE_TIMEOUT_MS,
    `Pixal3D queue check (${target.name})`,
  )
  if (!response.ok) throw new Error(`Pixal3D queue check failed: ${response.status}`)

  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  const totalWaitingValue = Number(data.total_waiting)
  const totalWaiting = Number.isFinite(totalWaitingValue) ? totalWaitingValue : 0
  return Math.max(0, totalWaiting) + (data.gpu_busy ? 1 : 0)
}

async function selectPixal3dTarget(): Promise<Pixal3dTarget> {
  const targets = await getPixal3dTargets()
  const checked = await Promise.all(targets.map(async (target) => {
    try {
      return { ...target, queueSize: await readPixal3dQueueSize(target) }
    } catch {
      return target
    }
  }))

  const online = checked.filter((target) => target.queueSize !== null)
  if (online.length) return online.sort((a, b) => (a.queueSize ?? 0) - (b.queueSize ?? 0))[0]
  return checked[0]
}

function getGradioNamedEndpoint(apiInfo: unknown, endpoint: string): GradioEndpointInfo | null {
  const typedApiInfo = apiInfo as GradioApiInfo | undefined
  const namedEndpoints = typedApiInfo?.named_endpoints
  if (!namedEndpoints) return null

  const trimmed = endpoint.replace(/^\//, '')
  return namedEndpoints[endpoint] ?? namedEndpoints[trimmed] ?? namedEndpoints[`/${trimmed}`] ?? null
}

function filterGradioEndpointArgs(
  gradio: BrowserGradioClient,
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

async function connectBrowserPixal3dClient(): Promise<BrowserPixal3dClient> {
  const target = await selectPixal3dTarget()
  return {
    gradio: await withTimeout(
      // Use the resolved Space origin directly. Passing an owner/space id makes
      // @gradio/client first fetch huggingface.co/api/spaces/.../host, which is
      // an unnecessary cross-origin hop and is unreliable in mobile browsers.
      Client.connect(target.url),
      HF_PIXAL3D_CONNECT_TIMEOUT_MS,
      `TRELLIS connect (${target.name})`,
    ),
    baseUrl: target.url,
  }
}

export async function generateBrowserTrellisAvatar(
  fullbodyImage: string,
  fallbackConfig: AvatarConfig,
): Promise<TrellisAvatarResult> {
  let gradio: Awaited<ReturnType<typeof Client.connect>> | null = null
  const sessionId = makePixal3dSessionId()

  try {
    const pixal3d = await connectBrowserPixal3dClient()
    gradio = pixal3d.gradio
    const singleImageGeneration = await generateHuggingFaceSingleImageGlb(gradio, fullbodyImage, sessionId, pixal3d.baseUrl)
    const generated = singleImageGeneration.generated

    const temporaryModelUrl = findGlbUrl(generated.data, pixal3d.baseUrl)
    if (!temporaryModelUrl) throw new Error('Hugging Face TRELLIS response missing GLB URL')

    const mirrored = await mirrorTrellisModel(temporaryModelUrl)
    return {
      avatar: {
        ...fallbackConfig,
        modelUrl: mirrored.modelUrl,
        rpmGlbUrl: null,
        autorig: mirrored.autorig,
      },
      trellis: {
        status: 'generated',
        modelUrl: mirrored.modelUrl,
        format: mirrored.format,
        triangleCount: mirrored.triangleCount,
        error: singleImageGeneration.fallbackReason,
      },
      autorig: mirrored.autorig,
    }
  } catch (error) {
    const message = formatGradioError(error)
    return {
      avatar: fallbackConfig,
      trellis: {
        status: 'failed',
        error: message,
      },
    }
  } finally {
    gradio?.close()
  }
}

export async function generateBrowserTrellisAvatarFromPreparedImages(
  trellisImages: unknown[],
  fallbackConfig: AvatarConfig,
  onProgress?: (progress: Pick<AvatarPipelineEvent, 'stage' | 'progress' | 'message'>) => void,
): Promise<TrellisAvatarResult> {
  const firstImage = trellisImages[0]
  if (!firstImage) {
    return {
      avatar: fallbackConfig,
      trellis: {
        status: 'failed',
        error: 'Hugging Face TRELLIS requires at least one image',
      },
    }
  }

  const sessionId = makePixal3dSessionId()
  let phase = 'подключение к 3D-сервису'

  try {
    // Do not use @gradio/client for the public Space here. Its initial
    // discovery request intermittently fails in Safari/mobile browsers even
    // though the Space API itself is available. These are direct browser
    // requests to Pixal3D, so the visitor's own ZeroGPU allowance is used.
    const baseUrl = HF_PIXAL3D_SPACE_URL
    emitBrowserTrellisProgress(onProgress, 'trellis_connect', 62, 'Подключаемся к 3D-сервису с вашего устройства')

    phase = 'запуск 3D-сборки'
    emitBrowserTrellisProgress(onProgress, 'trellis_session', 66, 'Фото подготовлено, ожидаем запуск 3D-сборки')
    const generated = await callBrowserGradioEndpoint(
      'generate_3d',
      makePixal3dGenerateData(firstImage, sessionId),
      HF_GENERATE_TIMEOUT_MS,
      baseUrl,
    )

    phase = '3D-сборка'
    emitBrowserTrellisProgress(onProgress, 'trellis_generate', 82, 'Собираем и текстурируем 3D-модель')
    const statePath = findPixal3dStatePath(generated)
    if (!statePath) throw new Error('Pixal3D returned no generated model state')
    const extracted = await callBrowserGradioEndpoint(
      'extract_glb_api',
      makePixal3dExtractData(statePath, sessionId),
      HF_GENERATE_TIMEOUT_MS,
      baseUrl,
    )
    const temporaryModelUrl = findGlbUrl(extracted, baseUrl)
    if (!temporaryModelUrl) throw new Error('Pixal3D returned no GLB file')

    phase = 'сохранение готовой 3D-модели'
    emitBrowserTrellisProgress(onProgress, 'trellis_upload', 92, 'Сохраняем готовую 3D-модель')
    const mirrored = await mirrorTrellisModel(temporaryModelUrl)
    return {
      avatar: {
        ...fallbackConfig,
        modelUrl: mirrored.modelUrl,
        rpmGlbUrl: null,
        autorig: mirrored.autorig,
      },
      trellis: {
        status: 'generated',
        modelUrl: mirrored.modelUrl,
        format: mirrored.format,
        triangleCount: mirrored.triangleCount,
      },
      autorig: mirrored.autorig,
    }
  } catch (error) {
    const message = formatGradioError(error)
    return {
      avatar: fallbackConfig,
      trellis: {
        status: 'failed',
        error: `${phase}: ${message}`,
      },
    }
  }
}

function emitBrowserTrellisProgress(
  onProgress: ((progress: Pick<AvatarPipelineEvent, 'stage' | 'progress' | 'message'>) => void) | undefined,
  stage: AvatarPipelineStage,
  progress: number,
  message: string,
) {
  onProgress?.({ stage, progress, message })
}

async function callBrowserGradioEndpoint(
  endpoint: 'generate_3d' | 'extract_glb_api',
  data: unknown[],
  timeoutMs: number,
  baseUrl: string,
): Promise<unknown> {
  const label = `Pixal3D ${endpoint}`
  const callResponse = await withTimeout(
    fetch(`${baseUrl}/gradio_api/call/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    }),
    HF_PIXAL3D_CONNECT_TIMEOUT_MS,
    label,
  )
  if (!callResponse.ok) {
    throw new Error(`${label} request failed: ${callResponse.status} ${await callResponse.text().catch(() => '')}`.trim())
  }

  const call = await callResponse.json().catch(() => null) as { event_id?: unknown } | null
  if (typeof call?.event_id !== 'string' || !call.event_id) throw new Error(`${label} returned no event id`)

  const responseText = await withTimeout(
    fetch(`${baseUrl}/gradio_api/call/${endpoint}/${encodeURIComponent(call.event_id)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`${label} result failed: ${response.status} ${await response.text().catch(() => '')}`.trim())
        return response.text()
      }),
    timeoutMs,
    label,
  )
  return parseBrowserGradioSse(responseText, label)
}

function parseBrowserGradioSse(text: string, label: string): unknown {
  let result: unknown = null
  for (const event of text.split(/\r?\n\r?\n/)) {
    const type = event.match(/^event:\s*(.+)$/m)?.[1]?.trim()
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    if (!data) continue
    if (type === 'error') throw new Error(`${label} failed: ${data}`)
    try {
      result = JSON.parse(data)
    } catch {
      // Keep waiting for the final JSON payload; progress events can be plain text.
    }
  }
  if (result == null) throw new Error(`${label} returned no result`)
  return result
}

function makePixal3dGenerateData(image: unknown, sessionId: string): unknown[] {
  const args = makePixal3dGenerateArgs(image, sessionId)
  return [
    args.image, args.seed, args.resolution,
    args.ss_guidance_strength, args.ss_guidance_rescale, args.ss_sampling_steps, args.ss_rescale_t,
    args.shape_slat_guidance_strength, args.shape_slat_guidance_rescale, args.shape_slat_sampling_steps, args.shape_slat_rescale_t,
    args.tex_slat_guidance_strength, args.tex_slat_guidance_rescale, args.tex_slat_sampling_steps, args.tex_slat_rescale_t,
    args.manual_fov, args.fov_unit, args.session_id,
  ]
}

function makePixal3dExtractData(statePath: string, sessionId: string): unknown[] {
  const args = makePixal3dExtractGlbArgs(statePath, sessionId)
  return [args.state_path, args.decimation_target, args.texture_size, args.session_id]
}

function makeGradioImageFile(dataUrl: string, fileName: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Invalid image data URL')

  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return handle_file(new File([bytes], fileName, { type: match[1] }))
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

async function generateHuggingFaceSingleImageGlb(
  gradio: Awaited<ReturnType<typeof Client.connect>>,
  fullbodyImage: string,
  sessionId: string,
  baseUrl: string,
) {
  const image = makeGradioImageFile(fullbodyImage, 'doorclub-fullbody.png')
  return generateHuggingFaceSingleImageResult(gradio, image, sessionId, baseUrl)
}

async function preprocessHuggingFaceImage(
  gradio: Awaited<ReturnType<typeof Client.connect>>,
  sourceImage: unknown,
  baseUrl: string,
): Promise<unknown> {
  let preprocessed: Awaited<ReturnType<typeof gradio.predict>>
  try {
    preprocessed = await gradio.predict('/preprocess', { image: sourceImage })
  } catch (error) {
    throw new Error(`TRELLIS preprocess failed: ${formatGradioError(error)}`)
  }

  const images = collectGalleryImages(preprocessed.data)
  if (images.length < 1) {
    throw new Error('TRELLIS preprocess returned no image')
  }

  return reuploadGradioImageForGeneration(images[0], baseUrl, 'doorclub-preprocessed.png')
}

async function reuploadGradioImageForGeneration(
  image: unknown,
  baseUrl: string,
  fileName: string,
): Promise<unknown> {
  const fileUrl = findGradioFileUrl(image, baseUrl)
  if (!fileUrl) return image

  const response = await fetch(fileUrl)
  if (!response.ok) {
    throw new Error(`TRELLIS preprocessed image download failed: ${response.status}`)
  }

  const contentType = response.headers.get('content-type') || getGradioMimeType(image) || 'image/png'
  const blob = await response.blob()
  return handle_file(new File([blob], getGradioFileName(image) || fileName, { type: blob.type || contentType }))
}

function findGradioFileUrl(value: unknown, baseUrl: string): string | null {
  if (!value) return null

  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) return null
    return resolveGradioFileUrl(value, baseUrl)
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGradioFileUrl(item, baseUrl)
      if (found) return found
    }
    return null
  }

  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of ['url', 'path', 'name']) {
    const candidate = record[key]
    if (typeof candidate !== 'string' || !candidate) continue
    const resolved = resolveGradioFileUrl(candidate, baseUrl)
    if (resolved) return resolved
  }

  return null
}

function resolveGradioFileUrl(candidate: string, baseUrl: string): string | null {
  if (/^https?:\/\//i.test(candidate)) return candidate
  if (candidate.startsWith('/gradio_api/file=')) return new URL(candidate, baseUrl).toString()
  if (candidate.startsWith('/file=')) return new URL(`/gradio_api${candidate}`, baseUrl).toString()
  if (candidate.startsWith('/')) return new URL(`/gradio_api/file=${candidate}`, baseUrl).toString()
  return null
}

function getGradioMimeType(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const mimeType = (value as Record<string, unknown>).mime_type
  return typeof mimeType === 'string' && mimeType ? mimeType : null
}

function getGradioFileName(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const origName = (value as Record<string, unknown>).orig_name
  return typeof origName === 'string' && origName ? origName : null
}

async function generateHuggingFaceSingleImageResult(
  gradio: BrowserGradioClient,
  sourceImage: unknown,
  sessionId: string,
  baseUrl: string,
) {
  const generationInputs: Array<{
    getImage: () => Promise<unknown>
    label: string
  }> = [
    { getImage: async () => sourceImage, label: 'prepared image input' },
    {
      getImage: async () => preprocessHuggingFaceImage(gradio, sourceImage, baseUrl),
      label: 'preprocessed image fallback',
    },
  ]
  let lastError: unknown = null

  for (const input of generationInputs) {
    try {
      const generated = await generateTrellisGlb(gradio, await input.getImage(), sessionId)
      return {
        generated,
        fallbackReason: input.label === 'preprocessed image fallback'
          ? `Direct TRELLIS generation failed, used preprocess fallback: ${formatGradioError(lastError)}`
          : undefined,
      }
    } catch (error) {
      lastError = error
      console.warn(`[Avatar TRELLIS] ${input.label} failed:`, formatGradioError(error))
    }
  }

  throw new Error(formatGradioError(lastError))
}

async function generateTrellisGlb(
  gradio: BrowserGradioClient,
  imageForGeneration: unknown,
  sessionId: string,
) {
  const generateArgs = filterGradioEndpointArgs(
    gradio,
    '/generate_3d',
    makePixal3dGenerateArgs(imageForGeneration, sessionId),
  )
  const generated = await withTimeout(
    gradio.predict('/generate_3d', generateArgs),
    HF_GENERATE_TIMEOUT_MS,
    'Hugging Face Pixal3D generate_3d',
  )
  const statePath = findPixal3dStatePath(generated.data)
  if (!statePath) throw new Error('Hugging Face Pixal3D generate_3d returned no state path')

  const extractArgs = filterGradioEndpointArgs(
    gradio,
    '/extract_glb_api',
    makePixal3dExtractGlbArgs(statePath, sessionId),
  )
  return withTimeout(
    gradio.predict('/extract_glb_api', extractArgs),
    HF_GENERATE_TIMEOUT_MS,
    'Hugging Face Pixal3D extract_glb_api',
  )
}

function collectGalleryImages(value: unknown): unknown[] {
  if (!value) return []
  if (isImageLikeValue(value)) return [value]

  if (Array.isArray(value)) {
    if (value.length === 1 && isImageLikeValue(value[0])) return [value[0]]
    if (
      value.length === 2 &&
      isImageLikeValue(value[0]) &&
      !isImageLikeValue(value[1]) &&
      (value[1] == null || typeof value[1] === 'string')
    ) {
      return [value[0]]
    }
    return value.flatMap((item) => collectGalleryImages(item))
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('image' in record) return collectGalleryImages(record.image)
    if ('video' in record) return []
    return Object.values(record).flatMap((item) => collectGalleryImages(item))
  }

  return []
}

function isImageLikeValue(value: unknown): boolean {
  if (!value) return false
  if (typeof value === 'string') return value.startsWith('data:image/') || /\.(png|jpe?g|webp)$/i.test(value)
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.url === 'string' ||
    typeof record.path === 'string' ||
    typeof record.orig_name === 'string' ||
    typeof record.mime_type === 'string' ||
    typeof record.name === 'string'
  )
}

function makePixal3dGenerateArgs(image: unknown, sessionId: string): Record<string, unknown> {
  return {
    image,
    seed: getPixal3dSeed(),
    resolution: PIXAL3D_HF_GENERATION_SETTINGS.resolution,
    ss_guidance_strength: PIXAL3D_HF_GENERATION_SETTINGS.ssGuidanceStrength,
    ss_guidance_rescale: PIXAL3D_HF_GENERATION_SETTINGS.ssGuidanceRescale,
    ss_sampling_steps: PIXAL3D_HF_GENERATION_SETTINGS.ssSamplingSteps,
    ss_rescale_t: PIXAL3D_HF_GENERATION_SETTINGS.ssRescaleT,
    shape_slat_guidance_strength: PIXAL3D_HF_GENERATION_SETTINGS.shapeGuidance,
    shape_slat_guidance_rescale: PIXAL3D_HF_GENERATION_SETTINGS.shapeRescale,
    shape_slat_sampling_steps: PIXAL3D_HF_GENERATION_SETTINGS.shapeSamplingSteps,
    shape_slat_rescale_t: PIXAL3D_HF_GENERATION_SETTINGS.shapeRescaleT,
    tex_slat_guidance_strength: PIXAL3D_HF_GENERATION_SETTINGS.texGuidance,
    tex_slat_guidance_rescale: PIXAL3D_HF_GENERATION_SETTINGS.texRescale,
    tex_slat_sampling_steps: PIXAL3D_HF_GENERATION_SETTINGS.texSamplingSteps,
    tex_slat_rescale_t: PIXAL3D_HF_GENERATION_SETTINGS.texRescaleT,
    manual_fov: PIXAL3D_HF_GENERATION_SETTINGS.manualFov,
    fov_unit: PIXAL3D_HF_GENERATION_SETTINGS.fovUnit,
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
  if (typeof value === 'string') return /\.(npz|safetensors)(\?|$)/i.test(value) ? value : null
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
    if (typeof record[key] === 'string' && record[key]) return record[key] as string
  }
  for (const item of Object.values(record)) {
    const found = findPixal3dStatePath(item)
    if (found) return found
  }
  return null
}

function getPixal3dSeed() {
  if (!PIXAL3D_HF_GENERATION_SETTINGS.randomizeSeed) return PIXAL3D_HF_GENERATION_SETTINGS.seed
  return Math.floor(Math.random() * (MAX_PIXAL3D_SEED + 1))
}

function makePixal3dSessionId() {
  return globalThis.crypto?.randomUUID?.() ?? `doorclub-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

function cleanExternalErrorMessage(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/Hugging Face Pixal3D/gi, 'модуль 3D-сборки')
    .replace(/Pixal3D-Server/gi, 'модуль 3D-сборки')
    .replace(/Pixal3D/gi, 'модуль 3D-сборки')
    .replace(/TRELLIS\.?2?/gi, 'модуль 3D-сборки')
    .replace(/\bGLB\b/gi, '3D-модель')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatGradioError(error: unknown): string {
  const rawMessage = error instanceof Error
    ? error.message
    : error && typeof error === 'object'
      ? [
          typeof (error as Record<string, unknown>).title === 'string' ? (error as Record<string, unknown>).title : '',
          typeof (error as Record<string, unknown>).message === 'string' ? (error as Record<string, unknown>).message : '',
        ].filter(Boolean).join(': ')
      : String(error ?? '')

  if (/ZeroGPU illegal duration|requested GPU duration.*maximum allowed/i.test(rawMessage)) {
    return 'Публичный 3D-сервис сейчас не выдаёт достаточно GPU-времени для этой модели. Попробуйте позже.'
  }

  if (error instanceof Error) return cleanExternalErrorMessage(rawMessage)
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title : null
    const message = typeof record.message === 'string' ? record.message : null
    if (title && message) return cleanExternalErrorMessage(`${title}: ${message}`)
    if (message) return cleanExternalErrorMessage(message)
    if (title) return cleanExternalErrorMessage(title)
  }

  try {
    return cleanExternalErrorMessage(JSON.stringify(error) ?? '3D-сборка не удалась')
  } catch {
    return '3D-сборка не удалась'
  }
}

async function mirrorTrellisModel(temporaryModelUrl: string) {
  const accessToken = await getFreshAccessToken()
  if (!accessToken) throw new Error('Нужна авторизация для сохранения 3D-модели')

  const response = await fetch(`${API_URL}/avatar/mirror-model`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ modelUrl: temporaryModelUrl }),
  })

  if (response.ok) return readModelMirrorResponse(response)

  const mirrorError = await readApiError(response, `Model mirror error: ${response.status}`)
  console.warn('[Avatar Pixal3D] API mirror failed, trying browser GLB upload:', mirrorError)

  try {
    const modelResponse = await fetch(temporaryModelUrl)
    if (!modelResponse.ok) {
      throw new Error(`Browser GLB download failed: ${modelResponse.status}`)
    }

    const uploadResponse = await fetch(`${API_URL}/avatar/upload-model`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': modelResponse.headers.get('content-type') || 'model/gltf-binary',
      },
      body: await modelResponse.arrayBuffer(),
    })

    if (!uploadResponse.ok) {
      throw new Error(await readApiError(uploadResponse, `Model upload error: ${uploadResponse.status}`))
    }

    return readModelMirrorResponse(uploadResponse)
  } catch (error) {
    throw new Error(
      `Model mirror failed: ${mirrorError}. Browser upload fallback failed: ${formatGradioError(error)}`,
    )
  }
}

async function apiJson<T>(path: string, init: RequestInit): Promise<T> {
  const accessToken = await getFreshAccessToken()
  if (!accessToken) throw new Error('Нужна авторизация для генерации 3D-модели')

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
  }).catch((error) => {
    throw new Error(
      `Не удалось подключиться к API ${API_URL}. Запусти pnpm dev:api или общий pnpm dev. ${error?.message ?? ''}`.trim()
    )
  })

  if (!response.ok) {
    throw new Error(await readApiError(response, `API error: ${response.status}`))
  }

  return response.json() as Promise<T>
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({} as { error?: string }))
  return body.error || fallback
}

function readModelMirrorResponse(response: Response) {
  return response.json() as Promise<{
    modelUrl: string
    format: string
    triangleCount: number | null
    autorig?: AvatarConfig['autorig']
  }>
}

async function getFreshAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null

  const expiresAtMs = (session.expires_at ?? 0) * 1000
  if (expiresAtMs && expiresAtMs > Date.now() + 60_000) return session.access_token

  const { data, error } = await supabase.auth.refreshSession()
  if (error) throw new Error(`Не удалось обновить Supabase-сессию: ${error.message}`)

  return data.session?.access_token ?? session.access_token
}
