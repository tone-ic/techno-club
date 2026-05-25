import { supabase } from '@/utils/supabase'
import { resolveRuntimeUrl } from '@/utils/runtimeUrls'

const API_URL = resolveRuntimeUrl(import.meta.env.VITE_API_URL || 'http://localhost:3001', {
  httpProtocol: 'http:',
  httpsProtocol: 'https:',
})
export const LIVEKIT_DJ_ROOM = 'left-bank-main'

type LiveKitClientRole = 'dj' | 'listener' | 'voice'

function getTabParticipantId(role: LiveKitClientRole, participantId?: string) {
  if (participantId) return participantId
  if (role === 'dj') return `dj-${crypto.randomUUID()}`

  const key = `livekit:${role}:participant-id`
  let id = sessionStorage.getItem(key)
  if (!id) {
    id = `${role}-${crypto.randomUUID()}`
    sessionStorage.setItem(key, id)
  }
  return id
}

function normalizeLiveKitUrl(rawUrl: string) {
  return resolveRuntimeUrl(rawUrl, { httpProtocol: 'ws:', httpsProtocol: 'wss:' })
}

export async function getLiveKitToken(
  roomId = LIVEKIT_DJ_ROOM,
  role: LiveKitClientRole = 'listener',
  participantId?: string,
) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Нужна авторизация для LiveKit')

  const res = await fetch(`${API_URL}/livekit/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ roomId, participantId: getTabParticipantId(role, participantId) }),
  }).catch((error) => {
    throw new Error(
      `Не удалось подключиться к API ${API_URL}. Запусти pnpm dev:api или общий pnpm dev. ${error?.message ?? ''}`.trim()
    )
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `LiveKit token error: ${res.status}`)
  }

  const data = await res.json() as { token: string; url: string }
  const url = normalizeLiveKitUrl(data.url || import.meta.env.VITE_LIVEKIT_URL || 'ws://localhost:7880')
  if (!url) throw new Error('LIVEKIT_URL не настроен')

  return { token: data.token, url }
}
