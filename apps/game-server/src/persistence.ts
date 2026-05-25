export type PersistedPlayerRole = 'guest' | 'bouncer' | 'guard' | 'dj' | 'bartender' | 'vip' | 'owner' | 'admin'

export interface PersistedPlayerState {
  playerKey: string
  userId: string | null
  role: PersistedPlayerRole
  clublesBalance: number
  vipAccess: boolean
  lockscreenMusicUntil: number
  cooldownUntil: number
  activeEntitlements: string[]
}

export interface PlayerPersistenceInput {
  playerKey: string
  userId: string
  role: PersistedPlayerRole
  clublesBalance: number
  vipAccess: boolean
  lockscreenMusicUntil: number
  cooldownUntil: number
  activeEntitlements: string[]
}

export interface AdmissionEventInput {
  playerKey: string
  userId: string
  result: 'approved' | 'denied'
  reason: string | null
  cooldownUntil: number
  actorPlayerKey: string | null
  actorUserId: string | null
}

const VALID_ROLES = new Set<PersistedPlayerRole>(['guest', 'bouncer', 'guard', 'dj', 'bartender', 'vip', 'owner', 'admin'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const restBaseUrl = supabaseUrl ? `${supabaseUrl}/rest/v1` : ''
let warned = false
let unavailable = false

export function isPersistenceEnabled() {
  return Boolean(restBaseUrl && serviceRoleKey && !unavailable)
}

export function persistenceStatusLabel() {
  return isPersistenceEnabled() ? 'supabase' : 'memory'
}

export function isUuid(value: string) {
  return UUID_RE.test(value)
}

export async function loadPlayerPersistence(playerKey: string): Promise<PersistedPlayerState | null> {
  if (!isPersistenceEnabled() || !playerKey) return null

  try {
    const rows = await request<any[]>(
      `/game_player_state?player_key=eq.${encodeURIComponent(playerKey)}&select=*`,
      { method: 'GET' },
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return row ? normalizePlayerState(row) : null
  } catch (error) {
    warnPersistenceError('load player state', error)
    return null
  }
}

export async function savePlayerPersistence(input: PlayerPersistenceInput) {
  if (!isPersistenceEnabled() || !input.playerKey) return

  try {
    await request(
      '/game_player_state?on_conflict=player_key',
      {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          player_key: input.playerKey,
          user_id: isUuid(input.userId) ? input.userId : null,
          role: input.role,
          clubles_balance: Math.max(0, Math.floor(input.clublesBalance)),
          vip_access: input.vipAccess,
          lockscreen_music_until: msToIso(input.lockscreenMusicUntil),
          cooldown_until: msToIso(input.cooldownUntil),
          active_entitlements: input.activeEntitlements,
          updated_at: new Date().toISOString(),
        }),
      },
    )
  } catch (error) {
    warnPersistenceError('save player state', error)
  }
}

export async function recordAdmissionEvent(input: AdmissionEventInput) {
  if (!isPersistenceEnabled() || !input.playerKey) return

  try {
    await request(
      '/game_admission_events',
      {
        method: 'POST',
        body: JSON.stringify({
          player_key: input.playerKey,
          user_id: isUuid(input.userId) ? input.userId : null,
          result: input.result,
          reason_code: input.reason || null,
          cooldown_until: msToIso(input.cooldownUntil),
          actor_player_key: input.actorPlayerKey,
          actor_user_id: input.actorUserId && isUuid(input.actorUserId) ? input.actorUserId : null,
        }),
      },
    )
  } catch (error) {
    warnPersistenceError('record admission event', error)
  }
}

async function request<T = unknown>(path: string, init: RequestInit): Promise<T> {
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    ...(init.headers ?? {}),
  }

  const response = await fetch(`${restBaseUrl}${path}`, { ...init, headers })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Supabase REST ${response.status}: ${body.slice(0, 220)}`)
  }

  if (response.status === 204) return null as T
  const text = await response.text()
  return text ? JSON.parse(text) as T : null as T
}

function normalizePlayerState(row: any): PersistedPlayerState {
  const role = VALID_ROLES.has(row.role) ? row.role as PersistedPlayerRole : 'guest'
  return {
    playerKey: String(row.player_key || ''),
    userId: typeof row.user_id === 'string' ? row.user_id : null,
    role,
    clublesBalance: Math.max(0, Math.floor(Number(row.clubles_balance) || 0)),
    vipAccess: Boolean(row.vip_access),
    lockscreenMusicUntil: isoToMs(row.lockscreen_music_until),
    cooldownUntil: isoToMs(row.cooldown_until),
    activeEntitlements: Array.isArray(row.active_entitlements)
      ? row.active_entitlements.filter((item: unknown): item is string => typeof item === 'string')
      : [],
  }
}

function msToIso(value: number) {
  return Number.isFinite(value) && value > Date.now() ? new Date(value).toISOString() : null
}

function isoToMs(value: unknown) {
  if (typeof value !== 'string' || !value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > Date.now() ? parsed : 0
}

function warnPersistenceError(action: string, error: unknown) {
  if (String(error).includes('PGRST205') || String(error).includes('Could not find the table')) {
    unavailable = true
  }
  if (warned) return
  warned = true
  console.warn(`[persistence] Could not ${action}; continuing in memory.`, error)
}
