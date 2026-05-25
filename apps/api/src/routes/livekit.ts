import { Hono } from 'hono'
import { AccessToken } from 'livekit-server-sdk'
import { createClient } from '@supabase/supabase-js'

export const livekitRouter = new Hono()

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const LK_API_KEY = process.env.LIVEKIT_API_KEY!
const LK_API_SECRET = process.env.LIVEKIT_API_SECRET!

function cleanParticipantId(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
}

function isPlaceholderSecret(value?: string) {
  if (!value) return true
  return value.includes('xxxx') || /^x+$/i.test(value)
}

/**
 * POST /livekit/token
 * Body: { roomId: string }
 * Header: Authorization: Bearer <supabase-jwt>
 *
 * Returns: { token: string, url: string }
 */
livekitRouter.post('/token', async (c) => {
  // 1. Проверить Supabase JWT
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const jwt = authHeader.slice(7)
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt)

  if (authError || !user) {
    return c.json({ error: 'Invalid token' }, 401)
  }

  if (isPlaceholderSecret(LK_API_KEY) || isPlaceholderSecret(LK_API_SECRET)) {
    return c.json({
      error: 'LIVEKIT_API_KEY / LIVEKIT_API_SECRET не настроены. Для локального livekit-server --dev поставь devkey / secret, для LiveKit Cloud - реальные ключи проекта.',
    }, 500)
  }

  // 2. Получить роль из Supabase
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, display_name')
    .eq('user_id', user.id)
    .single()

  const displayName = profile?.display_name ?? 'Аноним'

  // 3. Получить roomId из body
  const { roomId, participantId } = await c.req.json<{ roomId: string; participantId?: string }>()
  if (!roomId) return c.json({ error: 'roomId required' }, 400)
  const safeParticipantId = cleanParticipantId(participantId) || `client-${Date.now()}`

  // 4. Создать LiveKit access token
  const at = new AccessToken(LK_API_KEY, LK_API_SECRET, {
    identity: `${user.id}-${safeParticipantId}`,
    name: displayName,
    ttl: '4h',
  })

  at.addGrant({
    roomJoin: true,
    room: roomId,
    canPublish: true,         // все могут публиковать микрофон
    canSubscribe: true,
    canPublishData: true,
  })

  const token = await at.toJwt()

  return c.json({
    token,
    url: process.env.LIVEKIT_URL ?? process.env.VITE_LIVEKIT_URL ?? 'ws://localhost:7880',
  })
})
