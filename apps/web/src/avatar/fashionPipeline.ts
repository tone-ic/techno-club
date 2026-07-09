import type {
  GarmentImageGenerationRequest,
  GarmentImageGenerationResult,
  OutfitAnalysisResult,
} from '@shared/types'
import { supabase } from '@/utils/supabase'
import { resolveRuntimeUrl } from '@/utils/runtimeUrls'

const API_URL = resolveRuntimeUrl(import.meta.env.VITE_API_URL || 'http://localhost:3001', {
  httpProtocol: 'http:',
  httpsProtocol: 'https:',
})

export async function analyzeOutfit(image: string): Promise<OutfitAnalysisResult> {
  const response = await apiJson<{ analysis: OutfitAnalysisResult }>('/avatar/analyze-outfit', {
    method: 'POST',
    body: JSON.stringify({ image }),
  })
  return response.analysis
}

export async function generateGarmentImage(
  request: GarmentImageGenerationRequest,
): Promise<GarmentImageGenerationResult> {
  return apiJson<GarmentImageGenerationResult>('/avatar/generate-garment-image', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

async function apiJson<T>(path: string, init: RequestInit): Promise<T> {
  const accessToken = await getFreshAccessToken()
  if (!accessToken) throw new Error('Нужна авторизация для анализа одежды')

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

  if (!response.ok) throw new Error(await readApiError(response, `API error: ${response.status}`))
  return response.json() as Promise<T>
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({} as { error?: string }))
  return body.error || fallback
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
