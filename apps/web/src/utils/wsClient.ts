// apps/web/src/utils/wsClient.ts

import { resolveRuntimeUrl } from '@/utils/runtimeUrls'

export const GAME_SERVER_STATUS_EVENT = 'game-server-status'
export const DJ_SCHEDULE_EVENT = 'dj-schedule'

export interface DjScheduleItem {
  userId: string
  playerId: string | null
  displayName: string
  djName: string
  slotStartAt: number
  slotEndAt: number
  online: boolean
  lastSeenAt: number
  claimedAt: number
  status?: 'performing' | 'online' | 'offline'
}

export interface GameServerStatus {
  connected: boolean
  currentRoom?: 'outside' | 'club'
  protocolVersion?: string
  role?: string
  musicTrackIdx?: number
  musicTrackCount?: number
  clublesBalance?: number
  activeEntitlements?: string[]
}

export interface MusicServerState {
  source: 'track'
  trackIdx: number
  trackCount: number
  trackName?: string
  startedAt: number
  serverNow: number
  bpm: number
  bpmSource?: 'audio' | 'pending' | 'fallback'
  bpmConfidence?: number
  beatStartedAt: number
  beatIntervalMs: number
  beatCount?: number
  phraseBeat?: number
  intensity: number
  rhythmIntensity: number
  kickIntensity: number
  onsetStrength: number
  clubEnergy?: number
}

let serverStatus: GameServerStatus = { connected: false, activeEntitlements: [] }

export function getGameServerStatus() {
  return serverStatus
}

function dispatchServerStatus(patch: Partial<GameServerStatus>) {
  serverStatus = {
    ...serverStatus,
    ...patch,
    activeEntitlements: patch.activeEntitlements ?? serverStatus.activeEntitlements ?? [],
  }
  window.dispatchEvent(new CustomEvent<GameServerStatus>(GAME_SERVER_STATUS_EVENT, { detail: serverStatus }))
}

export interface RemotePlayer {
  id: string
  displayName: string
  role?: string
  djName?: string
  topColor: string
  bottomColor: string
  hairColor: string
  skinTone: string
  faceTextureUrl: string
  bodyTextureUrl: string
  modelUrl: string
  x: number
  z: number
  floorLevel?: 'ground' | 'stairs' | 'vip'
  rotY?: number
  moving?: boolean
  musicDanceIntensity?: number
}

export interface DrinkMenuItem {
  id: string
  name: string
  price: number
  effect: 'focus' | 'bass' | 'spark' | 'chill' | 'service'
  kind?: 'drink' | 'service'
  durationMs?: number
}

