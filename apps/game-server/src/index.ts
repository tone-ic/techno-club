import './env'
import * as fs from 'fs'
import * as path from 'path'
import { WebSocketServer, WebSocket } from 'ws'
import {
  loadPlayerPersistence,
  persistenceStatusLabel,
  recordAdmissionEvent,
  savePlayerPersistence,
  type PersistedPlayerState,
} from './persistence'
import { analyzeAudioBpm } from './musicAnalysis'

interface Player {
  id: string
  userId: string
  economyKey: string
  accountKey: string
  ws: WebSocket
  room: 'outside' | 'club'
  displayName: string
  topColor: string
  bottomColor: string
  hairColor: string
  skinTone: string
  faceTextureUrl: string
  bodyTextureUrl: string
  modelUrl: string
  djName: string
  x: number
  z: number
  floorLevel: ClubFloorLevel
  rotY: number
  moving: boolean
  musicDanceIntensity: number
  role: PlayerRole
  clublesBalance: number
  lockscreenMusicUntil: number
  bartenderSales: number
  bartenderTips: number
  inQueue: boolean
  queuePos: number
  cooldownUntil: number
  insideClub: boolean
}

type PlayerRole = 'guest' | 'bouncer' | 'guard' | 'dj' | 'bartender' | 'vip' | 'owner' | 'admin'
type ClubRole = 'dj' | 'bartender' | 'guard'
type StaffInviteRole = 'dj' | 'facecontrol' | 'security' | 'barmen' | 'vip' | 'owner'
type ClubFloorLevel = 'ground' | 'stairs' | 'vip'

interface PlayerSessionHandoff {
  room: Player['room']
  role: PlayerRole
  x: number
  z: number
  floorLevel: ClubFloorLevel
  rotY: number
  musicDanceIntensity: number
  inQueue: boolean
  queueIndex: number
  cooldownUntil: number
  insideClub: boolean
  djName: string
  djStreamActive: boolean
}

type ManagementAction =
  | 'warnPlayer'
  | 'escortOutside'
  | 'setPlayerRole'
  | 'grantVip'
  | 'revokeVip'
  | 'setClubEnergy'
  | 'setDrinkPrice'

interface DrinkMenuItem {
  id: string
  name: string
  price: number
  effect: 'focus' | 'bass' | 'spark' | 'chill' | 'service'
  kind?: 'drink' | 'service'
  durationMs?: number
}

interface BarOrder {
  id: string
  customerId: string
  customerName: string
  drinkId: string
  drinkName: string
  kind?: DrinkMenuItem['kind']
  price: number
  tip: number
  status: 'pending' | 'served'
  createdAt: number
}

interface PlayerDrink {
  id: string
  drinkId: string
  drinkName: string
  effect: DrinkMenuItem['effect']
  remaining: number
  servedAt: number
}

interface DjScheduleItem {
  userId: string
  playerId: string | null
  displayName: string
  djName: string
  slotStartAt: number
  slotEndAt: number
  online: boolean
  lastSeenAt: number
  claimedAt: number
}

interface MusicTrackInfo {
  fileName: string
  name: string
  fullPath: string
  size: number
  mtimeMs: number
  analysisKey: string
  bpm?: number
  bpmConfidence?: number
  bpmSource?: 'audio' | 'pending' | 'fallback'
}

interface MusicTrackState {
  count: number
  signature: string
  tracks: MusicTrackInfo[]
}

interface MusicBpmAnalysisCacheEntry {
  status: 'pending' | 'ready' | 'failed'
  bpm?: number
  confidence?: number
  error?: string
}

type MusicSource = 'track' | 'dj'

const players = new Map<string, Player>()
const queue: string[] = []
let nextId = 1
const SERVER_PROTOCOL_VERSION = 'doorclub-ws/2026-05-26.server-music-source-v1'
const PORT = Number(process.env.GAME_SERVER_PORT || process.env.PORT || 2567)
const COOLDOWN_MS = 10 * 60 * 1000
const PLAYER_MIN_DISTANCE = 0.9
const PLAYER_COLLISION_PADDING = 0.04
const PLAYER_COLLISION_ITERATIONS = 5
const OUTSIDE_WALK_BOUNDS = { minX: -8, maxX: 8, minZ: -10, maxZ: 10 } as const
const CLUB_WALK_BOUNDS = { minX: -15.2, maxX: 15.2, minZ: -14.7, maxZ: 9.8 } as const
const VALID_ROLES = new Set<PlayerRole>(['guest', 'bouncer', 'guard', 'dj', 'bartender', 'vip', 'owner', 'admin'])
const CLUB_ROLE_SLOTS: ClubRole[] = ['dj', 'bartender', 'guard']
const roleSlots: Record<ClubRole, string | null> = { dj: null, bartender: null, guard: null }
let clubEnergy = 0.58
const vipGuests = new Set<string>()
const playerRoles = new Map<string, PlayerRole>()
const staffEntryAttempts = new Map<string, number>()
const clublesBalances = new Map<string, number>()
const lockscreenMusicAccess = new Map<string, number>()
const admissionCooldowns = new Map<string, number>()
const persistedVipAccess = new Map<string, boolean>()
const barOrders = new Map<string, BarOrder>()
const playerDrinks = new Map<string, PlayerDrink[]>()
const djSchedule = new Map<string, DjScheduleItem>()
let nextBarOrderId = 1
let nextPlayerDrinkId = 1
const STAFF_ENTRY_SPAWN = { x: 0, z: 6 }
const DJ_BOOTH_SPAWN = { x: 0, z: -8.15 }
const BAR_WORK_SPAWN = { x: 12.25, z: 0.4 }
const DRINK_EFFECT_DURATION_MS = 60_000
const DRINK_GIFT_DISTANCE = 2.4
const MIN_DRINK_SIP_AMOUNT = 0.01
const STARTING_CLUBLES = 1000
const DJ_SET_DURATION_MS = 30 * 60 * 1000
const DRINK_MENU: DrinkMenuItem[] = [
  { id: 'neon_spritz', name: 'Неон-спритц', price: 120, effect: 'spark' },
  { id: 'bass_tonic', name: 'Басс-тоник', price: 180, effect: 'bass' },
  { id: 'velvet_shot', name: 'Вельвет-шот', price: 240, effect: 'focus' },
  { id: 'ice_zero', name: 'Айс-зеро', price: 90, effect: 'chill' },
]
const STAFF_ENTRY_INVITES: Record<StaffInviteRole, { password: string; role: PlayerRole }> = {
  dj: { password: 'djbudet', role: 'dj' },
  facecontrol: { password: 'face', role: 'bouncer' },
  security: { password: 'police', role: 'guard' },
  barmen: { password: 'toneic', role: 'bartender' },
  vip: { password: 'svoi', role: 'vip' },
  owner: { password: 'nigga', role: 'owner' },
}

// ── Музыкальная синхронизация ─────────────────────────────
const MUSIC_EXTENSIONS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac', '.webm'])
const MUSIC_SCAN_INTERVAL_MS = 5_000
const MUSIC_STATE_BROADCAST_MS = 250
const MUSIC_FALLBACK_BPM = 124
const MUSIC_BPM_ANALYSIS_CONCURRENCY = 2
const DISCONNECTED_SESSION_GRACE_MS = 5 * 60_000
const MUSIC_DIR_CANDIDATES = [
  path.resolve(process.cwd(), 'apps/web/public/music'),
  path.resolve(process.cwd(), '../web/public/music'),
  path.resolve(__dirname, '../../web/public/music'),
  path.resolve(__dirname, '../../../apps/web/public/music'),
]
const musicBpmAnalysisCache = new Map<string, MusicBpmAnalysisCacheEntry>()
const musicBpmAnalysisQueue: MusicTrackInfo[] = []
let activeMusicBpmAnalyses = 0
const initialMusicTrackState = scanMusicTrackState()
let musicTrackCount = Math.max(1, initialMusicTrackState.count)
let musicTracksSignature = initialMusicTrackState.signature
let musicTrackInfos = initialMusicTrackState.tracks
let nextMusicScanAt = 0
let musicTrackIdx = 0
let musicStartedAt = Date.now()
let musicSource: MusicSource = 'track'
let djStreamStartedAt = 0
let djStreamPlayerId: string | null = null
let djStreamName = ''
const musicDurationsSec = new Map<number, number>()
const disconnectedSessionTimers = new Map<string, NodeJS.Timeout>()

setInterval(() => {
  refreshMusicTrackState()
  maybeAdvanceMusicTrack()
  broadcastMusicSync()
  setClubEnergy(clubEnergy - 0.006)
  broadcastManagementState()
}, 1_000)

setInterval(() => {
  broadcastMusicState()
}, MUSIC_STATE_BROADCAST_MS)

const wss = new WebSocketServer({ port: PORT })

function broadcast(data: object, except?: string, room?: 'outside' | 'club') {
  const msg = JSON.stringify(data)
  players.forEach(p => {
    if (room && p.room !== room) return
    if (p.id !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg)
  })
}

function createPlayerSessionHandoff(player: Player): PlayerSessionHandoff {
  return {
    room: player.room,
    role: player.role,
    x: player.x,
    z: player.z,
    floorLevel: player.floorLevel,
    rotY: player.rotY,
    musicDanceIntensity: player.musicDanceIntensity,
    inQueue: player.inQueue,
    queueIndex: player.inQueue ? queue.indexOf(player.id) : -1,
    cooldownUntil: player.cooldownUntil,
    insideClub: player.insideClub,
    djName: player.djName,
    djStreamActive: musicSource === 'dj' && djStreamPlayerId === player.id,
  }
}

function cancelDisconnectedSessionCleanup(playerId: string) {
  const timer = disconnectedSessionTimers.get(playerId)
  if (!timer) return
  clearTimeout(timer)
  disconnectedSessionTimers.delete(playerId)
}

function closeExistingSessions(accountKey: string, nextPlayerId: string) {
  const staleSessions = Array.from(players.values())
    .filter(player => player.id !== nextPlayerId && player.accountKey === accountKey)

  let handoff: PlayerSessionHandoff | null = null
  staleSessions.forEach((player) => {
    if (!handoff) handoff = createPlayerSessionHandoff(player)
    cancelDisconnectedSessionCleanup(player.id)
    removePlayerSession(player, 'replaced')
  })

  return handoff
}

