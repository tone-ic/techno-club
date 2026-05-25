// ─── Игровые константы ────────────────────────────────────────────────────────
// Все числа проекта живут здесь. Не дублировать в клиентском коде.

// Фейсконтроль и cooldown
export const COOLDOWN_MINUTES = 10
export const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1000
export const MAX_BOUNCER_DENIALS_IN_ROW = 3
export const VIBE_CHECK_COOLDOWN_MINUTES = 30

// Комнаты
export const MAX_PLAYERS_PER_OUTSIDE_ROOM = 60
export const MAX_PLAYERS_PER_CLUB_ROOM = 50
export const MAX_QUEUE_SIZE = 30
export const RECONNECT_WINDOW_SECONDS = 300   // 5 минут

// Аудио
export const PROXIMITY_VOICE_RADIUS = 8       // PlayCanvas units
export const PROXIMITY_VOICE_NEAR_SPEAKER_MULTIPLIER = 0.3
export const DJ_TRACK_VOLUME = 0.75
export const STREET_CLUB_AMBIENT_VOLUME = 0.20
export const STREET_CLUB_LOWPASS_HZ = 200
export const AMBIENT_VOLUME = 0.4

// Приватность
export const PHOTO_CLEANUP_MINUTES = 5
export const PHOTO_CLEANUP_MS = PHOTO_CLEANUP_MINUTES * 60 * 1000
export const PHOTO_SIGNED_URL_EXPIRES_SECONDS = 300  // 5 минут

// Производительность (iPhone)
export const TARGET_FPS = 30
export const LOW_FPS_THRESHOLD = 25           // автопереключение на low quality
export const MAX_DETAILED_AVATARS = 20        // больше этого — billboard LOD
export const LOD_DISTANCE_DETAILED = 10       // PlayCanvas units
export const LOD_DISTANCE_SIMPLIFIED = 25     // дальше — billboard

// Сеть / синхронизация
export const POSITION_SYNC_RATE_MS = 50       // 20Hz синхронизация позиций
export const PROXIMITY_CALC_RATE_MS = 200     // пересчёт громкости голоса

// Colyseus events (избегаем опечатки)
export const EVENTS = {
  // Client → Server
  JOIN_QUEUE: 'joinQueue',
  LEAVE_QUEUE: 'leaveQueue',
  MOVE: 'move',
  EMOTE: 'emote',
  CHANGE_APPEARANCE: 'changeAppearance',
  ENTER_CLUB: 'enterClub',
  REPORT_PLAYER: 'reportPlayer',
  APPROVE_ENTRY: 'approveEntry',
  DENY_ENTRY: 'denyEntry',
  REQUEST_MUTE: 'requestMute',
  REQUEST_KICK: 'requestKick',
  // Server → Client
  QUEUE_UPDATE: 'queueUpdate',
  ADMISSION_RESULT: 'admissionResult',
  MODERATION_ACTION: 'moderationAction',
  ESCALATION: 'escalation',
  DJ_TRACK_CHANGED: 'djTrackChanged',
} as const

// Эмодзи-реакции
export const EMOTE_IDS = ['wave', 'dance', 'thumbsup', 'nod', 'shrug', 'drink', 'point', 'laugh'] as const
export type EmoteId = typeof EMOTE_IDS[number]
