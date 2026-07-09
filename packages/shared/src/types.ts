// ─── Роли ────────────────────────────────────────────────────────────────────

export type UserRole =
  | 'guest'
  | 'bouncer'    // фейсконтроль
  | 'guard'      // охрана / модератор
  | 'dj'
  | 'bartender'
  | 'light'      // световик
  | 'vip'
  | 'owner'
  | 'admin'

// ─── Статус игрока ────────────────────────────────────────────────────────────

export type PlayerStatus =
  | 'outside'    // на улице, не в очереди
  | 'queuing'    // стоит в очереди
  | 'denied'     // отказ, cooldown активен
  | 'inside'     // внутри клуба
  | 'vip'        // в VIP-зоне

// ─── Reason codes ─────────────────────────────────────────────────────────────

export type DenyReason =
  | 'dress_code'    // не тот дресс-код
  | 'overcrowded'   // клуб заполнен
  | 'behavior'      // жалобы / агрессия
  | 'closed_event'  // закрытое мероприятие
  | 'vibe_check'    // игровой отказ (лимит 1 раз в 30 мин)

// ─── Аватар ──────────────────────────────────────────────────────────────────

export interface AvatarAutorigInfo {
  status: 'disabled' | 'generated' | 'failed'
  modelUrl?: string
  format?: string
  error?: string
}

export interface AvatarConfig {
  bodyId: string          // 'body_01'..'body_05'
  headId: string          // 'head_01'..'head_05'
  skinTone: string        // hex color
  hairStyle: string       // 'short_01'..'short_10' | 'long_01'..
  hairColor: string       // hex color
  topStyle: string        // 'hoodie' | 'tshirt' | 'jacket' | 'crop' | 'coat'
  topColor: string        // hex color
  bottomStyle: string     // 'cargo' | 'jeans' | 'skirt' | 'shorts' | 'trousers'
  bottomColor: string     // hex color
  shoesStyle: string      // 'sneakers' | 'boots' | 'heels' | 'platforms'
  shoesColor: string      // hex color
  accessory: string | null // 'chain_01' | 'glasses_01' | 'cap_01' | 'mask_01' | null
  mood: 'stoic' | 'chill' | 'hyper' | 'tired' | 'confident'
  faceTextureUrl: string | null
  modelUrl: string | null   // optional generated GLB stored by backend
  rpmGlbUrl: string | null  // legacy: старые внешние GLB, новые аватары не используют
  bodyTextureUrl: string | null
  autorig?: AvatarAutorigInfo | null
}

// ─── Анализ одежды ───────────────────────────────────────────────────────────

export type GarmentPatternSize = 'S' | 'M' | 'L' | 'XL'

export type GarmentGenerationMode = 'extract' | 'pattern' | 'similar'

export interface OutfitDetectedItem {
  number: number
  title: string
  category: string
  summary: string
  detailedDescription: string
  colors: string[]
  materials: string[]
  fit: string
  visibleFeatures: string[]
  constructionNotes: string[]
  searchKeywords: string[]
  confidence: number
}

export interface OutfitAnalysisResult {
  model: string
  overview: string
  items: OutfitDetectedItem[]
}

export interface GarmentImageGenerationRequest {
  mode: GarmentGenerationMode
  sourceImage: string
  item: OutfitDetectedItem
  patternSize?: GarmentPatternSize
  similarity?: number
}

export interface GarmentImageGenerationResult {
  mode: GarmentGenerationMode
  image: string
  aspectRatio: '1:1' | '16:9'
  prompt: string
}

export const DEFAULT_AVATAR_CONFIG: AvatarConfig = {
  bodyTextureUrl: null,
  bodyId: 'body_01',
  headId: 'head_01',
  skinTone: '#c8a882',
  hairStyle: 'short_01',
  hairColor: '#1c1410',
  topStyle: 'tshirt',
  topColor: '#111111',
  bottomStyle: 'jeans',
  bottomColor: '#1a1a2e',
  shoesStyle: 'sneakers',
  shoesColor: '#0f0f0f',
  accessory: null,
  mood: 'stoic',
  faceTextureUrl: null,
  modelUrl: null,
  rpmGlbUrl: null,
  autorig: null,
}

// ─── Игровое состояние игрока (Colyseus) ──────────────────────────────────────

export interface PlayerState {
  userId: string
  displayName: string
  avatarConfig: AvatarConfig
  x: number
  z: number
  rotY: number             // поворот по Y в радианах
  status: PlayerStatus
  role: UserRole
  cooldownUntil: number | null  // unix timestamp (ms)
  isMuted: boolean
  isTalking: boolean
  isOnline: boolean
}

// ─── Состояние комнаты (Colyseus) ─────────────────────────────────────────────

export interface RoomStateData {
  roomId: string
  roomType: 'outside' | 'club'
  players: Record<string, PlayerState>
  queue: string[]           // userId в порядке очереди
  djUserId: string | null
  currentTrack: string | null
  maxPlayers: number
}

// ─── Colyseus Messages — CLIENT → SERVER ──────────────────────────────────────

export interface MoveMessage {
  x: number
  z: number
  rotY: number
}

export interface EmoteMessage {
  emoteId: 'wave' | 'dance' | 'thumbsup' | 'nod' | 'shrug' | 'drink' | 'point' | 'laugh'
}

export interface ChangeAppearanceMessage {
  avatarConfig: Partial<AvatarConfig>
}

export interface ReportPlayerMessage {
  targetId: string
  reason: 'harassment' | 'spam' | 'inappropriate' | 'other'
  details?: string
}

export interface ApproveEntryMessage {
  guestId: string
}

export interface DenyEntryMessage {
  guestId: string
  reason: DenyReason
}

export interface MutePlayerMessage {
  targetId: string
  durationMinutes: number
}

export interface KickPlayerMessage {
  targetId: string
  reason: string
}

// ─── Colyseus Messages — SERVER → CLIENT ──────────────────────────────────────

export interface AdmissionResultMessage {
  result: 'approved' | 'denied'
  reason?: DenyReason
  cooldownUntil?: number   // unix timestamp
}

export interface QueueUpdateMessage {
  position: number         // 1-based
  total: number
}

export interface ModerationActionMessage {
  action: 'mute' | 'kick' | 'ban'
  targetId: string
  reason: string
}

export interface EscalationMessage {
  bouncerId: string
  guestId: string
  reason: DenyReason
  timestamp: number
}

// ─── Supabase DB Types ────────────────────────────────────────────────────────

export interface Profile {
  user_id: string
  display_name: string
  avatar_id: string | null
  role: UserRole
  created_at: string
}

export interface AvatarRecord {
  id: string
  user_id: string
  glb_url: string | null
  face_tex_url: string | null
  config_json: AvatarConfig
  version: number
  created_at: string
  updated_at: string
}

export interface AdmissionAttempt {
  id: string
  user_id: string
  room_id: string
  result: 'approved' | 'denied'
  reason_code: DenyReason | null
  cooldown_until: string | null
  bouncer_id: string | null
  created_at: string
}

export interface Report {
  id: string
  reporter_id: string
  target_id: string
  room_id: string
  reason: string
  details: string | null
  created_at: string
}