function removePlayerSession(player: Player, reason: 'closed' | 'replaced' = 'closed') {
  const playerId = player.id
  cancelDisconnectedSessionCleanup(playerId)

  if (player.inQueue) {
    const idx = queue.indexOf(playerId)
    if (idx !== -1) queue.splice(idx, 1)
    broadcast({ type:'queueUpdate', queue:queueSnapshot() })
  }
  if (player.role === 'dj') markDjOffline(player)
  clearRoleSlot(playerId)
  staffEntryAttempts.delete(playerId)
  vipGuests.delete(playerId)

  if (player.role === 'bartender') {
    for (const order of Array.from(barOrders.values())) {
      barOrders.delete(order.id)
      sendTo(order.customerId, {
        type: 'gameplayEvent',
        event: {
          kind: 'barClosed',
          clubEnergy,
          roleSlots: roleSlotsSnapshot(),
          text: 'Бармен закончил смену, заказ отменён',
        },
      })
    }
  } else {
    let removedOrder = false
    for (const order of Array.from(barOrders.values())) {
      if (order.customerId !== playerId) continue
      barOrders.delete(order.id)
      removedOrder = true
    }
    if (removedOrder) {
      const bartender = findBartender()
      if (bartender) sendGameplayState(bartender)
    }
  }

  players.delete(playerId)
  console.log(`[-] ${playerId} left (${reason}). Total: ${players.size}`)
  broadcast({ type:'playerLeft', id:playerId }, playerId, player.room)
  if (player.room === 'club') {
    broadcastGameplayEvent({
      kind: 'roleSlotsChanged',
      text: 'Смена ролей обновлена',
    })
  }
  if (player.role === 'dj') broadcastDjSchedule()

  if (reason === 'replaced' && player.ws.readyState === WebSocket.OPEN) {
    try {
      player.ws.close(4001, 'replaced by newer session')
    } catch {
      player.ws.close()
    }
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function normalizeAccountEmail(value: unknown) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function normalizeClientSessionId(value: unknown) {
  const id = typeof value === 'string' ? value.trim() : ''
  return /^[a-zA-Z0-9:_-]{8,128}$/.test(id) ? id : ''
}

function accountKeyFor(email: string, userId: string, clientSessionId: string, playerId: string) {
  if (email) return `email:${email}`
  if (userId) return `user:${userId}`
  if (clientSessionId) return `session:${clientSessionId}`
  return `session:${playerId}`
}

function walkBoundsForRoom(room: Player['room']) {
  return room === 'club' ? CLUB_WALK_BOUNDS : OUTSIDE_WALK_BOUNDS
}

function clampWalkPosition(room: Player['room'], x: number, z: number) {
  const bounds = walkBoundsForRoom(room)
  return {
    x: clamp(x, bounds.minX, bounds.maxX),
    z: clamp(z, bounds.minZ, bounds.maxZ),
  }
}

function musicDir() {
  return MUSIC_DIR_CANDIDATES.find(candidate => fs.existsSync(candidate)) ?? MUSIC_DIR_CANDIDATES[0]
}

function musicTrackAnalysisKey(fileName: string, size: number, mtimeMs: number) {
  return `${fileName}:${size}:${Math.round(mtimeMs)}`
}

function scanMusicTrackState(): MusicTrackState {
  const dir = musicDir()
  if (!fs.existsSync(dir)) return { count: 0, signature: '', tracks: [] }
  const tracks = fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && MUSIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => {
      const fullPath = path.join(dir, entry.name)
      const stat = fs.statSync(fullPath)
      const analysisKey = musicTrackAnalysisKey(entry.name, stat.size, stat.mtimeMs)
      const cached = musicBpmAnalysisCache.get(analysisKey)
      const bpm = cached?.status === 'ready' ? cached.bpm : undefined
      const bpmSource = cached?.status === 'ready' ? 'audio' : cached?.status === 'failed' ? 'fallback' : 'pending'
      const track: MusicTrackInfo = {
        fileName: entry.name,
        name: path.basename(entry.name, path.extname(entry.name)),
        fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        analysisKey,
        bpm,
        bpmConfidence: cached?.confidence,
        bpmSource,
      }
      scheduleTrackBpmAnalysis(track)
      return {
        ...track,
      }
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName, 'ru'))
  const activeKeys = new Set(tracks.map(track => track.analysisKey))
  for (const key of Array.from(musicBpmAnalysisCache.keys())) {
    if (!activeKeys.has(key)) musicBpmAnalysisCache.delete(key)
  }
  return {
    count: tracks.length,
    signature: tracks.map(track => track.analysisKey).join('\n'),
    tracks,
  }
}

function refreshMusicTrackState(force = false) {
  const now = Date.now()
  if (!force && now < nextMusicScanAt) return
  nextMusicScanAt = now + MUSIC_SCAN_INTERVAL_MS

  const currentTrackFileName = musicTrackInfos[musicTrackIdx]?.fileName
  const next = scanMusicTrackState()
  if (next.signature === musicTracksSignature) return

  musicTracksSignature = next.signature
  musicTrackCount = Math.max(1, next.count)
  musicTrackInfos = next.tracks
  musicDurationsSec.clear()
  const nextCurrentTrackIdx = currentTrackFileName
    ? next.tracks.findIndex(track => track.fileName === currentTrackFileName)
    : -1
  if (nextCurrentTrackIdx >= 0) {
    musicTrackIdx = nextCurrentTrackIdx
  } else {
    musicTrackIdx = Math.min(musicTrackIdx, musicTrackCount - 1)
    musicStartedAt = now
  }
  broadcastMusicSync()
}

function scheduleTrackBpmAnalysis(track: MusicTrackInfo) {
  const cached = musicBpmAnalysisCache.get(track.analysisKey)
  if (cached?.status === 'pending' || cached?.status === 'ready') return

  musicBpmAnalysisCache.set(track.analysisKey, { status: 'pending' })
  musicBpmAnalysisQueue.push(track)
  pumpMusicBpmAnalysisQueue()
}

function pumpMusicBpmAnalysisQueue() {
  while (activeMusicBpmAnalyses < MUSIC_BPM_ANALYSIS_CONCURRENCY && musicBpmAnalysisQueue.length > 0) {
    const track = musicBpmAnalysisQueue.shift()
    if (!track) return
    activeMusicBpmAnalyses += 1
    void runTrackBpmAnalysis(track).finally(() => {
      activeMusicBpmAnalyses = Math.max(0, activeMusicBpmAnalyses - 1)
      pumpMusicBpmAnalysisQueue()
    })
  }
}

async function runTrackBpmAnalysis(track: MusicTrackInfo) {
  await analyzeAudioBpm(track.fullPath)
    .then((analysis) => {
      const bpm = normalizeBpm(analysis.bpm)
      if (bpm) {
        musicBpmAnalysisCache.set(track.analysisKey, {
          status: 'ready',
          bpm,
          confidence: clamp(analysis.confidence, 0, 1),
          error: analysis.error,
        })
        console.log(`[music] BPM ${bpm} (${Math.round(analysis.confidence * 100)}%) from audio: ${track.name}`)
      } else {
        musicBpmAnalysisCache.set(track.analysisKey, {
          status: 'failed',
          confidence: 0,
          error: analysis.error || 'no reliable tempo detected',
        })
        console.warn(`[music] BPM analysis failed for ${track.name}: ${analysis.error || 'no reliable tempo detected'}`)
      }
      applyTrackBpmAnalysis(track.analysisKey)
    })
    .catch((error) => {
      musicBpmAnalysisCache.set(track.analysisKey, {
        status: 'failed',
        confidence: 0,
        error: error instanceof Error ? error.message : String(error),
      })
      console.warn(`[music] BPM analysis failed for ${track.name}:`, error)
      applyTrackBpmAnalysis(track.analysisKey)
    })
}

function applyTrackBpmAnalysis(analysisKey: string) {
  const cached = musicBpmAnalysisCache.get(analysisKey)
  let changed = false
  let changedCurrentTrack = false

  musicTrackInfos = musicTrackInfos.map((track, index) => {
    if (track.analysisKey !== analysisKey) return track
    const nextBpm = cached?.status === 'ready' ? cached.bpm : undefined
    const nextConfidence = cached?.status === 'ready' ? cached.confidence : 0
    const nextSource = cached?.status === 'ready' ? 'audio' : cached?.status === 'pending' ? 'pending' : 'fallback'
    if (
      track.bpm === nextBpm &&
      track.bpmConfidence === nextConfidence &&
      track.bpmSource === nextSource
    ) {
      return track
    }
    changed = true
    if (index === musicTrackIdx) changedCurrentTrack = true
    return {
      ...track,
      bpm: nextBpm,
      bpmConfidence: nextConfidence,
      bpmSource: nextSource,
    }
  })

  if (!changed) return
  if (changedCurrentTrack) broadcastMusicSync()
  else broadcastMusicState()
}

function smooth01(value: number) {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

function beatDistance(value: number, target: number, cycle = 1) {
  const raw = Math.abs(((value - target) % cycle + cycle) % cycle)
  return Math.min(raw, cycle - raw)
}

function beatPulse(value: number, target: number, width: number, cycle = 1) {
  return Math.pow(Math.max(0, 1 - beatDistance(value, target, cycle) / width), 2.35)
}

function seededNoise(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return value - Math.floor(value)
}

function normalizeBpm(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  let bpm = value
  while (bpm < 60) bpm *= 2
  while (bpm > 180) bpm /= 2
  if (bpm < 60 || bpm > 180) return null
  return Math.round(bpm * 10) / 10
}

function musicBpmDetailsForTrack(trackIdx = musicTrackIdx) {
  const idx = ((trackIdx % musicTrackCount) + musicTrackCount) % musicTrackCount
  const track = musicTrackInfos[idx]
  const bpm = track?.bpm ?? MUSIC_FALLBACK_BPM
  return {
    bpm,
    bpmConfidence: track?.bpm ? track.bpmConfidence ?? 0 : 0,
    bpmSource: track?.bpm ? 'audio' : track?.bpmSource === 'pending' ? 'pending' : 'fallback',
  }
}

function beatStateForTimeline(startedAt: number, bpm: number, now: number) {
  const beatIntervalMs = 60_000 / bpm
  const elapsedBeats = Math.max(0, (now - startedAt) / beatIntervalMs)
  const beatIndex = Math.floor(elapsedBeats)
  const beatPhase = elapsedBeats - beatIndex
  const beatStartedAt = startedAt + beatIndex * beatIntervalMs
  const phraseBeat = ((beatIndex % 32) + 32) % 32
  const measureBeat = ((beatIndex % 4) + 4) % 4

  return {
    beatIntervalMs,
    elapsedBeats,
    beatIndex,
    beatPhase,
    beatStartedAt,
    phraseBeat,
    measureBeat,
  }
}

function currentMusicState(now = Date.now()) {
  const trackIdx = ((musicTrackIdx % musicTrackCount) + musicTrackCount) % musicTrackCount

  if (musicSource === 'dj' && djStreamStartedAt > 0) {
    const bpm = MUSIC_FALLBACK_BPM
    const {
      beatIntervalMs,
      elapsedBeats,
      beatIndex,
      beatPhase,
      beatStartedAt,
      phraseBeat,
      measureBeat,
    } = beatStateForTimeline(djStreamStartedAt, bpm, now)
    const phraseLift = smooth01(phraseBeat / 31)
    const fourBarLift = smooth01((((beatIndex % 16) + 16) % 16) / 15)
    const kickPulse = Math.max(
      beatPulse(beatPhase, 0, 0.075),
      measureBeat === 2 ? beatPulse(beatPhase, 0, 0.07) * 0.54 : 0,
    )
    const rhythmPulse = Math.max(
      kickPulse * 0.72,
      beatPulse(beatPhase, 0.5, 0.065) * 0.58,
      beatPulse(beatPhase, 0.25, 0.045) * 0.22,
      beatPulse(beatPhase, 0.75, 0.045) * 0.2,
    )
    const kickIntensity = clamp(kickPulse * (0.9 + fourBarLift * 0.16), 0, 1)
    const rhythmIntensity = clamp(rhythmPulse + phraseLift * 0.1, 0, 1)
    const onsetStrength = clamp(Math.max(kickIntensity, rhythmIntensity * 0.72), 0, 1)
    const intensity = clamp(
      0.42 + clubEnergy * 0.24 + rhythmIntensity * 0.24 + kickIntensity * 0.18 + phraseLift * 0.06,
      0.1,
      1,
    )

    return {
      source: 'dj',
      trackIdx,
      trackCount: musicTrackCount,
      trackName: djStreamName || 'DJ LIVE',
      djPlayerId: djStreamPlayerId,
      djName: djStreamName,
      startedAt: djStreamStartedAt,
      serverNow: now,
      bpm,
      bpmSource: 'fallback',
      bpmConfidence: 0,
      beatStartedAt,
      beatIntervalMs,
      beatCount: Math.round(elapsedBeats * 1000) / 1000,
      phraseBeat,
      intensity,
      rhythmIntensity,
      kickIntensity,
      onsetStrength,
      clubEnergy,
    }
  }

  const { bpm, bpmConfidence, bpmSource } = musicBpmDetailsForTrack(trackIdx)
  const {
    beatIntervalMs,
    elapsedBeats,
    beatIndex,
    beatPhase,
    beatStartedAt,
    phraseBeat,
    measureBeat,
  } = beatStateForTimeline(musicStartedAt, bpm, now)
  const phraseLift = smooth01(phraseBeat / 31)
  const fourBarLift = smooth01((((beatIndex % 16) + 16) % 16) / 15)
  const variation = 0.86 + seededNoise(trackIdx * 1009 + Math.floor(beatIndex / 4)) * 0.28
  const kickPulse = Math.max(
    beatPulse(beatPhase, 0, 0.075),
    measureBeat === 2 ? beatPulse(beatPhase, 0, 0.07) * 0.54 : 0,
  )
  const rhythmPulse = Math.max(
    kickPulse * 0.72,
    beatPulse(beatPhase, 0.5, 0.065) * 0.58,
    beatPulse(beatPhase, 0.25, 0.045) * 0.22,
    beatPulse(beatPhase, 0.75, 0.045) * 0.2,
  )
  const downbeatLift = phraseBeat === 0 ? 0.48 : phraseBeat < 4 ? 0.18 : 0
  const breakdownDip = phraseBeat >= 16 && phraseBeat < 24 ? 0.12 : 0
  const kickIntensity = clamp((kickPulse * (0.88 + fourBarLift * 0.18) + downbeatLift * 0.28) * variation, 0, 1)
  const rhythmIntensity = clamp((rhythmPulse + phraseLift * 0.12 + downbeatLift * 0.16 - breakdownDip) * variation, 0, 1)
  const onsetStrength = clamp(Math.max(kickIntensity, rhythmIntensity * 0.72, downbeatLift), 0, 1)
  const intensity = clamp(
    0.34 + clubEnergy * 0.22 + rhythmIntensity * 0.28 + kickIntensity * 0.2 + phraseLift * 0.08 - breakdownDip * 0.5,
    0.08,
    1,
  )

  return {
    source: 'track',
    trackIdx,
    trackCount: musicTrackCount,
    trackName: musicTrackInfos[trackIdx]?.name ?? `Track ${trackIdx + 1}`,
    startedAt: musicStartedAt,
    serverNow: now,
    bpm,
    bpmSource,
    bpmConfidence,
    beatStartedAt,
    beatIntervalMs,
    beatCount: Math.round(elapsedBeats * 1000) / 1000,
    phraseBeat,
    intensity,
    rhythmIntensity,
    kickIntensity,
    onsetStrength,
    clubEnergy,
  }
}

function roleSlotsSnapshot() {
  return { ...roleSlots }
}

function clearRoleSlot(playerId: string) {
  for (const role of CLUB_ROLE_SLOTS) {
    if (roleSlots[role] === playerId) roleSlots[role] = null
  }
}

function nextDjSlotStart() {
  const now = Date.now()
  let nextStart = now
  for (const item of djSchedule.values()) {
    if (item.slotEndAt > nextStart) nextStart = item.slotEndAt
  }
  return nextStart
}

function djScheduleSnapshot() {
  const now = Date.now()
  return Array.from(djSchedule.values())
    .sort((a, b) => a.slotStartAt - b.slotStartAt || a.displayName.localeCompare(b.displayName))
    .map((item) => ({
      ...item,
      status: item.online
        ? (now >= item.slotStartAt && now < item.slotEndAt ? 'performing' : 'online')
        : 'offline',
    }))
}

function sendDjSchedule(player: Player) {
  sendTo(player.id, {
    type: 'djSchedule',
    serverNow: Date.now(),
    schedule: djScheduleSnapshot(),
  })
}

function broadcastDjSchedule() {
  const data = {
    type: 'djSchedule',
    serverNow: Date.now(),
    schedule: djScheduleSnapshot(),
  }
  broadcast(data)
}

function setDjMusicSource(player: Player) {
  if (player.role !== 'dj') return
  const now = Date.now()
  const djName = player.djName || player.displayName || 'DJ'
  const changed = musicSource !== 'dj' || djStreamPlayerId !== player.id
  musicSource = 'dj'
  djStreamPlayerId = player.id
  djStreamName = djName
  if (changed || djStreamStartedAt <= 0) djStreamStartedAt = now
  ensureDjScheduleItem(player, true)
  broadcastDjSchedule()
  broadcastMusicSync()
}

function clearDjMusicSource(playerId?: string | null) {
  if (musicSource !== 'dj') return
  if (playerId && djStreamPlayerId && djStreamPlayerId !== playerId) return
  musicSource = 'track'
  djStreamStartedAt = 0
  djStreamPlayerId = null
  djStreamName = ''
  broadcastMusicSync()
}

function ensureDjScheduleItem(player: Player, claimed = false) {
  if (!player.userId) return null
  const key = player.economyKey
  const now = Date.now()
  let item = djSchedule.get(key)
  if (!item) {
    const slotStartAt = nextDjSlotStart()
    item = {
      userId: key,
      playerId: player.id,
      displayName: player.displayName,
      djName: player.djName || player.displayName,
      slotStartAt,
      slotEndAt: slotStartAt + DJ_SET_DURATION_MS,
      online: true,
      lastSeenAt: now,
      claimedAt: claimed ? now : 0,
    }
    djSchedule.set(key, item)
  } else {
    item.playerId = player.id
    item.displayName = player.displayName
    item.djName = player.djName || player.displayName
    item.online = true
    item.lastSeenAt = now
    if (claimed) item.claimedAt = now
  }
  roleSlots.dj = player.id
  return item
}

function markDjOffline(player: Player) {
  clearDjMusicSource(player.id)
  if (!player.userId) return
  const item = djSchedule.get(player.economyKey)
  if (!item || item.playerId !== player.id) return
  item.playerId = null
  item.online = false
  item.lastSeenAt = Date.now()
}

function applyPersistedPlayerState(economyKey: string, state: PersistedPlayerState | null) {
  if (!state) return
  const rememberedRole = playerRoles.get(economyKey)
  playerRoles.set(economyKey, state.role === 'guest' && rememberedRole && rememberedRole !== 'guest' ? rememberedRole : state.role)
  clublesBalances.set(economyKey, state.clublesBalance)
  persistedVipAccess.set(economyKey, state.vipAccess)
  if (state.lockscreenMusicUntil > Date.now()) lockscreenMusicAccess.set(economyKey, state.lockscreenMusicUntil)
  else lockscreenMusicAccess.delete(economyKey)
  if (state.cooldownUntil > Date.now()) admissionCooldowns.set(economyKey, state.cooldownUntil)
  else admissionCooldowns.delete(economyKey)
}

function activeEntitlementsFor(player: Player) {
  const entitlements: string[] = []
  const vipAccess = persistedVipAccess.get(player.economyKey) || vipGuests.has(player.id) || canUseVipMezzanine(player)
  if (vipAccess) entitlements.push('vip')
  if (player.role !== 'guest') entitlements.push(`role:${player.role}`)
  return entitlements
}

function persistPlayerState(player: Player) {
  if (!player.userId) return
  void savePlayerPersistence({
    playerKey: player.economyKey,
    userId: player.userId,
    role: player.role,
    clublesBalance: player.clublesBalance,
    vipAccess: Boolean(persistedVipAccess.get(player.economyKey) || vipGuests.has(player.id) || canUseVipMezzanine(player)),
    lockscreenMusicUntil: player.lockscreenMusicUntil,
    cooldownUntil: player.cooldownUntil,
    activeEntitlements: activeEntitlementsFor(player),
  })
}

function setPlayerCooldown(player: Player, cooldownUntil: number) {
  player.cooldownUntil = Math.max(0, Math.floor(cooldownUntil))
  if (player.cooldownUntil > Date.now()) admissionCooldowns.set(player.economyKey, player.cooldownUntil)
  else admissionCooldowns.delete(player.economyKey)
  persistPlayerState(player)
}

function roleIsAvailable(role: PlayerRole, playerId: string, userId = '') {
  if (role === 'dj') return true
  if (!CLUB_ROLE_SLOTS.includes(role as ClubRole)) return true
  const current = roleSlots[role as ClubRole]
  if (!current || current === playerId) return true
  const holder = players.get(current)
  return !holder || holder.ws.readyState !== WebSocket.OPEN || Boolean(userId && holder.userId === userId)
}

function ensureClublesBalance(economyKey: string) {
  if (!clublesBalances.has(economyKey)) clublesBalances.set(economyKey, STARTING_CLUBLES)
  return clublesBalances.get(economyKey) ?? STARTING_CLUBLES
}

function setPlayerClubles(player: Player, balance: number) {
  player.clublesBalance = Math.max(0, Math.floor(balance))
  clublesBalances.set(player.economyKey, player.clublesBalance)
  persistPlayerState(player)
}

function rememberPlayerRole(player: Player, role = player.role) {
  playerRoles.set(player.economyKey, role)
  persistPlayerState(player)
}

function authorizedJoinRole(
  economyKey: string,
  userId: string,
  persistedState: PersistedPlayerState | null,
  handoff: PlayerSessionHandoff | null,
) {
  const rememberedRole = playerRoles.get(economyKey)
  if (rememberedRole) return rememberedRole
  if (persistedState) return persistedState.role
  if (handoff) return handoff.role
  return 'guest'
}

function cooldownUntilFor(economyKey: string) {
  const until = admissionCooldowns.get(economyKey) ?? 0
  if (until > Date.now()) return until
  if (until) admissionCooldowns.delete(economyKey)
  return 0
}

function lockscreenMusicUntilFor(economyKey: string) {
  const until = lockscreenMusicAccess.get(economyKey) ?? 0
  if (until > Date.now()) return until
  if (until) lockscreenMusicAccess.delete(economyKey)
  return 0
}

function setPlayerLockscreenMusic(player: Player, until: number, persist = false) {
  player.lockscreenMusicUntil = Math.max(0, Math.floor(until))
  if (player.lockscreenMusicUntil > Date.now()) {
    lockscreenMusicAccess.set(player.economyKey, player.lockscreenMusicUntil)
  } else {
    lockscreenMusicAccess.delete(player.economyKey)
  }
  if (persist) persistPlayerState(player)
}

function isLockscreenMusicService(item: DrinkMenuItem) {
  return item.kind === 'service'
}

function barOrdersSnapshot() {
  return Array.from(barOrders.values())
    .filter(order => order.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt)
}

function drinksSnapshot(playerId: string) {
  return (playerDrinks.get(playerId) ?? [])
    .filter(drink => drink.remaining > 0.001)
    .sort((a, b) => a.servedAt - b.servedAt)
}

function setPlayerDrinks(playerId: string, drinks: PlayerDrink[]) {
  const active = drinks.filter(drink => drink.remaining > 0.001)
  if (active.length) playerDrinks.set(playerId, active)
  else playerDrinks.delete(playerId)
}

function addPlayerDrink(playerId: string, drink: DrinkMenuItem) {
  const item: PlayerDrink = {
    id: `pd${nextPlayerDrinkId++}`,
    drinkId: drink.id,
    drinkName: drink.name,
    effect: drink.effect,
    remaining: 1,
    servedAt: Date.now(),
  }
  playerDrinks.set(playerId, [...drinksSnapshot(playerId), item])
  return item
}

function findPlayerDrink(playerId: string, drinkInstanceId: string) {
  return drinksSnapshot(playerId).find(drink => drink.id === drinkInstanceId) ?? null
}

function findBartender() {
  const bartenderId = roleSlots.bartender
  const bartender = bartenderId ? players.get(bartenderId) : null
  return bartender?.room === 'club' && bartender.ws.readyState === WebSocket.OPEN ? bartender : null
}

function drinkById(id: string) {
  return DRINK_MENU.find(drink => drink.id === id) ?? DRINK_MENU[0]
}

function canUseDjBooth(player: Player) {
  return player.role === 'dj' || player.role === 'vip' || player.role === 'owner' || player.role === 'admin'
}

function canUseVipMezzanine(player: Player) {
  if (persistedVipAccess.get(player.economyKey) || vipGuests.has(player.id)) return true
  return (
    player.role === 'vip' ||
    player.role === 'dj' ||
    player.role === 'owner' ||
    player.role === 'guard' ||
    player.role === 'bartender' ||
    player.role === 'bouncer' ||
    player.role === 'admin'
  )
}

function canFaceControl(player: Player) {
  return player.role === 'bouncer' || player.role === 'owner' || player.role === 'admin'
}

function canUseSecurityPanel(player: Player) {
  return player.role === 'guard' || player.role === 'bouncer' || player.role === 'owner' || player.role === 'admin'
}

function canUseOwnerPanel(player: Player) {
  return player.role === 'owner' || player.role === 'admin'
}

function canUseAdminPanel(player: Player) {
  return player.role === 'admin'
}

function canAssignManagedRole(actor: Player, role: PlayerRole) {
  if (canUseAdminPanel(actor)) return true
  if (!canUseOwnerPanel(actor)) return false
  return role !== 'owner' && role !== 'admin'
}

function canModerateTarget(actor: Player, target: Player) {
  if (actor.id === target.id) return false
  if (canUseAdminPanel(actor)) return true
  return target.role !== 'owner' && target.role !== 'admin'
}

function inRect(x: number, z: number, minX: number, maxX: number, minZ: number, maxZ: number) {
  return x >= minX && x <= maxX && z >= minZ && z <= maxZ
}

function isDjBoothFixturePosition(x: number, z: number) {
  return (
    inRect(x, z, -5.05, 5.05, -7.85, -5.75) ||
    inRect(x, z, -7.25, -4.35, -7.45, -6.05) ||
    inRect(x, z, 4.35, 7.25, -7.45, -6.05)
  )
}

function isRestrictedDjPlatformPosition(x: number, z: number) {
  return z < -7.15 && z > -9.55 && Math.abs(x) < 5.45
}

function isVipMezzaninePosition(x: number, z: number) {
  const mainDeck = Math.abs(x) < 6.35 && z < -10.62 && z > -14.28
  const stairLandings = Math.abs(x) > 5.35 && Math.abs(x) < 6.35 && z < -10.18 && z > -10.62
  return mainDeck || stairLandings
}

function isVipMezzanineStairPosition(x: number, z: number) {
  return Math.abs(x) > 5.35 && Math.abs(x) < 7.25 && z < -8.36 && z > -10.18
}

function isVipMezzanineGroundRestrictedPosition(x: number, z: number) {
  const underMainDeck = Math.abs(x) < 7.15 && z < -10.18 && z > -14.7
  const underStairs = Math.abs(x) > 5.25 && Math.abs(x) < 7.35 && z < -7.45 && z > -10.62
  return underMainDeck || underStairs
}

function resolveClubFloorLevel(current: ClubFloorLevel, x: number, z: number): ClubFloorLevel {
  if (current === 'vip') {
    if (isVipMezzaninePosition(x, z)) return 'vip'
    if (isVipMezzanineStairPosition(x, z)) return 'stairs'
    return 'ground'
  }
  if (current === 'stairs') {
    if (isVipMezzaninePosition(x, z)) return 'vip'
    if (isVipMezzanineStairPosition(x, z)) return 'stairs'
    return 'ground'
  }
  return isVipMezzanineStairPosition(x, z) ? 'stairs' : 'ground'
}

function isClubPositionBlockedForPlayer(player: Player, x: number, z: number, targetFloorLevel = resolveClubFloorLevel(player.floorLevel, x, z)) {
  if ((targetFloorLevel === 'vip' || targetFloorLevel === 'stairs') && !canUseVipMezzanine(player)) return true
  if (player.floorLevel === 'vip' && targetFloorLevel === 'ground') return true
  if (targetFloorLevel === 'vip' || targetFloorLevel === 'stairs') return false
  if (!canUseVipMezzanine(player) && isVipMezzanineGroundRestrictedPosition(x, z)) return true
  if (isDjBoothFixturePosition(x, z)) return true
  return isRestrictedDjPlatformPosition(x, z) && !canUseDjBooth(player)
}

function grantStaffRole(playerId: string, player: Player, role: PlayerRole) {
  clearRoleSlot(playerId)
  player.role = role
  rememberPlayerRole(player, role)
  player.inQueue = false
  player.insideClub = true
  if (role === 'dj' && !player.djName) player.djName = player.displayName
  if (role === 'dj') ensureDjScheduleItem(player, true)
  if (role === 'bartender') {
    player.x = BAR_WORK_SPAWN.x
    player.z = BAR_WORK_SPAWN.z
    player.floorLevel = 'ground'
    player.moving = false
  }
  if (CLUB_ROLE_SLOTS.includes(role as ClubRole)) roleSlots[role as ClubRole] = playerId
  if (role === 'vip' || role === 'owner' || role === 'admin') {
    vipGuests.add(playerId)
    persistedVipAccess.set(player.economyKey, true)
  }
  persistPlayerState(player)
  if (role === 'dj') broadcastDjSchedule()
}

function assignPlayerRole(playerId: string, player: Player, role: PlayerRole) {
  const wasBartender = player.role === 'bartender'
  const wasDj = player.role === 'dj'
  clearRoleSlot(playerId)
  if (wasDj && role !== 'dj') markDjOffline(player)
  player.role = role
  rememberPlayerRole(player, role)
  if (role === 'dj' && !player.djName) player.djName = player.displayName
  if (role === 'dj') ensureDjScheduleItem(player, true)
  if (role === 'bartender') {
    player.x = BAR_WORK_SPAWN.x
    player.z = BAR_WORK_SPAWN.z
    player.floorLevel = 'ground'
    player.moving = false
  }
  if (CLUB_ROLE_SLOTS.includes(role as ClubRole)) roleSlots[role as ClubRole] = playerId
  if (role === 'vip' || role === 'owner' || role === 'admin') {
    vipGuests.add(playerId)
    persistedVipAccess.set(player.economyKey, true)
  } else {
    vipGuests.delete(playerId)
    persistedVipAccess.set(player.economyKey, false)
  }
  persistPlayerState(player)
  if (wasDj || role === 'dj') broadcastDjSchedule()

  if (wasBartender && role !== 'bartender') {
    for (const order of Array.from(barOrders.values())) {
      barOrders.delete(order.id)
      sendTo(order.customerId, {
        type: 'gameplayEvent',
        event: {
          kind: 'barClosed',
          clubEnergy,
          roleSlots: roleSlotsSnapshot(),
          text: 'Бармен ушёл со смены, заказ отменён',
        },
      })
    }
  }

  sendTo(playerId, { type: 'roleChanged', role })
  if (role === 'bartender') {
    sendTo(playerId, { type:'selfPosition', x:player.x, z:player.z, floorLevel:player.floorLevel, rotY:player.rotY, moving:false, musicDanceIntensity:player.musicDanceIntensity })
    broadcast({ type:'playerMoved', id:playerId, x:player.x, z:player.z, floorLevel:player.floorLevel, rotY:player.rotY, moving:false, musicDanceIntensity:player.musicDanceIntensity }, playerId, player.room)
  }
  if (canFaceControl(player)) sendTo(playerId, { type:'queueUpdate', queue:queueSnapshot() })
  sendGameplayState(player)
}

function setClubEnergy(next: number) {
  clubEnergy = clamp(next, 0.18, 1)
}

function playerDressScore(player: Player) {
  let score = 0
  if (player.faceTextureUrl) score += 0.28
  if (player.bodyTextureUrl) score += 0.34
  if (player.topColor && player.topColor !== '#222244') score += 0.18
  if (player.bottomColor && player.bottomColor !== '#111133') score += 0.14
  if (player.hairColor && player.hairColor !== '#1a1008') score += 0.06
  return score
}

function managementPlayersSnapshot() {
  return Array.from(players.values())
    .sort((a, b) => {
      if (a.room !== b.room) return a.room === 'club' ? -1 : 1
      return a.displayName.localeCompare(b.displayName)
    })
    .map(player => ({
      id: player.id,
      displayName: player.displayName,
      role: player.role,
      room: player.room,
      x: Math.round(player.x * 10) / 10,
      z: Math.round(player.z * 10) / 10,
      floorLevel: player.floorLevel,
      inQueue: player.inQueue,
      queuePos: player.inQueue ? queue.indexOf(player.id) + 1 : 0,
      insideClub: player.insideClub,
      vipAccess: Boolean(persistedVipAccess.get(player.economyKey) || vipGuests.has(player.id) || canUseVipMezzanine(player)),
      clublesBalance: player.clublesBalance,
      cooldownUntil: player.cooldownUntil || 0,
      topColor: player.topColor,
      bottomColor: player.bottomColor,
    }))
}

function forcePlayerOutside(target: Player, reason: string) {
  const wasClub = target.room === 'club'
  const queueIndex = queue.indexOf(target.id)
  if (queueIndex !== -1) queue.splice(queueIndex, 1)
  if (target.role === 'bartender') {
    for (const order of Array.from(barOrders.values())) {
      barOrders.delete(order.id)
      sendTo(order.customerId, {
        type: 'gameplayEvent',
        event: {
          kind: 'barClosed',
          clubEnergy,
          roleSlots: roleSlotsSnapshot(),
          text: 'Бармен ушёл со смены, заказ отменён',
        },
      })
    }
  }

  clearRoleSlot(target.id)
  if (target.role === 'dj') markDjOffline(target)
  vipGuests.delete(target.id)
  persistedVipAccess.set(target.economyKey, false)
  target.role = 'guest'
  rememberPlayerRole(target, 'guest')
  target.inQueue = false
  target.insideClub = false
  target.room = 'outside'
  const spawn = findSpawnPos('outside')
  target.x = spawn.x
  target.z = spawn.z
  target.floorLevel = 'ground'
  target.moving = false
  target.musicDanceIntensity = 0
  sendTo(target.id, { type: 'roleChanged', role: target.role })
  sendTo(target.id, { type: 'forcedOutside', reason, x: target.x, z: target.z })
  if (wasClub) broadcast({ type:'playerLeft', id: target.id }, target.id, 'club')
  broadcast({ type:'queueUpdate', queue:queueSnapshot() })
  broadcastDjSchedule()
}

function sendGameplayState(player: Player) {
  setPlayerLockscreenMusic(player, lockscreenMusicUntilFor(player.economyKey))
  sendTo(player.id, {
    type: 'gameplayState',
    protocolVersion: SERVER_PROTOCOL_VERSION,
    room: player.room,
    clubEnergy,
    vipAccess: Boolean(persistedVipAccess.get(player.economyKey) || vipGuests.has(player.id) || canUseVipMezzanine(player)),
    roleSlots: roleSlotsSnapshot(),
    clublesBalance: player.clublesBalance,
    lockscreenMusicUntil: player.lockscreenMusicUntil,
    activeEntitlements: activeEntitlementsFor(player),
    musicSource,
    musicTrackIdx,
    musicTrackCount,
    musicState: currentMusicState(),
    djSchedule: djScheduleSnapshot(),
    drinkMenu: DRINK_MENU,
    drinks: drinksSnapshot(player.id),
    barOrders: player.role === 'bartender' ? barOrdersSnapshot() : [],
    bartenderStats: player.role === 'bartender'
      ? { sales: player.bartenderSales, tips: player.bartenderTips }
      : undefined,
    managementPlayers: canUseSecurityPanel(player) ? managementPlayersSnapshot() : undefined,
  })
}

function broadcastGameplayState() {
  players.forEach(player => {
    if (player.ws.readyState === WebSocket.OPEN) sendGameplayState(player)
  })
}

function broadcastManagementState() {
  players.forEach(player => {
    if (player.ws.readyState === WebSocket.OPEN && canUseSecurityPanel(player)) {
      sendGameplayState(player)
    }
  })
}

function broadcastGameplayEvent(event: object, except?: string) {
  broadcast({
    type: 'gameplayEvent',
    event: {
      clubEnergy,
      roleSlots: roleSlotsSnapshot(),
      ...event,
    },
  }, except, 'club')
}

function broadcastMusicSync() {
  const musicState = currentMusicState()
  broadcast({
    type: 'musicSync',
    protocolVersion: SERVER_PROTOCOL_VERSION,
    source: musicState.source,
    trackIdx: musicTrackIdx,
    trackCount: musicTrackCount,
    startedAt: musicState.startedAt,
    serverNow: musicState.serverNow,
    musicState,
  })
}

function broadcastMusicState() {
  const musicState = currentMusicState()
  broadcast({
    type: 'musicState',
    protocolVersion: SERVER_PROTOCOL_VERSION,
    source: musicState.source,
    serverNow: musicState.serverNow,
    musicState,
  })
}

function maybeAdvanceMusicTrack() {
  for (let i = 0; i < musicTrackCount; i++) {
    const durationSec = musicDurationsSec.get(musicTrackIdx)
    if (!durationSec || durationSec < 5) return

    const elapsedMs = Date.now() - musicStartedAt
    if (elapsedMs < durationSec * 1000) return

    musicTrackIdx = (musicTrackIdx + 1) % musicTrackCount
    musicStartedAt += durationSec * 1000
  }
}

function collisionNormal(fromX: number, fromZ: number, targetX: number, targetZ: number, other: Player) {
  const targetDx = targetX - other.x
  const targetDz = targetZ - other.z
  const targetDist = Math.hypot(targetDx, targetDz)
  if (targetDist > 0.0001) return { x: targetDx / targetDist, z: targetDz / targetDist }

  const fromDx = fromX - other.x
  const fromDz = fromZ - other.z
  const fromDist = Math.hypot(fromDx, fromDz)
  if (fromDist > 0.0001) return { x: fromDx / fromDist, z: fromDz / fromDist }

  const moveDx = targetX - fromX
  const moveDz = targetZ - fromZ
  const moveDist = Math.hypot(moveDx, moveDz)
  if (moveDist > 0.0001) return { x: moveDx / moveDist, z: moveDz / moveDist }

  return { x: 1, z: 0 }
}

function resolvePlayerCollision(playerId: string, room: 'outside' | 'club', fromX: number, fromZ: number, targetX: number, targetZ: number, floorLevel?: ClubFloorLevel) {
  let x = targetX
  let z = targetZ
  let adjusted = false
  const minDistance = PLAYER_MIN_DISTANCE + PLAYER_COLLISION_PADDING
  const minDistanceSq = minDistance * minDistance

  for (let i = 0; i < PLAYER_COLLISION_ITERATIONS; i += 1) {
    let changedThisPass = false

    for (const other of players.values()) {
      if (other.id === playerId || other.room !== room) continue
      if (room === 'club' && floorLevel && other.floorLevel !== floorLevel) continue

      let dx = x - other.x
      let dz = z - other.z
      let distSq = dx * dx + dz * dz
      if (distSq >= minDistanceSq) continue

      const normal = collisionNormal(fromX, fromZ, x, z, other)
      const moveX = x - fromX
      const moveZ = z - fromZ
      const inward = moveX * normal.x + moveZ * normal.z

      if (inward < 0) {
        x -= inward * normal.x
        z -= inward * normal.z
      }

      dx = x - other.x
      dz = z - other.z
      distSq = dx * dx + dz * dz
      if (distSq < minDistanceSq) {
        const dist = Math.sqrt(distSq)
        const nx = dist > 0.0001 ? dx / dist : normal.x
        const nz = dist > 0.0001 ? dz / dist : normal.z
        x = other.x + nx * minDistance
        z = other.z + nz * minDistance
      }

      adjusted = true
      changedThisPass = true
    }

    if (!changedThisPass) break
  }

  return { x, z, adjusted }
}

function sendTo(id: string, data: object) {
  const p = players.get(id)
  if (p?.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(data))
}

function queueSnapshot() {
  return queue.map((id, i) => {
    const p = players.get(id)
    if (!p) return null
    return {
      id: p.id, pos: i + 1,
      displayName: p.displayName,
      topColor: p.topColor, bottomColor: p.bottomColor,
      hairColor: p.hairColor, skinTone: p.skinTone,
      faceTextureUrl: p.faceTextureUrl,
      bodyTextureUrl: p.bodyTextureUrl,
      modelUrl: p.modelUrl,
    }
  }).filter(Boolean)
}

function removeQueuedPlayersForAccount(player: Player) {
  let removed = false
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const queuedPlayerId = queue[i]
    if (queuedPlayerId === player.id) continue

    const queuedPlayer = players.get(queuedPlayerId)
    if (!queuedPlayer) {
      queue.splice(i, 1)
      removed = true
      continue
    }
    if (queuedPlayer.accountKey !== player.accountKey) continue

    queue.splice(i, 1)
    queuedPlayer.inQueue = false
    queuedPlayer.queuePos = 0
    sendTo(queuedPlayer.id, { type: 'queueLeft' })
    removed = true
  }
  return removed
}

function findSpawnPos(room: 'outside' | 'club'): { x: number; z: number } {
  const slots = room === 'club'
    ? [
      {x:0,z:4.8},{x:1.4,z:4.8},{x:-1.4,z:4.8},{x:2.8,z:3.8},{x:-2.8,z:3.8},
      {x:4.2,z:1.6},{x:-4.2,z:1.6},{x:2.2,z:-1.3},{x:-2.2,z:-1.3},
      {x:7.2,z:2.5},{x:-7.2,z:2.5},
    ]
    : [
      {x:0,z:6},{x:1.5,z:6},{x:-1.5,z:6},{x:3,z:6},{x:-3,z:6},
      {x:0,z:8},{x:1.5,z:8},{x:-1.5,z:8},{x:3,z:8},{x:-3,z:8},
      {x:5,z:7},{x:-5,z:7},{x:0,z:10},{x:2,z:10},{x:-2,z:10},
    ]
  for (const s of slots) {
    let free = true
    players.forEach(p => {
      if (p.room === room && Math.sqrt((p.x-s.x)**2+(p.z-s.z)**2) < 1.0) free = false
    })
    if (free) return s
  }
  return room === 'club'
    ? { x: (Math.random()-0.5)*8, z: -1+Math.random()*6 }
    : { x: (Math.random()-0.5)*10, z: 5+Math.random()*5 }
}

function isClubFloorLevel(value: unknown): value is ClubFloorLevel {
  return value === 'ground' || value === 'stairs' || value === 'vip'
}

function requestedClubSpawnFromMessage(msg: any, player: Player): { x: number; z: number; floorLevel: ClubFloorLevel } | null {
  const x = Number(msg.lastX)
  const z = Number(msg.lastZ)
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null
  if (x < CLUB_WALK_BOUNDS.minX || x > CLUB_WALK_BOUNDS.maxX || z < CLUB_WALK_BOUNDS.minZ || z > CLUB_WALK_BOUNDS.maxZ) return null

  const requestedFloorLevel = isClubFloorLevel(msg.lastFloorLevel) ? msg.lastFloorLevel : 'ground'
  const floorLevel = resolveClubFloorLevel(requestedFloorLevel, x, z)
  if (isClubPositionBlockedForPlayer(player, x, z, floorLevel)) return null

  for (const other of players.values()) {
    if (other.id === player.id || other.room !== 'club' || other.floorLevel !== floorLevel) continue
    if (Math.hypot(other.x - x, other.z - z) < PLAYER_MIN_DISTANCE) return null
  }

  return { x, z, floorLevel }
}

wss.on('connection', (ws) => {
  let playerId: string | null = null

  ws.on('message', async (raw) => {
    let msg: any
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.type === 'join') {
      playerId = `p${nextId++}`
      const room: 'outside' | 'club' = msg.room === 'club' ? 'club' : 'outside'
      const requestedUserId = typeof msg.userId === 'string' ? msg.userId : ''
      const requestedEmail = normalizeAccountEmail(msg.email)
      const clientSessionId = normalizeClientSessionId(msg.clientSessionId)
      const anonymousSessionKey = clientSessionId ? `session:${clientSessionId}` : ''
      const economyKey = requestedUserId || anonymousSessionKey || playerId
      const accountKey = accountKeyFor(requestedEmail, requestedUserId, clientSessionId, playerId)
      const persistedState = requestedUserId ? await loadPlayerPersistence(economyKey) : null
      applyPersistedPlayerState(economyKey, persistedState)
      const handoff = closeExistingSessions(accountKey, playerId)
      const authorizedRole = authorizedJoinRole(economyKey, requestedUserId, persistedState, handoff)
      const joinRole = roleIsAvailable(authorizedRole, playerId, requestedUserId) ? authorizedRole : 'guest'
      const spawn = room === 'club' && joinRole === 'dj'
        ? DJ_BOOTH_SPAWN
        : room === 'club' && joinRole === 'bartender'
          ? BAR_WORK_SPAWN
          : findSpawnPos(room)
      const player: Player = {
        id: playerId, userId: requestedUserId, economyKey, accountKey, ws, room,
        displayName:    msg.displayName    || 'Аноним',
        topColor:       msg.topColor       || '#222244',
        bottomColor:    msg.bottomColor    || '#111133',
        hairColor:      msg.hairColor      || '#1a1008',
        skinTone:       msg.skinTone       || '#c8956c',
        faceTextureUrl: msg.faceTextureUrl || '',
        bodyTextureUrl: msg.bodyTextureUrl || '',
        modelUrl:       typeof msg.modelUrl === 'string' ? msg.modelUrl : '',
        djName:         joinRole === 'dj' ? String(msg.djName || msg.displayName || 'DJ').trim().slice(0, 24) : '',
        x: spawn.x, z: spawn.z, floorLevel: 'ground', rotY: 0, moving: false, musicDanceIntensity: 0,
        role: joinRole,
        clublesBalance: ensureClublesBalance(economyKey),
        lockscreenMusicUntil: lockscreenMusicUntilFor(economyKey),
        bartenderSales: 0,
        bartenderTips: 0,
        inQueue: false, queuePos: 0, cooldownUntil: cooldownUntilFor(economyKey), insideClub: room === 'club',
      }
      if (handoff?.room === room) {
        player.x = handoff.x
        player.z = handoff.z
        player.floorLevel = handoff.floorLevel
        player.rotY = handoff.rotY
        player.musicDanceIntensity = handoff.musicDanceIntensity
        player.cooldownUntil = Math.max(player.cooldownUntil, handoff.cooldownUntil)
        player.insideClub = handoff.insideClub
        if (handoff.djName) player.djName = handoff.djName
      }
      if (room === 'club') {
        const requestedSpawn = requestedClubSpawnFromMessage(msg, player)
        if (requestedSpawn) {
          player.x = requestedSpawn.x
          player.z = requestedSpawn.z
          player.floorLevel = requestedSpawn.floorLevel
        }
      }
      players.set(playerId, player)
      let restoredQueue = false
      if (handoff?.room === 'outside' && room === 'outside' && handoff.inQueue && !player.insideClub) {
        removeQueuedPlayersForAccount(player)
        player.inQueue = true
        const queueIndex = handoff.queueIndex >= 0 ? Math.min(handoff.queueIndex, queue.length) : queue.length
        queue.splice(queueIndex, 0, playerId)
        restoredQueue = true
      }
      if (CLUB_ROLE_SLOTS.includes(player.role as ClubRole)) roleSlots[player.role as ClubRole] = playerId
      if (persistedVipAccess.get(player.economyKey) || player.role === 'vip' || player.role === 'owner' || player.role === 'admin') vipGuests.add(playerId)
      if (player.role === 'dj') {
        ensureDjScheduleItem(player, true)
        if (handoff?.djStreamActive) setDjMusicSource(player)
      }
      persistPlayerState(player)
      console.log(`[+] ${playerId} (${player.displayName}) room=${player.room} role=${player.role}. Total: ${players.size}`)

      const others = Array.from(players.values())
        .filter(p => p.id !== playerId && p.room === room)
        .map(p => ({
          id: p.id, displayName: p.displayName, role: p.role, djName: p.djName,
          topColor: p.topColor, bottomColor: p.bottomColor,
          hairColor: p.hairColor, skinTone: p.skinTone,
          faceTextureUrl: p.faceTextureUrl, bodyTextureUrl: p.bodyTextureUrl,
          modelUrl: p.modelUrl,
          x: p.x, z: p.z, floorLevel: p.floorLevel, rotY: p.rotY, moving: p.moving, musicDanceIntensity: p.musicDanceIntensity,
        }))
      const welcomeMusicState = currentMusicState()

      ws.send(JSON.stringify({
        type: 'welcome',
        protocolVersion: SERVER_PROTOCOL_VERSION,
        room: player.room,
        id: playerId,
        myX: player.x,
        myZ: player.z,
        myFloorLevel: player.floorLevel,
        role: player.role,
        players: others,
        queue: queueSnapshot(),
        cooldownUntil: player.cooldownUntil,
        musicSource,
        musicTrackIdx,
        musicTrackCount,
        musicStartedAt: welcomeMusicState.startedAt,
        musicServerNow: welcomeMusicState.serverNow,
        musicState: welcomeMusicState,
      }))

      broadcast({
        type: 'playerJoined',
        player: {
          id: playerId, displayName: player.displayName, role: player.role, djName: player.djName,
          topColor: player.topColor, bottomColor: player.bottomColor,
          hairColor: player.hairColor, skinTone: player.skinTone,
          faceTextureUrl: player.faceTextureUrl, bodyTextureUrl: player.bodyTextureUrl,
          modelUrl: player.modelUrl,
          x: player.x, z: player.z, floorLevel: player.floorLevel, rotY: player.rotY, moving: player.moving, musicDanceIntensity: player.musicDanceIntensity,
        }
      }, playerId, player.room)

      if (canFaceControl(player))
        ws.send(JSON.stringify({ type: 'queueUpdate', queue: queueSnapshot() }))
      if (restoredQueue) {
        ws.send(JSON.stringify({ type:'queueJoined', pos:queue.indexOf(playerId) + 1 }))
        broadcast({ type:'queueUpdate', queue:queueSnapshot() })
      }
      sendGameplayState(player)
      sendDjSchedule(player)
      if (player.role === 'dj') broadcastDjSchedule()

    } else if (msg.type === 'avatarUpdate' && playerId) {
      const p = players.get(playerId); if (!p) return
      p.faceTextureUrl = msg.faceTextureUrl || p.faceTextureUrl
      p.bodyTextureUrl = msg.bodyTextureUrl || p.bodyTextureUrl
      p.topColor       = msg.topColor       || p.topColor
      p.bottomColor    = msg.bottomColor    || p.bottomColor
      p.modelUrl       = typeof msg.modelUrl === 'string' ? msg.modelUrl : p.modelUrl
      broadcast({
        type: 'avatarUpdated',
        id: playerId,
        faceTextureUrl: p.faceTextureUrl,
        bodyTextureUrl: p.bodyTextureUrl,
        topColor: p.topColor,
        bottomColor: p.bottomColor,
        modelUrl: p.modelUrl,
      }, playerId, p.room)
      if (p.inQueue) broadcast({ type: 'queueUpdate', queue: queueSnapshot() })

    } else if (msg.type === 'setDisplayName' && playerId) {
      const p = players.get(playerId); if (!p) return
      const nextName = String(msg.displayName || '').trim().slice(0, 24)
      if (!nextName) return
      p.displayName = nextName
      if (p.role === 'dj') {
        ensureDjScheduleItem(p, true)
        if (musicSource === 'dj' && djStreamPlayerId === playerId) {
          djStreamName = p.djName || p.displayName || 'DJ'
          broadcastMusicSync()
        }
        broadcastDjSchedule()
      }
      broadcast({ type: 'displayNameChanged', id: playerId, displayName: p.displayName }, undefined, p.room)
      if (p.inQueue) broadcast({ type: 'queueUpdate', queue: queueSnapshot() })

    } else if (msg.type === 'setDjName' && playerId) {
      const p = players.get(playerId); if (!p || p.role !== 'dj') return
      const nextName = String(msg.djName || '').trim().slice(0, 24)
      if (!nextName) return
      p.djName = nextName
      ensureDjScheduleItem(p, true)
      if (musicSource === 'dj' && djStreamPlayerId === playerId) {
        djStreamName = p.djName
        broadcastMusicSync()
      }
      broadcast({ type: 'djNameChanged', id: playerId, djName: p.djName }, undefined, p.room)
      broadcastDjSchedule()

    } else if (msg.type === 'djScheduleClaim' && playerId) {
      const p = players.get(playerId); if (!p || p.role !== 'dj') return
      ensureDjScheduleItem(p, true)
      sendGameplayState(p)
      broadcastDjSchedule()

    } else if (msg.type === 'djStreamState' && playerId) {
      const p = players.get(playerId); if (!p || p.role !== 'dj') return
      if (msg.active) setDjMusicSource(p)
      else clearDjMusicSource(playerId)

    } else if (msg.type === 'move' && playerId) {
      const p = players.get(playerId); if (!p) return
      const nextX = Number(msg.x)
      const nextZ = Number(msg.z)
      const nextRotY = Number(msg.rotY)
      if (!Number.isFinite(nextX) || !Number.isFinite(nextZ) || !Number.isFinite(nextRotY)) return

      const boundedTarget = clampWalkPosition(p.room, nextX, nextZ)
      const nextFloorLevel = p.room === 'club' ? resolveClubFloorLevel(p.floorLevel, boundedTarget.x, boundedTarget.z) : 'ground'
      const blockedMove = p.room === 'club' && isClubPositionBlockedForPlayer(p, boundedTarget.x, boundedTarget.z, nextFloorLevel)
      const guardedX = blockedMove ? p.x : boundedTarget.x
      const guardedZ = blockedMove ? p.z : boundedTarget.z
      const guardedFloorLevel = blockedMove ? p.floorLevel : nextFloorLevel
      const resolved = resolvePlayerCollision(playerId, p.room, p.x, p.z, guardedX, guardedZ, guardedFloorLevel)
      const boundedResolved = clampWalkPosition(p.room, resolved.x, resolved.z)
      if (boundedResolved.x !== resolved.x || boundedResolved.z !== resolved.z) {
        resolved.x = boundedResolved.x
        resolved.z = boundedResolved.z
        resolved.adjusted = true
      }
      const resolvedFloorLevel = p.room === 'club' ? resolveClubFloorLevel(p.floorLevel, resolved.x, resolved.z) : 'ground'
      if (p.room === 'club' && isClubPositionBlockedForPlayer(p, resolved.x, resolved.z, resolvedFloorLevel)) {
        resolved.x = p.x
        resolved.z = p.z
        resolved.adjusted = true
      }

      const nextMusicDanceIntensity = Number(msg.musicDanceIntensity)
      const moveX = resolved.x - p.x
      const moveZ = resolved.z - p.z
      const movedDistance = Math.hypot(moveX, moveZ)
      const requestedMoving = Boolean(msg.moving)
      const resolvedRotY = requestedMoving && movedDistance > 0.002 ? Math.atan2(moveX, moveZ) : (requestedMoving ? p.rotY : nextRotY)
      p.x=resolved.x; p.z=resolved.z; p.floorLevel = blockedMove ? p.floorLevel : resolvedFloorLevel; p.rotY=resolvedRotY; p.moving=requestedMoving && movedDistance > 0.002
      p.musicDanceIntensity = Number.isFinite(nextMusicDanceIntensity) ? clamp(nextMusicDanceIntensity, 0, 1) : 0
      if (resolved.adjusted || guardedX !== nextX || guardedZ !== nextZ) {
        ws.send(JSON.stringify({ type:'selfPosition', x:p.x, z:p.z, floorLevel:p.floorLevel, rotY:p.rotY, moving:p.moving, musicDanceIntensity:p.musicDanceIntensity }))
      }
      broadcast({ type:'playerMoved', id:playerId, x:p.x, z:p.z, floorLevel:p.floorLevel, rotY:p.rotY, moving:p.moving, musicDanceIntensity:p.musicDanceIntensity }, playerId, p.room)

    } else if (msg.type === 'joinQueue' && playerId) {
      const p = players.get(playerId); if (!p) return
      const activeCooldown = Math.max(p.cooldownUntil, cooldownUntilFor(p.economyKey))
      if (activeCooldown > Date.now()) {
        setPlayerCooldown(p, activeCooldown)
        ws.send(JSON.stringify({ type:'queueDenied', reason:'cooldown', cooldownUntil:p.cooldownUntil }))
        return
      }
      if (p.inQueue || p.insideClub) return
      const removedDuplicateQueueEntries = removeQueuedPlayersForAccount(p)
      p.inQueue = true
      queue.push(playerId)
      console.log(`  [Q] ${p.displayName} joined queue. Size: ${queue.length}`)
      ws.send(JSON.stringify({ type:'queueJoined', pos:queue.length }))
      broadcast({ type:'queueUpdate', queue:queueSnapshot() })
      if (removedDuplicateQueueEntries) sendGameplayState(p)

    } else if (msg.type === 'leaveQueue' && playerId) {
      const p = players.get(playerId); if (!p || !p.inQueue) return
      const idx = queue.indexOf(playerId)
      if (idx !== -1) queue.splice(idx, 1)
      p.inQueue = false; p.queuePos = 0
      ws.send(JSON.stringify({ type:'queueLeft' }))
      broadcast({ type:'queueUpdate', queue:queueSnapshot() })

    } else if (msg.type === 'approve' && playerId) {
      const bouncer = players.get(playerId)
      if (!bouncer || !canFaceControl(bouncer)) return
      const target = players.get(msg.targetId); if (!target) return
      const idx = queue.indexOf(msg.targetId)
      if (idx !== -1) queue.splice(idx, 1)
      target.inQueue = false; target.insideClub = true
      console.log(`  [✓] ${bouncer.displayName} approved ${target.displayName}`)
      void recordAdmissionEvent({
        playerKey: target.economyKey,
        userId: target.userId,
        result: 'approved',
        reason: null,
        cooldownUntil: 0,
        actorPlayerKey: bouncer.economyKey,
        actorUserId: bouncer.userId,
      })
      sendTo(msg.targetId, { type:'admitted', role: target.role })
      broadcast({ type:'playerLeft', id:msg.targetId }, msg.targetId, 'outside')
      broadcast({ type:'queueUpdate', queue:queueSnapshot() })

    } else if (msg.type === 'deny' && playerId) {
      const bouncer = players.get(playerId)
      if (!bouncer || !canFaceControl(bouncer)) return
      const target = players.get(msg.targetId); if (!target) return
      const idx = queue.indexOf(msg.targetId)
      if (idx !== -1) queue.splice(idx, 1)
      target.inQueue = false
      setPlayerCooldown(target, Date.now() + COOLDOWN_MS)
      console.log(`  [✗] ${bouncer.displayName} denied ${target.displayName} reason=${msg.reason}`)
      void recordAdmissionEvent({
        playerKey: target.economyKey,
        userId: target.userId,
        result: 'denied',
        reason: String(msg.reason || 'vibe_check'),
        cooldownUntil: target.cooldownUntil,
        actorPlayerKey: bouncer.economyKey,
        actorUserId: bouncer.userId,
      })
      sendTo(msg.targetId, { type:'denied', reason:msg.reason||'vibe_check', cooldownUntil:target.cooldownUntil })
      broadcast({ type:'queueUpdate', queue:queueSnapshot() })

    } else if (msg.type === 'staffEntry' && playerId) {
      const p = players.get(playerId); if (!p) return
      const inviteRole = String(msg.inviteRole || '') as StaffInviteRole
      const invite = STAFF_ENTRY_INVITES[inviteRole]
      if (!invite) {
        ws.send(JSON.stringify({ type: 'staffEntryDenied', reason: 'role', attemptsLeft: 3, exhausted: false }))
        return
      }

      if (String(msg.password || '') !== invite.password) {
        const attempts = (staffEntryAttempts.get(playerId) ?? 0) + 1
        const attemptsLeft = Math.max(0, 3 - attempts)
        if (attempts >= 3) {
          staffEntryAttempts.delete(playerId)
          p.x = STAFF_ENTRY_SPAWN.x
          p.z = STAFF_ENTRY_SPAWN.z
          p.floorLevel = 'ground'
          p.moving = false
          ws.send(JSON.stringify({
            type: 'staffEntryDenied',
            reason: 'attempts',
            attemptsLeft: 0,
            exhausted: true,
            x: p.x,
            z: p.z,
            floorLevel: p.floorLevel,
          }))
          broadcast({ type:'playerMoved', id:playerId, x:p.x, z:p.z, floorLevel:p.floorLevel, rotY:p.rotY, moving:false, musicDanceIntensity:p.musicDanceIntensity }, playerId, p.room)
        } else {
          staffEntryAttempts.set(playerId, attempts)
          ws.send(JSON.stringify({ type: 'staffEntryDenied', reason: 'password', attemptsLeft, exhausted: false }))
        }
        return
      }

      if (!roleIsAvailable(invite.role, playerId, p.userId)) {
        ws.send(JSON.stringify({ type: 'staffEntryDenied', reason: 'role_taken', attemptsLeft: Math.max(0, 3 - (staffEntryAttempts.get(playerId) ?? 0)), exhausted: false }))
        return
      }

      staffEntryAttempts.delete(playerId)
      grantStaffRole(playerId, p, invite.role)
      const idx = queue.indexOf(playerId)
      if (idx !== -1) queue.splice(idx, 1)
      ws.send(JSON.stringify({ type: 'staffEntryAdmitted', role: invite.role }))
      ws.send(JSON.stringify({ type:'roleChanged', role: invite.role }))
      if (invite.role === 'bartender') {
        ws.send(JSON.stringify({ type:'selfPosition', x:p.x, z:p.z, floorLevel:p.floorLevel, rotY:p.rotY, moving:false, musicDanceIntensity:p.musicDanceIntensity }))
        broadcast({ type:'playerMoved', id:playerId, x:p.x, z:p.z, floorLevel:p.floorLevel, rotY:p.rotY, moving:false, musicDanceIntensity:p.musicDanceIntensity }, playerId, p.room)
      }
      broadcast({ type:'queueUpdate', queue:queueSnapshot() })

    } else if (msg.type === 'setRole' && playerId) {
      const p = players.get(playerId); if (!p) return
      const nextRole = VALID_ROLES.has(msg.role) ? msg.role as PlayerRole : null
      if (!nextRole) return
      if (nextRole !== p.role && !canAssignManagedRole(p, nextRole)) return
      if (!roleIsAvailable(nextRole, playerId, p.userId)) {
        ws.send(JSON.stringify({
          type: 'gameplayEvent',
          event: {
            kind: 'roleDenied',
            text: 'Роль уже занята',
            role: nextRole,
            clubEnergy,
            roleSlots: roleSlotsSnapshot(),
          },
        }))
        return
      }

      assignPlayerRole(playerId, p, nextRole)
      if (p.room === 'club') {
        broadcastGameplayEvent({
          kind: 'roleChanged',
          actorId: playerId,
          displayName: p.displayName,
          role: nextRole,
          text: `${p.displayName}: ${nextRole}`,
        })
        broadcastManagementState()
      }
    } else if (msg.type === 'gameplayAction' && playerId) {
      const p = players.get(playerId); if (!p || p.room !== 'club') return
      const action = String(msg.action || '')

      if (action === 'crowdHype') {
        const boost = p.role === 'dj' ? 0.16 : p.role === 'bartender' ? 0.09 : 0.06
        setClubEnergy(clubEnergy + boost)
        broadcastGameplayEvent({
          kind: 'crowdHype',
          actorId: playerId,
          displayName: p.displayName,
          text: p.role === 'dj' ? 'DJ раскачивает танцпол' : `${p.displayName} заводит толпу`,
        })
      } else if (action === 'orderDrink') {
        const bartender = findBartender()
        if (!bartender) {
          sendTo(playerId, {
            type: 'gameplayEvent',
            event: {
              kind: 'barClosed',
              clubEnergy,
              roleSlots: roleSlotsSnapshot(),
              clublesBalance: p.clublesBalance,
              text: 'Бар закрыт: бармен не на смене',
            },
          })
          return
        }

        const drink = drinkById(String(msg.drinkId || ''))
        const tip = clamp(Math.floor(Number(msg.tip) || 0), 0, 500)
        const total = drink.price + tip
        if (p.clublesBalance < total) {
          sendTo(playerId, {
            type: 'gameplayEvent',
            event: {
              kind: 'notEnoughClubles',
              clubEnergy,
              roleSlots: roleSlotsSnapshot(),
              clublesBalance: p.clublesBalance,
              text: `Не хватает Клублей: нужно ${total}`,
            },
          })
          return
        }

        const order: BarOrder = {
          id: `bo${nextBarOrderId++}`,
          customerId: playerId,
          customerName: p.displayName,
          drinkId: drink.id,
          drinkName: drink.name,
          kind: drink.kind ?? 'drink',
          price: drink.price,
          tip,
          status: 'pending',
          createdAt: Date.now(),
        }
        barOrders.set(order.id, order)
        sendTo(playerId, {
          type: 'gameplayEvent',
          event: {
            kind: 'barOrderQueued',
            actorId: playerId,
            displayName: p.displayName,
            drinkId: drink.id,
            drinkName: drink.name,
            price: drink.price,
            tip,
            clubEnergy,
            roleSlots: roleSlotsSnapshot(),
            clublesBalance: p.clublesBalance,
            text: `${drink.name}: заказ отправлен бармену`,
          },
        })
        sendGameplayState(bartender)
      } else if (action === 'serveDrink') {
        if (p.role !== 'bartender') return
        const order = barOrders.get(String(msg.orderId || ''))
        if (!order || order.status !== 'pending') return
        const customer = players.get(order.customerId)
        if (!customer || customer.room !== 'club') {
          barOrders.delete(order.id)
          sendGameplayState(p)
          return
        }

        const total = order.price + order.tip
        if (customer.clublesBalance < total) {
          sendTo(p.id, {
            type: 'gameplayEvent',
            event: {
              kind: 'barPaymentFailed',
              clubEnergy,
              roleSlots: roleSlotsSnapshot(),
              text: `${order.customerName}: не хватает Клублей`,
            },
          })
          sendTo(customer.id, {
            type: 'gameplayEvent',
            event: {
              kind: 'notEnoughClubles',
              clublesBalance: customer.clublesBalance,
              clubEnergy,
              roleSlots: roleSlotsSnapshot(),
              text: `Не хватает Клублей на ${order.drinkName}`,
            },
          })
          return
        }

        const orderedItem = drinkById(order.drinkId)
        setPlayerClubles(customer, customer.clublesBalance - total)
        setPlayerClubles(p, p.clublesBalance + total)
        p.bartenderSales += order.price
        p.bartenderTips += order.tip
        order.status = 'served'
        barOrders.delete(order.id)
        addPlayerDrink(customer.id, orderedItem)
        setClubEnergy(clubEnergy + 0.055 + Math.min(0.05, order.price / 5000))

        sendGameplayState(customer)
        sendGameplayState(p)
        broadcastGameplayEvent({
          kind: 'drinkServed',
          actorId: customer.id,
          displayName: customer.displayName,
          drinkId: order.drinkId,
          drinkName: order.drinkName,
          price: order.price,
          tip: order.tip,
          clublesBalance: customer.clublesBalance,
          lockscreenMusicUntil: customer.lockscreenMusicUntil,
          text: `${p.displayName} подал ${order.drinkName} для ${customer.displayName}`,
        })
      } else if (action === 'drinkSip') {
        const drinkInstanceId = String(msg.drinkInstanceId || '')
        const requestedAmount = clamp(Number(msg.amount) || 0, MIN_DRINK_SIP_AMOUNT, 1)
        const drinks = drinksSnapshot(playerId)
        const drink = drinks.find(item => item.id === drinkInstanceId)
        if (!drink) return

        const consumed = clamp(Math.min(drink.remaining, requestedAmount), 0, 1)
        drink.remaining = Math.max(0, drink.remaining - consumed)
        drink.remaining = Math.round(drink.remaining * 1000) / 1000
        setPlayerDrinks(playerId, drinks)
        setClubEnergy(clubEnergy + 0.018 + consumed * 0.045)
        sendGameplayState(p)
        broadcastGameplayEvent({
          kind: 'drinkConsumed',
          actorId: p.id,
          displayName: p.displayName,
          drinkInstanceId: drink.id,
          drinkId: drink.drinkId,
          drinkName: drink.drinkName,
          drinkAmount: consumed,
          drinkRemaining: drink.remaining,
          drinkEffectDurationMs: DRINK_EFFECT_DURATION_MS,
          text: `${p.displayName} пьёт ${drink.drinkName}`,
        })
      } else if (action === 'giftDrink') {
        const drinkInstanceId = String(msg.drinkInstanceId || '')
        const targetId = String(msg.targetId || '')
        if (!targetId || targetId === playerId) return
        const target = players.get(targetId)
        if (!target || target.room !== 'club') return
        if (target.floorLevel !== p.floorLevel) return
        if (Math.hypot(target.x - p.x, target.z - p.z) > DRINK_GIFT_DISTANCE) {
          sendTo(playerId, {
            type: 'gameplayEvent',
            event: {
              kind: 'drinkGiftTooFar',
              clubEnergy,
              roleSlots: roleSlotsSnapshot(),
              text: `${target.displayName} слишком далеко`,
            },
          })
          return
        }

        const drinks = drinksSnapshot(playerId)
        const index = drinks.findIndex(item => item.id === drinkInstanceId)
        if (index === -1) return
        const [drink] = drinks.splice(index, 1)
        drink.servedAt = Date.now()
        setPlayerDrinks(playerId, drinks)
        playerDrinks.set(targetId, [...drinksSnapshot(targetId), drink])

        sendGameplayState(p)
        sendGameplayState(target)
        broadcastGameplayEvent({
          kind: 'drinkGifted',
          actorId: p.id,
          targetId: target.id,
          displayName: p.displayName,
          drinkInstanceId: drink.id,
          drinkId: drink.drinkId,
          drinkName: drink.drinkName,
          drinkRemaining: drink.remaining,
          text: `${p.displayName} угощает ${target.displayName}: ${drink.drinkName}`,
        })
      } else if (action === 'cancelBarOrder') {
        if (p.role !== 'bartender') return
        const order = barOrders.get(String(msg.orderId || ''))
        if (!order || order.status !== 'pending') return
        barOrders.delete(order.id)
        sendTo(order.customerId, {
          type: 'gameplayEvent',
          event: {
            kind: 'barOrderCancelled',
            clubEnergy,
            roleSlots: roleSlotsSnapshot(),
            text: `${order.drinkName}: заказ отменён`,
          },
        })
        sendGameplayState(p)
      } else if (action === 'vipRequest') {
        const allowed = vipGuests.has(playerId) || p.role === 'vip' || p.role === 'owner' || p.role === 'admin' || p.role === 'guard' || playerDressScore(p) >= 0.56
        if (allowed) {
          vipGuests.add(playerId)
          persistedVipAccess.set(p.economyKey, true)
          persistPlayerState(p)
          sendTo(playerId, {
            type: 'gameplayEvent',
            event: {
              kind: 'vipGranted',
              actorId: playerId,
              displayName: p.displayName,
              vipAccess: true,
              clubEnergy,
              roleSlots: roleSlotsSnapshot(),
              text: 'VIP доступ открыт',
            },
          })
          broadcastGameplayEvent({
            kind: 'vipEntered',
            actorId: playerId,
            displayName: p.displayName,
            text: `${p.displayName} проходит в VIP`,
          }, playerId)
        } else {
          sendTo(playerId, {
            type: 'gameplayEvent',
            event: {
              kind: 'vipDenied',
              actorId: playerId,
              displayName: p.displayName,
              vipAccess: false,
              clubEnergy,
              roleSlots: roleSlotsSnapshot(),
              text: 'VIP отказ: нужен сильнее образ',
            },
          })
        }
      }
    } else if (msg.type === 'managementAction' && playerId) {
      const actor = players.get(playerId); if (!actor) return
      const action = String(msg.action || '') as ManagementAction
      const target = typeof msg.targetId === 'string' ? players.get(msg.targetId) : null

      if (action === 'warnPlayer') {
        if (!canUseSecurityPanel(actor) || !target || !canModerateTarget(actor, target)) return
        const text = `${actor.displayName}: предупреждение для ${target.displayName}`
        sendTo(target.id, {
          type: 'gameplayEvent',
          event: { kind: 'securityWarning', actorId: actor.id, targetId: target.id, displayName: actor.displayName, clubEnergy, roleSlots: roleSlotsSnapshot(), text },
        })
        broadcastGameplayEvent({ kind: 'securityWarning', actorId: actor.id, targetId: target.id, displayName: actor.displayName, text })
      } else if (action === 'escortOutside') {
        if (!canUseSecurityPanel(actor) || !target || !canModerateTarget(actor, target)) return
        forcePlayerOutside(target, 'security')
        broadcastGameplayEvent({
          kind: 'playerEscorted',
          actorId: actor.id,
          targetId: target.id,
          displayName: actor.displayName,
          text: `${actor.displayName} вывел ${target.displayName} наружу`,
        })
        broadcastManagementState()
      } else if (action === 'setPlayerRole') {
        if (!target) return
        const nextRole = VALID_ROLES.has(msg.role) ? msg.role as PlayerRole : null
        if (!nextRole || !canAssignManagedRole(actor, nextRole) || !canModerateTarget(actor, target)) return
        if (!roleIsAvailable(nextRole, target.id, target.userId)) {
          sendTo(actor.id, {
            type: 'gameplayEvent',
            event: { kind: 'roleDenied', clubEnergy, roleSlots: roleSlotsSnapshot(), text: 'Роль уже занята' },
          })
          return
        }
        assignPlayerRole(target.id, target, nextRole)
        broadcastGameplayEvent({
          kind: 'managedRoleChanged',
          actorId: actor.id,
          targetId: target.id,
          displayName: actor.displayName,
          role: nextRole,
          text: `${target.displayName}: ${nextRole}`,
        })
        broadcastManagementState()
      } else if (action === 'grantVip') {
        if (!canUseOwnerPanel(actor) || !target || !canModerateTarget(actor, target)) return
        vipGuests.add(target.id)
        persistedVipAccess.set(target.economyKey, true)
        persistPlayerState(target)
        sendGameplayState(target)
        broadcastGameplayEvent({
          kind: 'vipGranted',
          actorId: actor.id,
          targetId: target.id,
          displayName: actor.displayName,
          vipAccess: true,
          text: `${target.displayName}: VIP открыт`,
        })
        broadcastManagementState()
      } else if (action === 'revokeVip') {
        if (!canUseOwnerPanel(actor) || !target || !canModerateTarget(actor, target)) return
        if (target.role !== 'vip' && target.role !== 'owner' && target.role !== 'admin') {
          vipGuests.delete(target.id)
          persistedVipAccess.set(target.economyKey, false)
        }
        persistPlayerState(target)
        sendGameplayState(target)
        broadcastGameplayEvent({
          kind: 'vipRevoked',
          actorId: actor.id,
          targetId: target.id,
          displayName: actor.displayName,
          vipAccess: false,
          text: `${target.displayName}: VIP закрыт`,
        })
        broadcastManagementState()
      } else if (action === 'setClubEnergy') {
        if (!canUseOwnerPanel(actor)) return
        setClubEnergy(Number(msg.value))
        broadcastGameplayState()
        broadcastGameplayEvent({
          kind: 'clubEnergySet',
          actorId: actor.id,
          displayName: actor.displayName,
          text: `Энергия клуба: ${Math.round(clubEnergy * 100)}%`,
        })
      } else if (action === 'setDrinkPrice') {
        if (!canUseOwnerPanel(actor)) return
        const drink = DRINK_MENU.find(item => item.id === String(msg.drinkId || ''))
        if (!drink) return
        if (isLockscreenMusicService(drink)) return
        drink.price = clamp(Math.floor(Number(msg.price) || drink.price), 10, 10000)
        broadcastGameplayState()
        broadcastGameplayEvent({
          kind: 'drinkPriceChanged',
          actorId: actor.id,
          displayName: actor.displayName,
          drinkId: drink.id,
          drinkName: drink.name,
          price: drink.price,
          text: `${drink.name}: ${drink.price} КЛБ`,
        })
      }
    } else if (msg.type === 'musicTrackDuration') {
      const trackIdx = Number(msg.trackIdx)
      const duration = Number(msg.duration)
      if (
        Number.isInteger(trackIdx) &&
        trackIdx >= 0 &&
        trackIdx < musicTrackCount &&
        Number.isFinite(duration) &&
        duration > 5 &&
        duration < 60 * 60
      ) {
        musicDurationsSec.set(trackIdx, duration)
        maybeAdvanceMusicTrack()
        broadcastMusicSync()
      }
    } else if (msg.type === 'timePing') {
      const musicState = currentMusicState()
      ws.send(JSON.stringify({
        type:'timePong',
        clientSentAt: msg.clientSentAt,
        serverNow: musicState.serverNow,
        musicState,
      }))
    }
  })

  ws.on('close', () => {
    if (playerId) {
      const closedPlayerId = playerId
      const p = players.get(closedPlayerId)
      if (p) {
        cancelDisconnectedSessionCleanup(closedPlayerId)
        const timer = setTimeout(() => {
          disconnectedSessionTimers.delete(closedPlayerId)
          const stale = players.get(closedPlayerId)
          if (stale && stale.ws.readyState !== WebSocket.OPEN) removePlayerSession(stale)
        }, DISCONNECTED_SESSION_GRACE_MS)
        disconnectedSessionTimers.set(closedPlayerId, timer)
      }
    }
  })

  ws.on('error', () => {})
})

console.log(`Game server running on ws://localhost:${PORT} (${SERVER_PROTOCOL_VERSION}, persistence=${persistenceStatusLabel()})`)