export interface BarOrder {
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

export interface PlayerDrink {
  id: string
  drinkId: string
  drinkName: string
  effect: DrinkMenuItem['effect']
  remaining: number
  servedAt: number
}

export interface QueueEntry {
  id: string
  pos: number
  displayName: string
  topColor: string
  bottomColor: string
  hairColor: string
  skinTone: string
  faceTextureUrl: string
  bodyTextureUrl: string
  modelUrl: string
}

export interface ManagementPlayer {
  id: string
  displayName: string
  role: string
  room: 'outside' | 'club'
  x: number
  z: number
  floorLevel: 'ground' | 'stairs' | 'vip'
  inQueue: boolean
  queuePos: number
  insideClub: boolean
  vipAccess: boolean
  clublesBalance: number
  cooldownUntil: number
  topColor: string
  bottomColor: string
}

export interface GameplayEvent {
  kind: string
  actorId?: string
  displayName?: string
  role?: string
  drinkId?: string
  drinkName?: string
  price?: number
  tip?: number
  drinkInstanceId?: string
  drinkAmount?: number
  drinkRemaining?: number
  drinkEffectDurationMs?: number
  targetId?: string
  clublesBalance?: number
  lockscreenMusicUntil?: number
  text?: string
  clubEnergy?: number
  vipAccess?: boolean
  roleSlots?: Record<string, string | null>
}

export interface GameplayState {
  protocolVersion?: string
  room?: 'outside' | 'club'
  clubEnergy: number
  vipAccess: boolean
  roleSlots: Record<string, string | null>
  clublesBalance?: number
  lockscreenMusicUntil?: number
  activeEntitlements?: string[]
  musicTrackIdx?: number
  musicTrackCount?: number
  musicState?: MusicServerState
  djSchedule?: DjScheduleItem[]
  drinkMenu?: DrinkMenuItem[]
  drinks?: PlayerDrink[]
  barOrders?: BarOrder[]
  bartenderStats?: {
    sales: number
    tips: number
  }
  managementPlayers?: ManagementPlayer[]
}

interface Callbacks {
  onWelcome:        (myId: string, players: RemotePlayer[], myX?: number, myZ?: number, role?: string, queue?: QueueEntry[], cooldownUntil?: number, gameplay?: GameplayState, myFloorLevel?: RemotePlayer['floorLevel']) => void
  onPlayerJoined:   (player: RemotePlayer) => void
  onPlayerMoved:    (id: string, x: number, z: number, rotY: number, moving: boolean, musicDanceIntensity?: number, floorLevel?: RemotePlayer['floorLevel']) => void
  onSelfPosition?:  (x: number, z: number, rotY: number, moving: boolean, musicDanceIntensity?: number, floorLevel?: RemotePlayer['floorLevel']) => void
  onPlayerLeft:     (id: string) => void
  onQueueUpdate?:   (queue: QueueEntry[]) => void
  onQueueJoined?:   (pos: number) => void
  onQueueLeft?:     () => void
  onQueueDenied?:   (reason: string, cooldownUntil: number) => void
  onAdmitted?:      () => void
  onDenied?:        (reason: string, cooldownUntil: number) => void
  onRoleChanged?:   (role: string) => void
  onStaffEntryAdmitted?: (role: string) => void
  onStaffEntryDenied?: (reason: string, attemptsLeft: number, exhausted: boolean, x?: number, z?: number) => void
  onAvatarUpdated?: (id: string, faceUrl: string, bodyUrl: string, topColor: string, bottomColor: string, modelUrl?: string) => void
  onDisplayNameChanged?: (id: string, displayName: string) => void
  onDjNameChanged?: (id: string, djName: string) => void
  onGameplayState?: (state: GameplayState) => void
  onGameplayEvent?: (event: GameplayEvent) => void
  onForcedOutside?: (reason: string, x?: number, z?: number) => void
}

export function getGameServerUrl() {
  const configured = import.meta.env.VITE_COLYSEUS_URL as string | undefined
  if (configured) return resolveRuntimeUrl(configured, { httpProtocol: 'ws:', httpsProtocol: 'wss:' })

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.hostname}:2567`
}

function isMusicServerState(value: unknown): value is MusicServerState {
  const state = value as Partial<MusicServerState> | null
  return Boolean(
    state &&
    typeof state.trackIdx === 'number' &&
    typeof state.trackCount === 'number' &&
    typeof state.startedAt === 'number' &&
    typeof state.bpm === 'number' &&
    typeof state.beatStartedAt === 'number' &&
    typeof state.beatIntervalMs === 'number' &&
    typeof state.intensity === 'number' &&
    typeof state.rhythmIntensity === 'number' &&
    typeof state.kickIntensity === 'number' &&
    typeof state.onsetStrength === 'number'
  )
}

function dispatchMusicServerState(value: unknown, serverNow?: number, clientReceivedAt = Date.now()) {
  if (!isMusicServerState(value)) return
  const musicState: MusicServerState = {
    ...value,
    serverNow: typeof value.serverNow === 'number' && Number.isFinite(value.serverNow)
      ? value.serverNow
      : typeof serverNow === 'number' && Number.isFinite(serverNow)
        ? serverNow
        : Date.now(),
  }
  window.dispatchEvent(new CustomEvent('music-server-state', {
    detail: { musicState, serverNow: musicState.serverNow, clientReceivedAt }
  }))
}

function dispatchMusicSync(trackIdx: number, startedAt: number, serverNow?: number, clientReceivedAt = Date.now(), musicState?: unknown) {
  window.dispatchEvent(new CustomEvent('music-sync', {
    detail: { trackIdx, startedAt, serverNow, clientReceivedAt, musicState }
  }))
  dispatchMusicServerState(musicState, serverNow, clientReceivedAt)
}

function dispatchDjSchedule(schedule: DjScheduleItem[], serverNow = Date.now()) {
  window.dispatchEvent(new CustomEvent(DJ_SCHEDULE_EVENT, {
    detail: { schedule, serverNow }
  }))
}

class GameClient {
  private ws: WebSocket | null = null
  private callbacks: Callbacks | null = null
  private _myId: string | null = null

  constructor() {
    window.addEventListener('music-track-ended', (e: Event) => {
      const { trackIdx } = (e as CustomEvent).detail ?? {}
      if (typeof trackIdx === 'number') this._send({ type: 'musicEnded', trackIdx })
    })
    window.addEventListener('music-track-duration', (e: Event) => {
      const { trackIdx, duration } = (e as CustomEvent).detail ?? {}
      if (typeof trackIdx === 'number' && typeof duration === 'number') {
        this._send({ type: 'musicTrackDuration', trackIdx, duration })
      }
    })

    window.setInterval(() => this.sendTimePing(), 2_000)
  }

  get id() { return this._myId }

  setCallbacks(cb: Callbacks) { this.callbacks = cb }

  connect(url: string, payload: object): Promise<void> {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null }
    const requestedRoom = (payload as { room?: unknown }).room === 'club' ? 'club' : 'outside'
    dispatchServerStatus({ connected: false, currentRoom: requestedRoom })

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', ...payload }))
        this.sendTimePing()
        dispatchServerStatus({ connected: true, currentRoom: requestedRoom })
        resolve()
      }

      ws.onmessage = (e) => {
        const clientReceivedAt = Date.now()
        let msg: any
        try { msg = JSON.parse(e.data) } catch { return }
        const cb = this.callbacks
        if (!cb) return

        switch (msg.type) {
          case 'welcome':
            this._myId = msg.id
            dispatchServerStatus({
              connected: true,
              currentRoom: msg.room ?? requestedRoom,
              protocolVersion: msg.protocolVersion,
              role: msg.role,
              musicTrackIdx: msg.musicTrackIdx,
              musicTrackCount: msg.musicTrackCount,
            })
            if (typeof msg.musicTrackIdx === 'number') {
              dispatchMusicSync(msg.musicTrackIdx, msg.musicStartedAt, msg.musicServerNow, clientReceivedAt, msg.musicState)
            }
            cb.onWelcome(msg.id, msg.players, msg.myX ?? 0, msg.myZ ?? 6, msg.role, msg.queue, msg.cooldownUntil, msg.gameplay, msg.myFloorLevel)
            break
          case 'playerJoined':   cb.onPlayerJoined(msg.player); break
          case 'playerMoved':    cb.onPlayerMoved(msg.id, msg.x, msg.z, msg.rotY, msg.moving, msg.musicDanceIntensity, msg.floorLevel); break
          case 'selfPosition':    cb.onSelfPosition?.(msg.x, msg.z, msg.rotY, msg.moving, msg.musicDanceIntensity, msg.floorLevel); break
          case 'playerLeft':     cb.onPlayerLeft(msg.id); break
          case 'timePong':
            window.dispatchEvent(new CustomEvent('server-time', {
              detail: {
                clientSentAt: msg.clientSentAt,
                serverNow: msg.serverNow,
                clientReceivedAt,
              }
            }))
            break
          case 'queueUpdate':    cb.onQueueUpdate?.(msg.queue); break
          case 'queueJoined':    cb.onQueueJoined?.(msg.pos); break
          case 'queueLeft':      cb.onQueueLeft?.(); break
          case 'queueDenied':    cb.onQueueDenied?.(msg.reason, msg.cooldownUntil); break
          case 'admitted':       cb.onAdmitted?.(); break
          case 'denied':         cb.onDenied?.(msg.reason, msg.cooldownUntil); break
          case 'musicSync':
            dispatchServerStatus({
              protocolVersion: msg.protocolVersion,
              musicTrackIdx: msg.trackIdx,
              musicTrackCount: msg.trackCount,
            })
            dispatchMusicSync(msg.trackIdx, msg.startedAt, msg.serverNow, clientReceivedAt, msg.musicState)
            break
          case 'musicState':
            dispatchMusicServerState(msg.musicState, msg.serverNow, clientReceivedAt)
            break
          case 'djSchedule':
            dispatchDjSchedule(Array.isArray(msg.schedule) ? msg.schedule : [], msg.serverNow)
            break
          case 'roleChanged':
            dispatchServerStatus({ role: msg.role })
            cb.onRoleChanged?.(msg.role)
            break
          case 'staffEntryAdmitted': cb.onStaffEntryAdmitted?.(msg.role); break
          case 'staffEntryDenied': cb.onStaffEntryDenied?.(msg.reason, msg.attemptsLeft, Boolean(msg.exhausted), msg.x, msg.z); break
          case 'avatarUpdated':  cb.onAvatarUpdated?.(msg.id, msg.faceTextureUrl, msg.bodyTextureUrl, msg.topColor, msg.bottomColor, msg.modelUrl); break
          case 'displayNameChanged': cb.onDisplayNameChanged?.(msg.id, msg.displayName); break
          case 'djNameChanged': cb.onDjNameChanged?.(msg.id, msg.djName); break
          case 'gameplayState':  cb.onGameplayState?.({
            protocolVersion: msg.protocolVersion,
            room: msg.room,
            clubEnergy: msg.clubEnergy,
            vipAccess: Boolean(msg.vipAccess),
            roleSlots: msg.roleSlots ?? {},
            clublesBalance: msg.clublesBalance,
            lockscreenMusicUntil: msg.lockscreenMusicUntil,
            activeEntitlements: msg.activeEntitlements,
            musicTrackIdx: msg.musicTrackIdx,
            musicTrackCount: msg.musicTrackCount,
            musicState: msg.musicState,
            djSchedule: msg.djSchedule,
            drinkMenu: msg.drinkMenu,
            drinks: msg.drinks,
            barOrders: msg.barOrders,
            bartenderStats: msg.bartenderStats,
            managementPlayers: msg.managementPlayers,
          })
            dispatchServerStatus({
              connected: true,
              currentRoom: msg.room ?? requestedRoom,
              protocolVersion: msg.protocolVersion,
              clublesBalance: msg.clublesBalance,
              activeEntitlements: Array.isArray(msg.activeEntitlements) ? msg.activeEntitlements : undefined,
              musicTrackIdx: msg.musicTrackIdx,
              musicTrackCount: msg.musicTrackCount,
            })
            if (Array.isArray(msg.djSchedule)) dispatchDjSchedule(msg.djSchedule, Date.now())
            dispatchMusicServerState(msg.musicState, msg.musicState?.serverNow, clientReceivedAt)
            break
          case 'gameplayEvent':  cb.onGameplayEvent?.(msg.event); break
          case 'forcedOutside':  cb.onForcedOutside?.(msg.reason, msg.x, msg.z); break
        }
      }

      ws.onerror = (e) => {
        dispatchServerStatus({ connected: false })
        reject(e)
      }
      ws.onclose = () => {
        this._myId = null
        dispatchServerStatus({ connected: false })
      }
    })
  }

  move(x: number, z: number, rotY: number, moving: boolean, musicDanceIntensity?: number, floorLevel?: RemotePlayer['floorLevel']) {
    this._send({ type: 'move', x, z, rotY, moving, musicDanceIntensity, floorLevel })
  }

  sendAvatarUpdate(faceUrl: string, bodyUrl: string, topColor: string, bottomColor: string, modelUrl = '') {
    this._send({ type: 'avatarUpdate', faceTextureUrl: faceUrl, bodyTextureUrl: bodyUrl, topColor, bottomColor, modelUrl })
  }

  joinQueue()  { this._send({ type: 'joinQueue' }) }
  leaveQueue() { this._send({ type: 'leaveQueue' }) }

  approve(targetId: string)              { this._send({ type: 'approve', targetId }) }
  deny(targetId: string, reason: string) { this._send({ type: 'deny', targetId, reason }) }
  setRole(role: string)                  { this._send({ type: 'setRole', role }) }
  setDisplayName(displayName: string)     { this._send({ type: 'setDisplayName', displayName }) }
  setDjName(djName: string)               { this._send({ type: 'setDjName', djName }) }
  claimDjScheduleSlot()                   { this._send({ type: 'djScheduleClaim' }) }
  staffEntry(inviteRole: string, password: string) {
    this._send({ type: 'staffEntry', inviteRole, password })
  }
  gameplayAction(action: string, payload: object = {}) {
    this._send({ type: 'gameplayAction', action, ...payload })
  }
  managementAction(action: string, payload: object = {}) {
    this._send({ type: 'managementAction', action, ...payload })
  }

  disconnect() {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null }
    this._myId = null
    dispatchServerStatus({ connected: false })
  }

  private _send(data: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data))
  }

  private sendTimePing() {
    this._send({ type: 'timePing', clientSentAt: Date.now() })
  }
}

export const gameClient = new GameClient()
