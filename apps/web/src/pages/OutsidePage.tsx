import { useEffect, useRef, useState, useCallback } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { MUSIC_BPM_EVENT, MUSIC_OUTPUT_EVENT } from '@/components/MusicPlayer'
import AdminDebugOverlay from '@/components/AdminDebugOverlay'
import AppSettings, { SettingsButton, appText, useAppLanguage, type AppLanguage } from '@/components/AppSettings'
import VoiceChat, { MOVEMENT_INPUT_RESET_EVENT, PROXIMITY_VOICE_POSITIONS_EVENT, VOICE_LEVELS_EVENT, VOICE_TALKING_EVENT } from '@/components/VoiceChat'
import {
  compressCameraPhoto,
  generateNoAiAvatar,
  normalizeFacePhoto,
  normalizeFullBodyPhoto,
} from '@/avatar/noAiAvatarFactory'
import {
  generateBrowserTrellisAvatarFromPreparedImages,
  getTrellisAvatarGenerationStatus,
  prepareTrellisModelPhoto,
  resumeTrellisAvatarStream,
  type AvatarPipelineEvent,
  type AvatarPipelineStage,
} from '@/avatar/trellisPipeline'
import AvatarPreview3D from '@/components/AvatarPreview3D'
import { usePlayerStore } from '@/store/playerStore'
import { supabase } from '@/utils/supabase'
import { gameClient, getGameServerUrl } from '@/utils/wsClient'
import type { DrinkMenuItem, GameplayEvent, GameplayState, ManagementPlayer, QueueEntry, RemotePlayer } from '@/utils/wsClient'
import { loadGeneratedAvatarRig, type GeneratedAvatarRig } from '@/utils/generatedAvatarRig'
import { applyAvatarFacingRotation, getAvatarMovementRotationY } from '@/utils/avatarFacing'
import { AvatarMini } from '@/pages/BouncerPage'
import { ManagementPanel } from '@/pages/ClubPage'
import { DJBoothPanel } from '@/pages/DJPage'
import type { AvatarConfig, UserRole } from '@shared/types'
import * as THREE from 'three'

const VOICE_MOUTH_TEXTURE_URL = '/images/voice-mouth.png'
const DOORCLUB_ASSET_BASE = '/images/doorclub'
const CLUB_NAME = 'DOOR//CLUB'
const OUTSIDE_WALK_BOUNDS = { minX: -8, maxX: 8, minZ: -10, maxZ: 10 } as const
const OUTSIDE_GROUND_WIDTH = OUTSIDE_WALK_BOUNDS.maxX - OUTSIDE_WALK_BOUNDS.minX
const OUTSIDE_GROUND_DEPTH = OUTSIDE_WALK_BOUNDS.maxZ - OUTSIDE_WALK_BOUNDS.minZ
const OUTSIDE_GROUND_CENTER_Z = (OUTSIDE_WALK_BOUNDS.minZ + OUTSIDE_WALK_BOUNDS.maxZ) / 2
const OUTSIDE_BOUNDARY_THICKNESS = 0.8
const OUTSIDE_CAMERA_BOUNDS = { minX: -7.65, maxX: 7.65, minZ: -9.75, maxZ: 9.75, minY: 0.55, maxY: 8.8 } as const
type StaffInviteRole = 'dj' | 'facecontrol' | 'security' | 'barmen' | 'vip' | 'owner'
type ManagementTab = 'security' | 'owner' | 'admin'
const MANAGEMENT_PANEL_OPEN_KEY = 'doorclub-management-panel-open'
const MANAGEMENT_PANEL_TAB_KEY = 'doorclub-management-panel-tab'
const OUTSIDE_INTRO_SEEN_KEY = 'doorclub-outside-intro-seen'
const OUTSIDE_RETURNED_FROM_CLUB_KEY = 'doorclub-outside-returned-from-club'
const OUTFIT_COOLDOWN_STORAGE_KEY = 'outfitCooldown'
const OUTFIT_COOLDOWN_MS = 10 * 60 * 1000
const DEFAULT_DRINK_MENU: DrinkMenuItem[] = [
  { id: 'neon_spritz', name: 'Неон-спритц', price: 120, effect: 'spark' },
  { id: 'bass_tonic', name: 'Басс-тоник', price: 180, effect: 'bass' },
  { id: 'velvet_shot', name: 'Вельвет-шот', price: 240, effect: 'focus' },
  { id: 'ice_zero', name: 'Айс-зеро', price: 90, effect: 'chill' },
]
const STAFF_INVITE_ROLES: Array<{ id: StaffInviteRole; label: string }> = [
  { id: 'dj', label: 'DJ' },
  { id: 'facecontrol', label: 'FACECONTROL' },
  { id: 'security', label: 'SECURITY' },
  { id: 'barmen', label: 'BARMEN' },
  { id: 'vip', label: 'VIP' },
  { id: 'owner', label: 'OWNER' },
]
const STAFF_ERROR_LABELS: Record<string, { ru: string; en: string }> = {
  password: { ru: 'Неверный пароль приглашения', en: 'Invalid invite password' },
  attempts: { ru: 'Три неверные попытки. Возврат на стартовую точку', en: 'Three wrong attempts. Returning to the start point' },
  role: { ru: 'Неизвестная роль', en: 'Unknown role' },
  role_taken: { ru: 'Эта роль сейчас занята', en: 'This role is currently taken' },
}

function isFaceControlRole(role: string) {
  return role === 'bouncer' || role === 'owner' || role === 'admin'
}

function canUseSecurityPanelRole(role: string) {
  return role === 'guard' || role === 'bouncer' || role === 'owner' || role === 'admin'
}

function canUseOwnerPanelRole(role: string) {
  return role === 'owner' || role === 'admin'
}

function canUseAdminPanelRole(role: string) {
  return role === 'admin'
}

function readStoredManagementOpen() {
  return sessionStorage.getItem(MANAGEMENT_PANEL_OPEN_KEY) === '1'
}

function isManagementTab(value: string | null): value is ManagementTab {
  return value === 'security' || value === 'owner' || value === 'admin'
}

function readStoredManagementTab(): ManagementTab {
  const stored = sessionStorage.getItem(MANAGEMENT_PANEL_TAB_KEY)
  return isManagementTab(stored) ? stored : 'security'
}

function shouldShowOutsideIntro() {
  const returnedFromClub = sessionStorage.getItem(OUTSIDE_RETURNED_FROM_CLUB_KEY) === '1'
  if (returnedFromClub) {
    sessionStorage.removeItem(OUTSIDE_RETURNED_FROM_CLUB_KEY)
    return false
  }
  return sessionStorage.getItem(OUTSIDE_INTRO_SEEN_KEY) !== '1'
}

function readOutfitCooldownUntil() {
  const stored = Number(localStorage.getItem(OUTFIT_COOLDOWN_STORAGE_KEY) || 0)
  if (Number.isFinite(stored) && stored > Date.now()) return stored
  return 0
}

export default function OutsidePage() {
  const navigate  = useNavigate()
  const { language } = useAppLanguage()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const displayName = usePlayerStore((s) => s.displayName)
  const clublesBalance = usePlayerStore((s) => s.clublesBalance)
  const userId = usePlayerStore((s) => s.userId)

  const [playerCount,  setPlayerCount]  = useState(1)
  const [showOutfit,   setShowOutfit]   = useState(false)
  const [resumeOutfitGeneration, setResumeOutfitGeneration] = useState(false)

  const [queueState,    setQueueState]    = useState<'idle'|'waiting'|'cooldown'>('idle')
  const [queuePos,      setQueuePos]      = useState(0)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [cooldownSecs,  setCooldownSecs]  = useState(0)
  const [deniedReason,  setDeniedReason]  = useState('')
  const [myRole,        setMyRole]        = useState<string>(() => usePlayerStore.getState().role || 'guest')
  const [myPlayerId,    setMyPlayerId]    = useState<string | null>(null)
  const [clubEnergy, setClubEnergy] = useState(0.58)
  const [drinkMenu, setDrinkMenu] = useState<DrinkMenuItem[]>(DEFAULT_DRINK_MENU)
  const [managementPlayers, setManagementPlayers] = useState<ManagementPlayer[]>([])
  const [managementPanelOpen, setManagementPanelOpen] = useState(readStoredManagementOpen)
  const [managementTab, setManagementTab] = useState<ManagementTab>(readStoredManagementTab)
  const [showOutsideIntro, setShowOutsideIntro] = useState(shouldShowOutsideIntro)
  const [showOutsideHints, setShowOutsideHints] = useState(true)
  const [staffDoorOpen, setStaffDoorOpen] = useState(false)
  const [staffRole, setStaffRole] = useState<StaffInviteRole>('dj')
  const [staffPassword, setStaffPassword] = useState('')
  const [staffAttemptsLeft, setStaffAttemptsLeft] = useState(3)
  const [staffError, setStaffError] = useState('')
  const [queue, setQueue] = useState<QueueEntry[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [facePanelOpen, setFacePanelOpen] = useState(() => isFaceControlRole(usePlayerStore.getState().role || 'guest'))
  const [djPanelMinimized, setDjPanelMinimized] = useState(false)
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null)
  const [faceLog, setFaceLog] = useState<string[]>([])
  const staffDoorOpenRef = useRef(false)

  const [outfitCooldownUntil, setOutfitCooldownUntil] = useState<number>(readOutfitCooldownUntil)
  const [outfitCooldownSecs, setOutfitCooldownSecs] = useState(() => {
    const stored = Number(localStorage.getItem(OUTFIT_COOLDOWN_STORAGE_KEY) || 0)
    return Math.max(0, Math.ceil((stored - Date.now()) / 1000))
  })

  const spawnFn         = useRef<(p: RemotePlayer) => void>(() => {})
  const moveFn          = useRef<(id: string, x: number, z: number, rotY: number, moving: boolean, musicDanceIntensity?: number) => void>(() => {})
  const removeFn        = useRef<(id: string) => void>(() => {})
  const teleportFn      = useRef<(x: number, z: number) => void>(() => {})
  const selfPositionFn  = useRef<(x: number, z: number, rotY?: number, moving?: boolean) => void>(() => {})
  const updatePlayerRef = useRef<(faceUrl: string, bodyUrl: string, modelUrl: string) => void>(() => {})
  const updateRemoteRef = useRef<(id: string, faceUrl: string, bodyUrl: string, topColor: string, bottomColor: string, modelUrl?: string) => void>(() => {})
  const musicBpmRef = useRef(124)
  const musicBeatSyncRef = useRef<{ beatAtMs: number; beatIntervalSec: number; confidence: number } | null>(null)
  const musicOutputIntensityRef = useRef(0)
  const musicAudibleIntensityRef = useRef(0)
  const languageRef = useRef(language)
  const talkingRef = useRef(false)
  const voiceLevelRef = useRef(0)
  const remoteVoiceLevelsRef = useRef(new Map<string, number>())

  const applyQueue = useCallback((nextQueue: QueueEntry[]) => {
    setQueue(nextQueue)
    setSelectedQueueId((current) => current && nextQueue.some((entry) => entry.id === current) ? current : null)
  }, [])

  const applyGameplayState = useCallback((state: GameplayState) => {
    if (typeof state.clubEnergy === 'number') setClubEnergy(state.clubEnergy)
    if (typeof state.clublesBalance === 'number') {
      usePlayerStore.getState().setClublesBalance(state.clublesBalance)
    }
    if (typeof state.lockscreenMusicUntil === 'number') {
      usePlayerStore.getState().setLockscreenMusicUntil(state.lockscreenMusicUntil)
    }
    if (Array.isArray(state.drinkMenu) && state.drinkMenu.length) setDrinkMenu(state.drinkMenu)
    if (Array.isArray(state.managementPlayers)) setManagementPlayers(state.managementPlayers)
  }, [])

  const handleGameplayEvent = useCallback((event: GameplayEvent) => {
    if (typeof event.clubEnergy === 'number') setClubEnergy(event.clubEnergy)
    if (typeof event.clublesBalance === 'number') {
      usePlayerStore.getState().setClublesBalance(event.clublesBalance)
    }
    if (typeof event.lockscreenMusicUntil === 'number') {
      usePlayerStore.getState().setLockscreenMusicUntil(event.lockscreenMusicUntil)
    }
  }, [])

  useEffect(() => {
    languageRef.current = language
  }, [language])

  useEffect(() => {
    staffDoorOpenRef.current = staffDoorOpen
  }, [staffDoorOpen])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('music-environment', {
      detail: { environment: 'outside' }
    }))
  }, [])

  useEffect(() => {
    const onBpm = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {}
      const bpm = detail.bpm
      if (typeof bpm === 'number' && Number.isFinite(bpm)) {
        musicBpmRef.current = Math.max(60, Math.min(180, bpm))
      } else {
        musicBeatSyncRef.current = null
        return
      }

      const beatAtMs = detail.beatAtMs
      const beatIntervalSec = detail.beatIntervalSec
      const confidence = typeof detail.confidence === 'number' && Number.isFinite(detail.confidence)
        ? Math.max(0, Math.min(1, detail.confidence))
        : 0
      if (
        typeof beatAtMs === 'number' &&
        Number.isFinite(beatAtMs) &&
        typeof beatIntervalSec === 'number' &&
        Number.isFinite(beatIntervalSec) &&
        beatIntervalSec > 0
      ) {
        musicBeatSyncRef.current = { beatAtMs, beatIntervalSec, confidence }
      }
    }
    const onTalking = (event: Event) => {
      talkingRef.current = Boolean((event as CustomEvent).detail?.talking)
    }
    const onVoiceLevels = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {}
      const selfLevel = detail.self?.level
      if (typeof selfLevel === 'number' && Number.isFinite(selfLevel)) {
        voiceLevelRef.current = Math.max(0, Math.min(1, selfLevel))
        talkingRef.current = Boolean(detail.self?.talking) || selfLevel > 0.02
      }

      const nextLevels = new Map<string, number>()
      for (const player of detail.players ?? []) {
        if (typeof player?.id !== 'string') continue
        const level = typeof player.level === 'number' && Number.isFinite(player.level)
          ? Math.max(0, Math.min(1, player.level))
          : 0
        nextLevels.set(player.id, level)
      }
      remoteVoiceLevelsRef.current = nextLevels
    }
    const onMusicOutput = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {}
      const intensity = detail.intensity
      if (typeof intensity === 'number' && Number.isFinite(intensity)) {
        musicOutputIntensityRef.current = Math.max(0, Math.min(1, intensity))
      }
      const audibleIntensity = detail.audibleIntensity
      if (typeof audibleIntensity === 'number' && Number.isFinite(audibleIntensity)) {
        musicAudibleIntensityRef.current = Math.max(0, Math.min(1, audibleIntensity))
      } else {
        const heardVolume = detail.heardVolume
        if (typeof heardVolume === 'number' && Number.isFinite(heardVolume)) {
          musicAudibleIntensityRef.current = Math.max(0, Math.min(1, heardVolume))
        }
      }
    }
    window.addEventListener(MUSIC_BPM_EVENT, onBpm)
    window.addEventListener(MUSIC_OUTPUT_EVENT, onMusicOutput)
    window.addEventListener(VOICE_TALKING_EVENT, onTalking)
    window.addEventListener(VOICE_LEVELS_EVENT, onVoiceLevels)
    return () => {
      window.removeEventListener(MUSIC_BPM_EVENT, onBpm)
      window.removeEventListener(MUSIC_OUTPUT_EVENT, onMusicOutput)
      window.removeEventListener(VOICE_TALKING_EVENT, onTalking)
      window.removeEventListener(VOICE_LEVELS_EVENT, onVoiceLevels)
    }
  }, [])

  // ── QUEUE COOLDOWN TICKER ──────────────────────────────────────────────────
  useEffect(() => {
    if (!cooldownUntil) return
    const tick = () => {
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))
      setCooldownSecs(left)
      if (left === 0) { setQueueState('idle'); setCooldownUntil(0) }
    }
    tick(); const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [cooldownUntil])

  // ── OUTFIT COOLDOWN TICKER ─────────────────────────────────────────────────
  useEffect(() => {
    if (!outfitCooldownUntil) return
    const tick = () => {
      const left = Math.max(0, Math.ceil((outfitCooldownUntil - Date.now()) / 1000))
      setOutfitCooldownSecs(left)
      if (left === 0) {
        setOutfitCooldownUntil(0)
        localStorage.removeItem(OUTFIT_COOLDOWN_STORAGE_KEY)
      }
    }
    tick(); const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [outfitCooldownUntil])

  // ── THREE.JS SCENE ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    const store  = usePlayerStore.getState()

    if (store.userId && (!store.avatarConfig?.faceTextureUrl)) {
      supabase.from('avatars').select('config_json').eq('user_id', store.userId).single()
        .then(({ data }) => {
          if (data?.config_json) usePlayerStore.getState().setAvatarConfig(data.config_json as any)
        })
    }

    const config = store.avatarConfig
    if (!canvas) return

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x050503)
    scene.fog = new THREE.Fog(0x050503, 18, 48)
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 80)

    scene.add(new THREE.AmbientLight(0x19130d, 2.4))
    const dirLight = new THREE.DirectionalLight(0xd8c7a0, 1.8)
    dirLight.position.set(5, 12, 8); scene.add(dirLight)
    const entryLamp = new THREE.PointLight(0xd8b06f, 8, 13); entryLamp.position.set(0, 3.5, -9); scene.add(entryLamp)
    const greenServiceLight = new THREE.PointLight(0x0d5f2d, 3, 16); greenServiceLight.position.set(-7, 2, -2); scene.add(greenServiceLight)
    const amberBeacon = new THREE.PointLight(0xff6d1a, 0, 13); amberBeacon.position.set(7, 1.5, 2); scene.add(amberBeacon)

    function lmat(color: number, emissive = 0, emissiveIntensity = 0) {
      return new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity })
    }
    function box(w: number, h: number, d: number, x: number, y: number, z: number,
      m: THREE.Material, parent: THREE.Object3D = scene): THREE.Mesh {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
      mesh.position.set(x, y, z); parent.add(mesh); return mesh
    }

    const textureLoader = new THREE.TextureLoader()
    const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
    function doorclubTexture(file: string, repeatX = 1, repeatY = 1) {
      const texture = textureLoader.load(`${DOORCLUB_ASSET_BASE}/${file}`)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = maxAnisotropy
      if (repeatX !== 1 || repeatY !== 1) {
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping
        texture.repeat.set(repeatX, repeatY)
      }
      return texture
    }

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(OUTSIDE_GROUND_WIDTH, OUTSIDE_GROUND_DEPTH),
      new THREE.MeshLambertMaterial({
        color: 0xffffff,
        map: doorclubTexture('doorclub_concrete_lawn_paver_tile_2048.png', 1.8, 2.2),
        emissive: 0x080604,
        emissiveIntensity: 0.08,
      }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.z = OUTSIDE_GROUND_CENTER_Z
    scene.add(ground)
    const grid = new THREE.GridHelper(OUTSIDE_GROUND_WIDTH, 8, 0x1a1a2e, 0x1a1a2e)
    ;(grid.material as THREE.Material).opacity = 0.08
    ;(grid.material as THREE.Material).transparent = true
    grid.position.z = OUTSIDE_GROUND_CENTER_Z
    grid.scale.z = OUTSIDE_GROUND_DEPTH / OUTSIDE_GROUND_WIDTH
    scene.add(grid)

    const wallMat  = lmat(0x15130f)
    const metalMat = lmat(0x2f302b, 0x0e0c08, 0.22)
    const railPostMat = lmat(0x4b4b43, 0x17130a, 0.34)
    const railBarMat = lmat(0x75643e, 0x34250c, 0.46)
    const railBaseMat = lmat(0x2a251b, 0x100b07, 0.24)
    const voiceMouthTexture = new THREE.TextureLoader().load(VOICE_MOUTH_TEXTURE_URL)
    voiceMouthTexture.colorSpace = THREE.SRGBColorSpace
    voiceMouthTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())

    function boundaryRail(axis: 'x' | 'z', centerX: number, centerZ: number, length: number) {
      const postCount = Math.max(2, Math.ceil(length / 1.85))
      const step = length / postCount
      for (let i = 0; i <= postCount; i += 1) {
        const offset = -length / 2 + step * i
        const x = axis === 'x' ? centerX + offset : centerX
        const z = axis === 'z' ? centerZ + offset : centerZ
        box(0.18, 1.62, 0.18, x, 0.81, z, railPostMat)
        box(0.28, 0.1, 0.28, x, 1.67, z, railBarMat)
      }
      if (axis === 'x') {
        box(length, 0.22, 0.3, centerX, 0.11, centerZ, railBaseMat)
        box(length, 0.14, 0.14, centerX, 1.36, centerZ, railBarMat)
        box(length, 0.12, 0.12, centerX, 0.88, centerZ, railPostMat)
        box(length, 0.1, 0.1, centerX, 0.48, centerZ, railPostMat)
      } else {
        box(0.3, 0.22, length, centerX, 0.11, centerZ, railBaseMat)
        box(0.14, 0.14, length, centerX, 1.36, centerZ, railBarMat)
        box(0.12, 0.12, length, centerX, 0.88, centerZ, railPostMat)
        box(0.1, 0.1, length, centerX, 0.48, centerZ, railPostMat)
      }
    }

    box(18,10,0.8,   0, 5,-13, wallMat)
    boundaryRail('z', OUTSIDE_WALK_BOUNDS.minX - OUTSIDE_BOUNDARY_THICKNESS / 2, OUTSIDE_GROUND_CENTER_Z, OUTSIDE_GROUND_DEPTH)
    boundaryRail('z', OUTSIDE_WALK_BOUNDS.maxX + OUTSIDE_BOUNDARY_THICKNESS / 2, OUTSIDE_GROUND_CENTER_Z, OUTSIDE_GROUND_DEPTH)
    boundaryRail('x', 0, OUTSIDE_WALK_BOUNDS.maxZ + OUTSIDE_BOUNDARY_THICKNESS / 2, OUTSIDE_GROUND_WIDTH + OUTSIDE_BOUNDARY_THICKNESS * 2)
    box(18,0.4,2,    0,10,-12, metalMat)
    box(0.15,8,0.15,-8.5,4,-13,lmat(0x2e3924,0x162410,0.6)); box(0.15,8,0.15,8.5,4,-13,lmat(0x6d3a15,0x4a2109,0.65))

    {
      const facade = new THREE.Mesh(
        new THREE.PlaneGeometry(18.7, 10.52),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          map: doorclubTexture('doorclub_garden_facade_slash_entrance_2048x1152.png'),
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      )
      facade.position.set(0, 5.15, -12.38)
      scene.add(facade)
    }

    for(let i=0;i<6;i++){
      box(0.1,1.0,0.1,-2.8,0.5,-1+i*2,lmat(0xbbaa00,0x443300,0.3))
      box(0.1,1.0,0.1, 2.8,0.5,-1+i*2,lmat(0xbbaa00,0x443300,0.3))
      box(0.15,0.1,0.15,-2.8,1.05,-1+i*2,lmat(0xbbaa00,0x443300,0.3))
      box(0.15,0.1,0.15, 2.8,1.05,-1+i*2,lmat(0xbbaa00,0x443300,0.3))
      if(i<5){
        box(0.05,0.05,2,-2.8,0.85,i*2,lmat(0x886600,0x221100,0.2))
        box(0.05,0.05,2, 2.8,0.85,i*2,lmat(0x886600,0x221100,0.2))
      }
    }

    const toHex = (s: string|null|undefined, fb: number): number => {
      if (!s) return fb
      const rgb = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
      if (rgb) return (parseInt(rgb[1])<<16)|(parseInt(rgb[2])<<8)|parseInt(rgb[3])
      const n = parseInt(s.replace('#',''),16); return isNaN(n) ? fb : n
    }

    function makeNameTag(name: string): THREE.Mesh {
      const cv=document.createElement('canvas'); cv.width=256; cv.height=48
      const ctx=cv.getContext('2d')!
      ctx.clearRect(0,0,256,48); ctx.shadowColor='#d8b06f'; ctx.shadowBlur=7
      ctx.font='bold 20px monospace'; ctx.fillStyle='#d8d0c2'
      ctx.textAlign='center'; ctx.textBaseline='middle'
      ctx.fillText(name.slice(0,14),128,24)
      const m = new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(cv),transparent:true,side:THREE.DoubleSide,depthWrite:false})
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4,0.26),m)
      mesh.position.set(0,2.55,0)
      mesh.userData.isNameTag = true
      return mesh
    }

    function makeMouth(): THREE.Mesh {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.38, 0.205),
        new THREE.MeshBasicMaterial({
          map: voiceMouthTexture,
          transparent: true,
          opacity: 0,
          alphaTest: 0.02,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      )
      mesh.position.set(0, 1.78, 0.235)
      mesh.userData.isMouth = true
      return mesh
    }

    function applyFaceTex(group: THREE.Group, faceUrl: string) {
      if (!faceUrl) return
      const img = new Image()
      img.onload = () => {
        const cv=document.createElement('canvas'); cv.width=256; cv.height=256
        const ctx=cv.getContext('2d')!
        ctx.clearRect(0,0,256,256); ctx.save(); ctx.beginPath()
        ctx.ellipse(128,128,112,126,0,0,Math.PI*2); ctx.clip()
        ctx.drawImage(img,0,0,256,256); ctx.restore()
        const tex=new THREE.CanvasTexture(cv); tex.colorSpace=THREE.NoColorSpace
        const fp = new THREE.Mesh(
          new THREE.PlaneGeometry(0.38,0.43),
          new THREE.MeshBasicMaterial({map:tex,transparent:true,alphaTest:0.1,depthWrite:false})
        )
        fp.position.set(0,1.86,0.22)
        fp.userData.isFacePlane = true
        fp.visible = !group.userData.generatedModel
        group.add(fp)
      }
      img.src = faceUrl
    }

    function applyBodyTex(group: THREE.Group, bodyUrl: string) {
      if (!bodyUrl) return
      const applyZone = (zone: 'top'|'bottom') => {
        const img = new Image()
        img.onload = () => {
          const cv=document.createElement('canvas'); cv.width=128; cv.height=128
          const ctx=cv.getContext('2d')!
          const sx=img.width*(zone==='top'?0.36:0.38), sy=img.height*(zone==='top'?0.17:0.44)
          const sw=img.width*(zone==='top'?0.28:0.24), sh=img.height*(zone==='top'?0.32:0.40)
          ctx.drawImage(img,sx,sy,sw,sh,0,0,128,128)
          const tex=new THREE.CanvasTexture(cv); tex.colorSpace=THREE.NoColorSpace
          const m = new THREE.MeshBasicMaterial({map:tex})
          ;(zone==='top'?[0,3,4]:[7,8]).forEach(i => {
            const mesh = group.children[i] as THREE.Mesh
            if (mesh?.isMesh) mesh.material = m
          })
        }
        img.src = bodyUrl
      }
      applyZone('top'); applyZone('bottom')
    }

    function makeCharacter(bc: number, pc: number, sc: number, hc: number,
      x: number, z: number, parent: THREE.Object3D = scene): THREE.Group {
      const g = new THREE.Group(); g.position.set(x,0,z); parent.add(g)
      const skin=lmat(sc), body=lmat(bc), pants=lmat(pc), hair=lmat(hc), shoe=lmat(0x111111)
      box(0.55,0.75,0.3, 0,1.3,0, body, g)
      const hg=new THREE.SphereGeometry(0.21,8,6); hg.scale(0.95,1.1,0.9)
      const hm=new THREE.Mesh(hg,skin); hm.position.set(0,1.86,0); g.add(hm)
      const mouth = makeMouth(); g.add(mouth)
      const hrg=new THREE.SphereGeometry(0.215,7,4,0,Math.PI*2,0,Math.PI*0.52)
      const hrm=new THREE.Mesh(hrg,hair); hrm.position.set(0,1.99,-0.04); g.add(hrm)
      const armL=box(0.18,0.65,0.18,-0.37,1.25,0,body,g)
      const armR=box(0.18,0.65,0.18,0.37,1.25,0,body,g)
      box(0.16,0.18,0.16,-0.37,0.87,0,skin,g); box(0.16,0.18,0.16,0.37,0.87,0,skin,g)
      const legL=box(0.23,0.75,0.23,-0.15,0.6,0,pants,g)
      const legR=box(0.23,0.75,0.23, 0.15,0.6,0,pants,g)
      box(0.24,0.16,0.3,-0.15,0.16,0.04,shoe,g); box(0.24,0.16,0.3,0.15,0.16,0.04,shoe,g)
      ;(g as any)._armL=armL; (g as any)._armR=armR; (g as any)._legL=legL; (g as any)._legR=legR; (g as any)._head=hm; (g as any)._mouth=mouth
      return g
    }

    function forceGeneratedAvatarVisible(root: THREE.Object3D) {
      root.visible = true
      root.traverse((obj) => {
        obj.visible = true
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        materials.forEach((material) => {
          if (!material || material.name === 'Doorclub_Seam_Bridge') return
          material.visible = true
          material.transparent = false
          material.opacity = 1
          material.alphaTest = 0
          material.colorWrite = true
          material.depthTest = true
          material.depthWrite = true
          material.needsUpdate = true
        })
      })
    }

    function disposeObjectTree(root: THREE.Object3D) {
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry?.dispose()
        const material = mesh.material
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else material?.dispose()
      })
    }

    function hasVisibleGeneratedMaterial(mesh: THREE.Mesh) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      return materials.some((material) => (
        material &&
        material.visible !== false &&
        material.opacity > 0 &&
        material.colorWrite !== false
      ))
    }

    function measureGeneratedVisualPivot(root: THREE.Object3D, visualRoot: THREE.Object3D) {
      root.updateWorldMatrix(true, true)
      visualRoot.updateWorldMatrix(true, true)
      const box = new THREE.Box3()
      const meshBox = new THREE.Box3()
      const center = new THREE.Vector3()
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        const geometry = mesh.isMesh ? mesh.geometry as THREE.BufferGeometry | undefined : undefined
        if (!geometry || !mesh.visible || !hasVisibleGeneratedMaterial(mesh)) return
        if (!geometry.boundingBox) geometry.computeBoundingBox()
        if (!geometry.boundingBox) return
        meshBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
        box.union(meshBox)
      })
      if (box.isEmpty()) box.setFromObject(root)
      box.getCenter(center)
      return visualRoot.worldToLocal(center)
    }

    function clearGeneratedAvatarModel(group: THREE.Group) {
      const previousModel = group.userData.generatedModel as THREE.Object3D | undefined
      if (previousModel?.parent === group) {
        group.remove(previousModel)
        disposeObjectTree(previousModel)
      }
      delete group.userData.generatedRig
      delete group.userData.generatedModel
      delete group.userData.generatedVisualRoot
      delete group.userData.generatedModelUrl
      delete group.userData.pendingGeneratedModelUrl
      group.children.forEach((child) => {
        if (!child.userData.isGeneratedVisualRoot) child.visible = true
      })
      applyAvatarFacingRotation(group, getAvatarMovementRotationY(group))
    }

    function loadGeneratedAvatarModel(group: THREE.Group, modelUrl: string) {
      if (group.userData.generatedModelUrl === modelUrl || group.userData.pendingGeneratedModelUrl === modelUrl) return
      group.userData.pendingGeneratedModelUrl = modelUrl
      void loadGeneratedAvatarRig(modelUrl, { rotationY: Math.PI, targetHeight: 2.15 })
        .then((rig) => {
          if (group.userData.pendingGeneratedModelUrl !== modelUrl) return
          const previousModel = group.userData.generatedModel as THREE.Object3D | undefined
          if (previousModel?.parent === group) {
            group.remove(previousModel)
            disposeObjectTree(previousModel)
          }
          forceGeneratedAvatarVisible(rig.root)
          group.children.forEach((child) => {
            if (!child.userData.isNameTag && !child.userData.isMouth && !child.userData.isGeneratedVisualRoot) child.visible = false
          })

          const visualRoot = new THREE.Group()
          visualRoot.userData.isGeneratedVisualRoot = true
          visualRoot.rotation.set(0, 0, 0)
          visualRoot.add(rig.root)
          const pivot = measureGeneratedVisualPivot(rig.root, visualRoot)
          visualRoot.userData.generatedVisualPivotX = pivot.x
          visualRoot.userData.generatedVisualPivotZ = pivot.z
          group.userData.generatedRig = rig
          group.userData.generatedModel = visualRoot
          group.userData.generatedVisualRoot = visualRoot
          group.userData.generatedModelUrl = modelUrl
          delete group.userData.pendingGeneratedModelUrl
          group.add(visualRoot)
          applyVisualStopTurn(group)
          applyAvatarFacingRotation(group, getAvatarMovementRotationY(group))
        })
        .catch((loadError) => {
          if (group.userData.pendingGeneratedModelUrl === modelUrl) delete group.userData.pendingGeneratedModelUrl
          console.warn('[Outside avatar] GLB load failed:', loadError)
        })
    }

    const guard1=makeCharacter(0x0a0a14,0x0a0a14,0x8b6346,0x111111,-1.8,-10)
    const guard2=makeCharacter(0x0a0a14,0x0a0a14,0x7a5c3a,0x222222, 1.8,-10)
    guard1.rotation.y=Math.PI; guard2.rotation.y=Math.PI

    const npcs = [
      {bc:0x331144,pc:0x111122,sc:0xb07040,hc:0x220011,x:-0.6,z:-1.5},
      {bc:0x112233,pc:0x0a1520,sc:0xd4a574,hc:0x1a0a00,x: 0.6,z:-3.5},
      {bc:0x221100,pc:0x1a1000,sc:0x8b6040,hc:0x111111,x:-0.6,z:-5.5},
      {bc:0x001122,pc:0x000a14,sc:0xc0907a,hc:0x441100,x: 0.6,z:-7.5},
    ].map(d => makeCharacter(d.bc,d.pc,d.sc,d.hc,d.x,d.z))

    const player = makeCharacter(
      toHex(config?.topColor,0x222244), toHex(config?.bottomColor,0x111133),
      toHex(config?.skinTone,0xc8956c), toHex(config?.hairColor,0x1a1008), 0, 6
    )
    applyAvatarFacingRotation(player, 0)
    ;[9,10].forEach(i => {
      const m = (player.children[i] as THREE.Mesh).material as THREE.MeshLambertMaterial
      m.color.setHex(toHex(config?.shoesColor,0x111111))
    })
    if (config?.faceTextureUrl) applyFaceTex(player, config.faceTextureUrl)
    if (config?.bodyTextureUrl) applyBodyTex(player, config.bodyTextureUrl)
    player.add(makeNameTag(store.displayName||'АНОНИМ'))
    if (config?.modelUrl) loadGeneratedAvatarModel(player, config.modelUrl)

    // ── Обновление своего аватара без перезапуска сцены ───────────────────
    updatePlayerRef.current = (faceUrl: string, bodyUrl: string, modelUrl: string) => {
      const toRemove = player.children.filter(c => (c as any).userData?.isFacePlane)
      toRemove.forEach(c => {
        const mesh = c as THREE.Mesh
        player.remove(mesh); mesh.geometry.dispose()
        if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose())
        else mesh.material.dispose()
      })
      ;[0,3,4,7,8].forEach(i => {
        const mesh = player.children[i] as THREE.Mesh
        if (mesh?.isMesh) {
          const cfg = usePlayerStore.getState().avatarConfig
          if (i === 0 || i === 3 || i === 4) mesh.material = lmat(toHex(cfg?.topColor, 0x222244))
          else mesh.material = lmat(toHex(cfg?.bottomColor, 0x111133))
        }
      })
      if (faceUrl) applyFaceTex(player, faceUrl)
      if (bodyUrl) applyBodyTex(player, bodyUrl)
      if (modelUrl) loadGeneratedAvatarModel(player, modelUrl)
      else clearGeneratedAvatarModel(player)
    }

    const remotePlayers = new Map<string,THREE.Group>()

    // ── Обновление аватара другого игрока ─────────────────────────────────
    updateRemoteRef.current = (id, faceUrl, bodyUrl, topColor, bottomColor, modelUrl) => {
      const rg = remotePlayers.get(id)
      if (!rg) return
      const toRemove = rg.children.filter(c => (c as any).userData?.isFacePlane)
      toRemove.forEach(c => {
        const m = c as THREE.Mesh; rg.remove(m); m.geometry.dispose()
        if (Array.isArray(m.material)) m.material.forEach(x => x.dispose())
        else m.material.dispose()
      })
      const tc = toHex(topColor, 0x222244), bc = toHex(bottomColor, 0x111133)
      ;[0,3,4].forEach(i => { const m = rg.children[i] as THREE.Mesh; if (m?.isMesh) m.material = lmat(tc) })
      ;[7,8].forEach(i => { const m = rg.children[i] as THREE.Mesh; if (m?.isMesh) m.material = lmat(bc) })
      if (faceUrl) applyFaceTex(rg, faceUrl)
      if (bodyUrl) applyBodyTex(rg, bodyUrl)
      if (typeof modelUrl === 'string') {
        if (modelUrl) loadGeneratedAvatarModel(rg, modelUrl)
        else clearGeneratedAvatarModel(rg)
      }
    }

    spawnFn.current = (p) => {
      if (remotePlayers.has(p.id)) return
      const rg = makeCharacter(toHex(p.topColor,0x222244),toHex(p.bottomColor,0x111133),toHex(p.skinTone,0xc8956c),toHex(p.hairColor,0x1a1008),p.x,p.z,scene)
      if (p.faceTextureUrl) applyFaceTex(rg,p.faceTextureUrl)
      if (p.bodyTextureUrl) applyBodyTex(rg,p.bodyTextureUrl)
      rg.add(makeNameTag(p.displayName))
      if (p.modelUrl) loadGeneratedAvatarModel(rg, p.modelUrl)
      applyAvatarFacingRotation(rg, p.rotY ?? 0)
      ;(rg as any)._tx=p.x; (rg as any)._tz=p.z; (rg as any)._rotY=p.rotY ?? 0; (rg as any)._moving=Boolean(p.moving); (rg as any)._phase=Math.random()*Math.PI*2
      ;(rg as any)._musicDanceIntensity=Math.max(0, Math.min(1, p.musicDanceIntensity ?? 0))
      setVisualStopTurn(rg, false)
      remotePlayers.set(p.id,rg)
    }
    moveFn.current = (id,x,z,rotY,moving,musicDanceIntensity) => {
      const rg=remotePlayers.get(id); if(!rg) return
      const wasRemoteMoving = Boolean((rg as any)._moving)
      ;(rg as any)._tx=x; (rg as any)._tz=z; (rg as any)._rotY=rotY; (rg as any)._moving=moving
      if (moving) setVisualStopTurn(rg, false)
      else if (wasRemoteMoving) setVisualStopTurn(rg, true)
      if (typeof musicDanceIntensity === 'number' && Number.isFinite(musicDanceIntensity)) {
        ;(rg as any)._musicDanceIntensity=Math.max(0, Math.min(1, musicDanceIntensity))
      }
    }
    removeFn.current = (id) => {
      const rg=remotePlayers.get(id); if(rg){scene.remove(rg);remotePlayers.delete(id)}
    }
    teleportFn.current = (x,z) => {
      serverCorrection.active = false
      pos.x=x; pos.z=z; player.position.set(x,0,z)
      dispatchOutsideAudio(true)
    }
    selfPositionFn.current = (x,z,rotY,_moving = true) => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return
      if (typeof rotY === 'number' && Number.isFinite(rotY)) {
        lastMoveRotY = rotY
        applyAvatarFacingRotation(player, lastMoveRotY)
      }
      const distance = Math.hypot(x - pos.x, z - pos.z)
      if (distance > 0.8) {
        teleportFn.current(x, z)
        return
      }
      serverCorrection.active = true
      serverCorrection.x = x
      serverCorrection.z = z
    }

    const keys: Record<string,boolean> = {}
    const joystick = {x:0,z:0}
    const clearMovementInput = () => {
      Object.keys(keys).forEach(key => { keys[key] = false })
      joystick.x = 0
      joystick.z = 0
    }
    const isTextInputTarget = (target: EventTarget | null) => {
      return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
    }
    const onKD = (e: KeyboardEvent) => {
      if (staffDoorOpenRef.current || isTextInputTarget(e.target)) {
        clearMovementInput()
        return
      }
      keys[e.key.toLowerCase()]=true
    }
    const onKU = (e: KeyboardEvent) => { keys[e.key.toLowerCase()]=false }
    window.addEventListener('keydown',onKD); window.addEventListener('keyup',onKU)
    ;(window as any).__setJoy = (x:number,z:number) => {
      if (staffDoorOpenRef.current) {
        clearMovementInput()
        return
      }
      joystick.x=x
      joystick.z=z
    }
    const cam = {yaw:0,pitch:0.25,dist:7}
    const setCameraDistance = (dist: number) => {
      cam.dist = Math.max(3.2, Math.min(9.6, dist))
    }
    let rmb=false,lmx=0,lmy=0
    canvas.addEventListener('mousedown',e=>{if(e.button===2){rmb=true;lmx=e.clientX;lmy=e.clientY}})
    canvas.addEventListener('mousemove',e=>{if(!rmb)return;cam.yaw-=(e.clientX-lmx)*0.005;cam.pitch=Math.max(-0.08,Math.min(1.18,cam.pitch-(e.clientY-lmy)*0.004));lmx=e.clientX;lmy=e.clientY})
    canvas.addEventListener('mouseup',()=>{rmb=false})
    canvas.addEventListener('wheel',e=>{e.preventDefault();setCameraDistance(cam.dist+e.deltaY*0.006)},{passive:false})
    canvas.addEventListener('contextmenu',e=>e.preventDefault())
    let tl: {id:number;x:number;y:number}|null = null
    let pinch: {distance:number;camDist:number}|null = null
    const touchDistance = (touches: TouchList) => {
      const a = touches[0], b = touches[1]
      return Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)
    }
    canvas.addEventListener('touchstart',e=>{
      if(e.touches.length>=2){pinch={distance:touchDistance(e.touches),camDist:cam.dist};tl=null;return}
      for(const t of Array.from(e.changedTouches))if(t.clientX>window.innerWidth*0.4&&!tl)tl={id:t.identifier,x:t.clientX,y:t.clientY}
    },{passive:true})
    canvas.addEventListener('touchmove',e=>{
      if(e.touches.length>=2&&pinch){e.preventDefault();setCameraDistance(pinch.camDist*(pinch.distance/Math.max(1,touchDistance(e.touches))));return}
      if(!tl)return;for(const t of Array.from(e.changedTouches))if(t.identifier===tl.id){cam.yaw-=(t.clientX-tl.x)*0.005;cam.pitch=Math.max(-0.08,Math.min(1.18,cam.pitch-(t.clientY-tl.y)*0.004));tl.x=t.clientX;tl.y=t.clientY}
    },{passive:false})
    canvas.addEventListener('touchend',e=>{if(e.touches.length<2)pinch=null;if(!tl)return;for(const t of Array.from(e.changedTouches))if(tl&&t.identifier===tl.id)tl=null},{passive:true})
    const resetTransientInput = () => {
      clearMovementInput()
      rmb = false
      tl = null
      pinch = null
    }
    const resetTransientInputOnHidden = () => {
      if (document.visibilityState !== 'visible') resetTransientInput()
    }
    window.addEventListener(MOVEMENT_INPUT_RESET_EVENT, resetTransientInput)
    window.addEventListener('blur', resetTransientInput)
    document.addEventListener('visibilitychange', resetTransientInputOnHidden)

    const pos = new THREE.Vector3(0,0,6)
    const serverCorrection = { active: false, x: pos.x, z: pos.z }
    const STAFF_DOOR_X = -5.95
    const STAFF_DOOR_Z = -10.05
    const STAFF_DOOR_DISTANCE = 1.65
    let staffDoorWasNear = false
    const SPEED=4.5, RADIUS=0.93, COLLISION_EPS=0.001, COLLISION_PUSH=0.015
    let walkT=0, moveRamp=0, neonT=0, bouncerT=0, sendT=0, audioT=0, voiceT=0, musicPhase=0, lastMoveRotY=0
    let wasMoving = false
    const clock = new THREE.Clock(); let animId: number

    function doorProximityAt(x: number, z: number) {
      const doorX = 0
      const doorZ = -10
      const near = 1.2
      const far = 15
      const distance = Math.hypot(x - doorX, z - doorZ)
      const t = Math.max(0, Math.min(1, (far - distance) / (far - near)))
      return t * t * (3 - 2 * t)
    }

    function doorProximity() {
      return doorProximityAt(pos.x, pos.z)
    }

    function musicDanceIntensity(baseIntensity: number) {
      const heardMusic = Math.max(0, Math.min(1, musicOutputIntensityRef.current))
      const audibleMusic = Math.max(0, Math.min(1, musicAudibleIntensityRef.current))
      return Math.max(0, Math.min(1, baseIntensity * Math.pow(heardMusic, 0.82) * audibleMusic))
    }

    function wrapPhase(value: number) {
      return Math.atan2(Math.sin(value), Math.cos(value))
    }

    function setVisualStopTurn(group: THREE.Group, enabled: boolean) {
      group.userData.visualStopTurnOffsetY = enabled ? Math.PI * 2 : 0
      applyVisualStopTurn(group)
    }

    function applyVisualStopTurn(group: THREE.Group) {
      const offset = typeof group.userData.visualStopTurnOffsetY === 'number'
        ? group.userData.visualStopTurnOffsetY
        : 0

      const visualRoot = group.userData.generatedVisualRoot as THREE.Object3D | undefined
      if (visualRoot) {
        const shouldCompensateTurn = Math.abs(Math.atan2(Math.sin(offset), Math.cos(offset))) > 0.001
        const pivotX = shouldCompensateTurn && typeof visualRoot.userData.generatedVisualPivotX === 'number'
          ? visualRoot.userData.generatedVisualPivotX
          : 0
        const pivotZ = shouldCompensateTurn && typeof visualRoot.userData.generatedVisualPivotZ === 'number'
          ? visualRoot.userData.generatedVisualPivotZ
          : 0
        const cos = Math.cos(offset)
        const sin = Math.sin(offset)
        const rotatedX = pivotX * cos + pivotZ * sin
        const rotatedZ = -pivotX * sin + pivotZ * cos
        visualRoot.rotation.y = offset
        visualRoot.position.x = -rotatedX
        visualRoot.position.y = 0
        visualRoot.position.z = -rotatedZ
        return
      }
      if (!offset) return
      const rig = group.userData.generatedRig as GeneratedAvatarRig | undefined
      const generated = group.userData.generatedModel as THREE.Object3D | undefined
      const target = rig?.root ?? generated
      if (!target) return
      target.rotation.y = wrapPhase(target.rotation.y + offset)
    }

    function applyServerCorrection(dt: number) {
      if (!serverCorrection.active) return
      const dx = serverCorrection.x - pos.x
      const dz = serverCorrection.z - pos.z
      const distance = Math.hypot(dx, dz)
      if (distance < 0.003) {
        serverCorrection.active = false
        pos.x = serverCorrection.x
        pos.z = serverCorrection.z
      } else {
        const alpha = Math.min(1, dt * 14)
        pos.x += dx * alpha
        pos.z += dz * alpha
      }
      player.position.set(pos.x, 0, pos.z)
    }

    let lastDoorProximity = -1
    function dispatchOutsideAudio(force = false) {
      const outsideDoorProximity = doorProximity()
      if (!force && Math.abs(outsideDoorProximity - lastDoorProximity) < 0.015) return
      lastDoorProximity = outsideDoorProximity
      window.dispatchEvent(new CustomEvent('music-environment', {
        detail: { environment: 'outside', outsideDoorProximity }
      }))
    }
    dispatchOutsideAudio(true)

    function animateGeneratedWalk(group: THREE.Group, t: number) {
      const rig = group.userData.generatedRig as GeneratedAvatarRig | undefined
      if (rig) {
        rig.walk(t)
      } else {
        const generated = group.userData.generatedModel as THREE.Object3D | undefined
        if (!generated) return
        generated.position.set(generated.userData.baseX ?? generated.position.x, (generated.userData.baseY ?? 0) + Math.abs(Math.sin(t)) * 0.035, generated.userData.baseZ ?? generated.position.z)
        generated.rotation.x = Math.sin(t) * 0.025
        generated.rotation.z = Math.sin(t + Math.PI) * 0.028
      }
      applyVisualStopTurn(group)
    }

    function animateIdleGroove(group: THREE.Group, t: number, phase = 0, intensity = 0.2) {
      const p = t + phase
      const amount = Math.max(0, Math.min(1, intensity))
      const rig = group.userData.generatedRig as GeneratedAvatarRig | undefined
      if (rig) {
        rig.idle(p, amount)
        applyVisualStopTurn(group)
        return
      }
      const legL = (group as any)._legL as THREE.Mesh | undefined
      const legR = (group as any)._legR as THREE.Mesh | undefined
      const armL = (group as any)._armL as THREE.Mesh | undefined
      const armR = (group as any)._armR as THREE.Mesh | undefined
      const head = (group as any)._head as THREE.Mesh | undefined
      if (legL) legL.position.set(-0.15, 0.6, 0)
      if (legR) legR.position.set(0.15, 0.6, 0)
      if (armL) {
        armL.position.set(-0.37, 1.25, 0)
        armL.rotation.set(Math.sin(p + Math.PI) * 0.08 * amount, 0, 0.08 * amount)
      }
      if (armR) {
        armR.position.set(0.37, 1.25, 0)
        armR.rotation.set(Math.sin(p) * 0.08 * amount, 0, -0.08 * amount)
      }
      if (head) head.rotation.set(Math.sin(p) * 0.035 * amount, 0, -Math.sin(p * 0.5) * 0.035 * amount)
      group.position.y = Math.max(0, Math.sin(p)) * 0.012 * amount
    }

    function animateTalking(group: THREE.Group, level: number, t: number) {
      const amount = Math.max(0, Math.min(1, level * 5))
      const talking = amount > 0.06
      const rig = group.userData.generatedRig as GeneratedAvatarRig | undefined
      rig?.talk(talking, t, amount)
      const mouth = (group as any)._mouth as THREE.Mesh | undefined
      if (!mouth) return
      const material = mouth.material as THREE.MeshBasicMaterial
      const openness = talking ? amount : 0
      const scale = 0.62 + openness * 0.95
      mouth.visible = openness > 0.01
      mouth.scale.setScalar(scale)
      material.opacity = Math.min(1, openness)
    }

    function animate() {
      animId = requestAnimationFrame(animate)
      const dt = Math.min(clock.getDelta(), 0.05)
      musicPhase += dt * (musicBpmRef.current / 60) * Math.PI * 2
      const beatSync = musicBeatSyncRef.current
      const nowMs = performance.now()
      if (beatSync && nowMs - beatSync.beatAtMs < 8_000) {
        const targetBeat = (nowMs - beatSync.beatAtMs) / (beatSync.beatIntervalSec * 1000)
        const targetPhase = targetBeat * Math.PI * 2
        const phaseError = wrapPhase(targetPhase - musicPhase)
        const lockStrength = Math.min(1, dt * (1.4 + beatSync.confidence * 3.2))
        musicPhase += phaseError * lockStrength
      }
      let dx=0, dz=0
      const fwd   = new THREE.Vector3(-Math.sin(cam.yaw),0,-Math.cos(cam.yaw))
      const right = new THREE.Vector3( Math.cos(cam.yaw),0,-Math.sin(cam.yaw))
      if (staffDoorOpenRef.current) {
        clearMovementInput()
      } else {
        if(keys['w']||keys['arrowup'])    { dx+=fwd.x;   dz+=fwd.z }
        if(keys['s']||keys['arrowdown'])  { dx-=fwd.x;   dz-=fwd.z }
        if(keys['a']||keys['arrowleft'])  { dx-=right.x; dz-=right.z }
        if(keys['d']||keys['arrowright']) { dx+=right.x; dz+=right.z }
        if(joystick.x||joystick.z) { dx+=fwd.x*(-joystick.z)+right.x*joystick.x; dz+=fwd.z*(-joystick.z)+right.z*joystick.x }
      }

      const hasMoveInput = Math.abs(dx)+Math.abs(dz) > 0.01
      let moving = false
      if (hasMoveInput) {
        setVisualStopTurn(player, false)
        const len = Math.sqrt(dx*dx+dz*dz)
        lastMoveRotY=Math.atan2(dx/len,dz/len)
        applyAvatarFacingRotation(player,lastMoveRotY)
          moveRamp=Math.min(1,moveRamp+dt*2.8)
          const strideSpeed=SPEED*moveRamp
          let nx=Math.max(OUTSIDE_WALK_BOUNDS.minX,Math.min(OUTSIDE_WALK_BOUNDS.maxX,  pos.x+(dx/len)*strideSpeed*dt))
          let nz=Math.max(OUTSIDE_WALK_BOUNDS.minZ,Math.min(OUTSIDE_WALK_BOUNDS.maxZ, pos.z+(dz/len)*strideSpeed*dt))
          remotePlayers.forEach(rg => {
            const ex=Number.isFinite((rg as any)._tx) ? (rg as any)._tx : rg.position.x
            const ez=Number.isFinite((rg as any)._tz) ? (rg as any)._tz : rg.position.z
            const ddx=nx-ex, ddz=nz-ez, dist=Math.sqrt(ddx*ddx+ddz*ddz)
            if(dist<RADIUS){
              const moveX=nx-pos.x, moveZ=nz-pos.z, moveDist=Math.sqrt(moveX*moveX+moveZ*moveZ)
              const nx2=dist>COLLISION_EPS ? ddx/dist : (moveDist>COLLISION_EPS ? moveX/moveDist : 1)
              const nz2=dist>COLLISION_EPS ? ddz/dist : (moveDist>COLLISION_EPS ? moveZ/moveDist : 0)
              const dot=moveX*nx2+moveZ*nz2
              if(dot<0){nx-=dot*nx2;nz-=dot*nz2}
              const ddx2=nx-ex, ddz2=nz-ez, dist2=Math.sqrt(ddx2*ddx2+ddz2*ddz2)
              if(dist2<RADIUS){
                const sx=dist2>COLLISION_EPS ? ddx2/dist2 : nx2
                const sz=dist2>COLLISION_EPS ? ddz2/dist2 : nz2
                const ov=RADIUS-dist2+COLLISION_PUSH
                nx+=sx*ov;nz+=sz*ov
              }
              nx=Math.max(OUTSIDE_WALK_BOUNDS.minX,Math.min(OUTSIDE_WALK_BOUNDS.maxX,nx)); nz=Math.max(OUTSIDE_WALK_BOUNDS.minZ,Math.min(OUTSIDE_WALK_BOUNDS.maxZ,nz))
            }
          })

          const moveX = nx - pos.x
          const moveZ = nz - pos.z
          if (Math.hypot(moveX, moveZ) > 0.0005) {
            moving = true
            pos.x=nx; pos.z=nz; player.position.set(pos.x,0,pos.z)
            walkT+=dt*9
            ;(player as any)._legL.position.z = Math.sin(walkT)*0.18
            ;(player as any)._legR.position.z = Math.sin(walkT+Math.PI)*0.18
            ;(player as any)._legL.position.y = 0.6+Math.abs(Math.sin(walkT))*0.04
            ;(player as any)._legR.position.y = 0.6+Math.abs(Math.sin(walkT+Math.PI))*0.04
            ;(player as any)._armL.rotation.x = Math.sin(walkT+Math.PI)*0.3
            ;(player as any)._armR.rotation.x = Math.sin(walkT)*0.3
            animateGeneratedWalk(player, walkT)
          }
      }
      if (wasMoving && !moving && !hasMoveInput) {
        setVisualStopTurn(player, true)
      }
      if (!hasMoveInput) {
        moveRamp=0
        walkT=0
        applyAvatarFacingRotation(player,lastMoveRotY)
        animateIdleGroove(player, musicPhase, 0, musicDanceIntensity(1))
      } else if (!moving) {
        moveRamp=0
        walkT=0
        animateIdleGroove(player, musicPhase, 0, musicDanceIntensity(0.55))
      }
      applyServerCorrection(dt)
      const nearStaffDoor = Math.hypot(pos.x - STAFF_DOOR_X, pos.z - STAFF_DOOR_Z) < STAFF_DOOR_DISTANCE
      if (nearStaffDoor && !staffDoorWasNear) {
        clearMovementInput()
        staffDoorOpenRef.current = true
        moving = false
        setStaffDoorOpen(true)
        setStaffError('')
      }
      staffDoorWasNear = nearStaffDoor
      animateTalking(player, voiceLevelRef.current, musicPhase)

      player.children.forEach(c => { if(c instanceof THREE.Mesh&&c.position.y>2.4) c.rotation.y=cam.yaw-player.rotation.y })
      const cx=pos.x+cam.dist*Math.sin(cam.yaw)*Math.cos(cam.pitch)
      const cy=1.8+cam.dist*Math.sin(cam.pitch)
      const cz=pos.z+cam.dist*Math.cos(cam.yaw)*Math.cos(cam.pitch)
      const boundedCamera = new THREE.Vector3(
        Math.max(OUTSIDE_CAMERA_BOUNDS.minX, Math.min(OUTSIDE_CAMERA_BOUNDS.maxX, cx)),
        Math.max(OUTSIDE_CAMERA_BOUNDS.minY, Math.min(OUTSIDE_CAMERA_BOUNDS.maxY, cy)),
        Math.max(OUTSIDE_CAMERA_BOUNDS.minZ, Math.min(OUTSIDE_CAMERA_BOUNDS.maxZ, cz)),
      )
      camera.position.lerp(boundedCamera,0.12)
      camera.lookAt(pos.x,1.4,pos.z)

      sendT+=dt; if(sendT>0.05){sendT=0;gameClient.move(pos.x,pos.z,lastMoveRotY,moving,musicDanceIntensity(1))}
      audioT+=dt; if(audioT>0.08){audioT=0;dispatchOutsideAudio()}
      wasMoving = moving

      remotePlayers.forEach((rg, id) => {
        const voiceLevel = remoteVoiceLevelsRef.current.get(id) ?? 0
        const targetX = (rg as any)._tx
        const targetZ = (rg as any)._tz
        const toTargetX = targetX - rg.position.x
        const toTargetZ = targetZ - rg.position.z
        rg.position.x += toTargetX*0.2
        rg.position.z += toTargetZ*0.2
        const t=Date.now()*0.001
        if((rg as any)._moving){
          const targetRotY = Math.hypot(toTargetX, toTargetZ) > 0.001 ? Math.atan2(toTargetX, toTargetZ) : ((rg as any)._rotY ?? getAvatarMovementRotationY(rg))
          ;(rg as any)._rotY = targetRotY
          applyAvatarFacingRotation(rg, targetRotY)
          ;(rg as any)._legL.position.z=Math.sin(t*9)*0.18
          ;(rg as any)._legR.position.z=Math.sin(t*9+Math.PI)*0.18
          ;(rg as any)._armL.rotation.x=Math.sin(t*9+Math.PI)*0.3
          ;(rg as any)._armR.rotation.x=Math.sin(t*9)*0.3
          animateGeneratedWalk(rg, t * 9)
        } else {
          applyAvatarFacingRotation(rg, (rg as any)._rotY ?? getAvatarMovementRotationY(rg))
          const remoteMusicDance = Math.max(0, Math.min(1, (rg as any)._musicDanceIntensity ?? 0))
          animateIdleGroove(rg, musicPhase, (rg as any)._phase ?? 0, remoteMusicDance * 0.85)
        }
        animateTalking(rg, voiceLevel, musicPhase)
        rg.children.forEach(c => { if(c instanceof THREE.Mesh&&c.position.y>2.4) c.rotation.y=cam.yaw-rg.rotation.y })
      })

      voiceT+=dt; if(voiceT>0.1){voiceT=0;window.dispatchEvent(new CustomEvent(PROXIMITY_VOICE_POSITIONS_EVENT,{detail:{
        self:{x:pos.x,z:pos.z,y:0,floorLevel:'ground'},
        players:Array.from(remotePlayers,([id,rg])=>({id,x:rg.position.x,z:rg.position.z,y:0,floorLevel:'ground'})),
      }}))}

      npcs.forEach((npc,i) => {
        const t=Date.now()*0.001+i*1.3
        ;(npc as any)._legL.position.z=Math.sin(t*0.8)*0.04
        ;(npc as any)._legR.position.z=Math.sin(t*0.8+Math.PI)*0.04
      })
      bouncerT+=dt; guard1.position.y=Math.sin(bouncerT*0.8)*0.01; guard2.position.y=Math.sin(bouncerT*0.8+1)*0.01
      neonT+=dt
      const outsideBeat = musicPhase / (Math.PI * 2)
      const outsideMusic = Math.max(0, Math.min(1, musicOutputIntensityRef.current))
      const amberHit = Math.max(0, 1 - Math.abs((outsideBeat % 4) - 0) / 0.12)
      entryLamp.intensity = 5.6 + outsideMusic * 3.2 + Math.sin(neonT * 1.3) * 0.35
      amberBeacon.intensity = Math.pow(amberHit, 2.1) * (7 + outsideMusic * 7) + (Math.random() > 0.992 ? 4 : 0)
      greenServiceLight.intensity = 2.2 + Math.max(0, Math.sin(outsideBeat * Math.PI * 0.5 + 1.4)) * 2.4
      renderer.render(scene,camera)
    }
    animate()

    const onResize = () => { camera.aspect=window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth,window.innerHeight) }
    window.addEventListener('resize',onResize)
    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('keydown',onKD)
      window.removeEventListener('keyup',onKU)
      window.removeEventListener('resize',onResize)
      window.removeEventListener(MOVEMENT_INPUT_RESET_EVENT, resetTransientInput)
      window.removeEventListener('blur', resetTransientInput)
      document.removeEventListener('visibilitychange', resetTransientInputOnHidden)
      voiceMouthTexture.dispose()
      renderer.dispose()
    }
  }, [])

  // ── MULTIPLAYER ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    gameClient.setCallbacks({
      onWelcome: (id,players,myX,myZ,role,q,cooldown,gameplay,_myFloorLevel,resumed) => {
        setMyPlayerId(id)
        if(!resumed&&myX!==undefined&&myZ!==undefined) teleportFn.current(myX,myZ)
        players.forEach(p=>spawnFn.current(p))
        setPlayerCount(players.length+1)
        if(role) {
          setMyRole(role)
          usePlayerStore.getState().setRole(role as UserRole)
        }
        if(q) applyQueue(q)
        if(cooldown&&cooldown>Date.now()){ setQueueState('cooldown'); setCooldownUntil(cooldown) }
        if(gameplay) applyGameplayState(gameplay)
      },
      onPlayerJoined: p  => { spawnFn.current(p); setPlayerCount(c=>c+1) },
      onPlayerMoved:  (id,x,z,rotY,moving,musicDanceIntensity) => moveFn.current(id,x,z,rotY,moving,musicDanceIntensity),
      onSelfPosition: (x,z,rotY,moving) => selfPositionFn.current(x,z,rotY,moving),
      onPlayerLeft:   id => { removeFn.current(id); setPlayerCount(c=>Math.max(1,c-1)) },
      onQueueJoined:  pos => { setQueueState('waiting'); setQueuePos(pos) },
      onQueueLeft:    ()  => setQueueState('idle'),
      onQueueDenied:  (_,cu) => { setQueueState('cooldown'); setCooldownUntil(cu) },
      onQueueUpdate:  q => applyQueue(q),
      onAdmitted:     (role)  => {
        if (role) {
          setMyRole(role)
          usePlayerStore.getState().setRole(role as UserRole)
        }
        usePlayerStore.getState().setStatus('inside')
        sessionStorage.setItem('doorclub-admitted', '1')
        navigate('/club')
      },
      onAvatarUpdated: (id, faceUrl, bodyUrl, topColor, bottomColor, modelUrl) => {
        updateRemoteRef.current(id, faceUrl, bodyUrl, topColor, bottomColor, modelUrl)
      },
      onDenied:       (reason,cu) => { setDeniedReason(reason); setQueueState('cooldown'); setCooldownUntil(cu) },
      onRoleChanged:  role => {
        setMyRole(role)
        usePlayerStore.getState().setRole(role as UserRole)
      },
      onDjNameChanged: (_id, djName) => {
        usePlayerStore.getState().setDjName(djName)
      },
      onGameplayState: (state) => applyGameplayState(state),
      onGameplayEvent: (event) => handleGameplayEvent(event),
      onStaffEntryAdmitted: (role) => {
        usePlayerStore.getState().setRole(role as UserRole)
        usePlayerStore.getState().setStatus('inside')
        setMyRole(role)
        staffDoorOpenRef.current = false
        setStaffDoorOpen(false)
        setStaffPassword('')
        setStaffAttemptsLeft(3)
        setStaffError('')
        sessionStorage.setItem('doorclub-admitted', '1')
        navigate('/club')
      },
      onStaffEntryDenied: (reason, attemptsLeft, exhausted, x, z) => {
        setStaffAttemptsLeft(exhausted ? 3 : attemptsLeft)
        setStaffPassword('')
        const label = STAFF_ERROR_LABELS[reason]
        const currentLanguage = languageRef.current
        setStaffError(label ? appText(currentLanguage, label.ru, label.en) : appText(currentLanguage, 'Доступ отклонён', 'Access denied'))
        if (exhausted) {
          staffDoorOpenRef.current = false
          setStaffDoorOpen(false)
          teleportFn.current(
            typeof x === 'number' && Number.isFinite(x) ? x : 0,
            typeof z === 'number' && Number.isFinite(z) ? z : 6,
          )
        }
      },
    })

    const connect = async () => {
      const store = usePlayerStore.getState()
      let config = store.avatarConfig

      if (store.userId && (!config?.faceTextureUrl || !config?.bodyTextureUrl)) {
        const { data } = await supabase.from('avatars').select('config_json').eq('user_id', store.userId).single()
        if (cancelled) return
        if (data?.config_json) {
          config = data.config_json as any
          usePlayerStore.getState().setAvatarConfig(config as any)
        }
      }

      if (cancelled) return
      gameClient.connect(getGameServerUrl(), {
        room:           'outside',
        userId:         store.userId ?? '',
        email:          store.accountEmail ?? '',
        displayName:    store.displayName,
        role:           store.role,
        topColor:       config?.topColor       ?? '#222244',
        bottomColor:    config?.bottomColor    ?? '#111133',
        hairColor:      config?.hairColor      ?? '#1a1008',
        skinTone:       config?.skinTone       ?? '#c8956c',
        faceTextureUrl: config?.faceTextureUrl ?? '',
        bodyTextureUrl: config?.bodyTextureUrl ?? '',
        modelUrl:       config?.modelUrl       ?? '',
        djName:         store.djName || store.displayName || 'DJ',
      }).catch(e=>console.warn('WS offline:',e.message))
    }

    connect()
    return () => { cancelled = true; setMyPlayerId(null); gameClient.disconnect() }
  }, [navigate, applyQueue, applyGameplayState, handleGameplayEvent])

  const handleQueueBtn = () => {
    if (queueState==='waiting') { gameClient.leaveQueue(); return }
    if (queueState==='cooldown') return
    gameClient.joinQueue()
  }
  const handleStaffSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const password = staffPassword.trim()
    if (!password) {
      setStaffError(appText(language, 'Введите пароль приглашения', 'Enter invite password'))
      return
    }
    setStaffError('')
    gameClient.staffEntry(staffRole, password)
  }
  const queueLabel = () => {
    if (queueState==='waiting') return appText(language, `В ОЧЕРЕДИ #${queuePos}`, `IN QUEUE #${queuePos}`)
    if (queueState==='cooldown') return appText(language, `КУЛДАУН ${fmtSecs(cooldownSecs)}`, `COOLDOWN ${fmtSecs(cooldownSecs)}`)
    return appText(language, 'ВСТАТЬ\nВ ОЧЕРЕДЬ', 'JOIN\nQUEUE')
  }
  const outfitOnCooldown = outfitCooldownUntil > Date.now()
  const closeOutsideHints = useCallback(() => {
    setShowOutsideHints(false)
  }, [])

  useEffect(() => {
    if (!userId) return
    let cancelled = false

    getTrellisAvatarGenerationStatus()
      .then((status) => {
        if (cancelled || !status.active || !status.job) return
        if (status.job.status === 'running') {
          setResumeOutfitGeneration(true)
          setShowOutfit(true)
          closeOutsideHints()
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [closeOutsideHints, userId])

  const closeOutsideIntro = useCallback(() => {
    sessionStorage.setItem(OUTSIDE_INTRO_SEEN_KEY, '1')
    setShowOutsideIntro(false)
  }, [])

  const selectedQueueEntry = queue.find((entry) => entry.id === selectedQueueId) ?? null
  const canFaceControl = isFaceControlRole(myRole)
  const canUseSecurityPanel = canUseSecurityPanelRole(myRole)
  const canUseOwnerPanel = canUseOwnerPanelRole(myRole)
  const canUseAdminPanel = canUseAdminPanelRole(myRole)
  const canUseManagementPanel = canUseSecurityPanel || canUseOwnerPanel || canUseAdminPanel
  const isDj = myRole === 'dj'

  useEffect(() => {
    if (!canFaceControl) return
    if (managementPanelOpen) return
    setFacePanelOpen(true)
    setShowOutsideHints(false)
  }, [canFaceControl, managementPanelOpen])

  useEffect(() => {
    if (managementPanelOpen) setFacePanelOpen(false)
  }, [managementPanelOpen])

  useEffect(() => {
    if (!isDj) return
    setDjPanelMinimized(false)
    setShowOutsideHints(false)
  }, [isDj])

  useEffect(() => {
    if (!canUseManagementPanel) {
      setManagementPanelOpen(false)
      return
    }
    setShowOutsideHints(false)
    if (managementTab === 'admin' && !canUseAdminPanel) {
      setManagementTab(canUseOwnerPanel ? 'owner' : 'security')
    } else if (managementTab === 'owner' && !canUseOwnerPanel) {
      setManagementTab('security')
    }
  }, [canUseManagementPanel, canUseAdminPanel, canUseOwnerPanel, managementTab])

  useEffect(() => {
    sessionStorage.setItem(MANAGEMENT_PANEL_OPEN_KEY, managementPanelOpen ? '1' : '0')
  }, [managementPanelOpen])

  useEffect(() => {
    sessionStorage.setItem(MANAGEMENT_PANEL_TAB_KEY, managementTab)
  }, [managementTab])

  const addFaceLog = useCallback((message: string) => {
    setFaceLog((prev) => [`${new Date().toLocaleTimeString('ru')}  ${message}`, ...prev].slice(0, 40))
  }, [])

  const approveQueueEntry = useCallback((entry: QueueEntry) => {
    gameClient.approve(entry.id)
    addFaceLog(appText(language, `Впустил ${entry.displayName}`, `Admitted ${entry.displayName}`))
    setSelectedQueueId(null)
  }, [addFaceLog, language])

  const denyQueueEntry = useCallback((entry: QueueEntry, reason: string) => {
    gameClient.deny(entry.id, reason)
    addFaceLog(appText(language, `Отказал ${entry.displayName}: ${reason}`, `Denied ${entry.displayName}: ${reason}`))
    setSelectedQueueId(null)
  }, [addFaceLog, language])

  const runManagementAction = useCallback((action: string, payload: object = {}) => {
    gameClient.managementAction(action, payload)
  }, [])

  const setManagedDrinkPrice = useCallback((drinkId: string, price: number) => {
    gameClient.managementAction('setDrinkPrice', { drinkId, price })
  }, [])

  const handleOutfitDone = useCallback((until: number) => {
    const cfg = usePlayerStore.getState().avatarConfig
    if (cfg) {
      updatePlayerRef.current(cfg.faceTextureUrl ?? '', cfg.bodyTextureUrl ?? '', cfg.modelUrl ?? '')
      gameClient.sendAvatarUpdate(
        cfg.faceTextureUrl ?? '',
        cfg.bodyTextureUrl ?? '',
        cfg.topColor ?? '#222244',
        cfg.bottomColor ?? '#111133',
        cfg.modelUrl ?? '',
      )
    }
    setOutfitCooldownUntil(until)
    localStorage.setItem(OUTFIT_COOLDOWN_STORAGE_KEY, String(until))
    setResumeOutfitGeneration(false)
    setShowOutfit(false)
  }, [])

  return (
    <div style={{position:'relative',width:'100vw',height:'100dvh',minHeight:'100svh',overflow:'hidden'}}>
      <canvas ref={canvasRef} style={{display:'block',width:'100%',height:'100%'}}/>

      <div style={{position:'absolute',top:'calc(env(safe-area-inset-top, 0px) + 10px)',left:12,right:12,display:'flex',alignItems:'center',gap:8,pointerEvents:'none',zIndex:160}}>
        <div style={{minWidth:0,flex:'1 1 auto',background:'rgba(10,9,7,0.82)',border:'1px solid rgba(135,91,45,0.42)',borderRadius:4,padding:'7px 12px',fontFamily:'monospace',fontSize:10,color:'#d8b06f',letterSpacing:2.2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
          {CLUB_NAME} &nbsp;-&nbsp; {displayName||'GUEST'} &nbsp;·&nbsp; {clublesBalance} {appText(language, 'КЛБ', 'CLB')} &nbsp;·&nbsp; {playerCount} online
        </div>
        {myRole!=='guest' && myRole!=='bouncer' && (
          <div style={{flex:'0 0 auto',background:'rgba(10,9,7,0.74)',border:'1px solid #333',borderRadius:4,color:'#d8b06f',fontFamily:'monospace',fontSize:9,padding:'7px 9px',maxWidth:124,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
            {myRole.toUpperCase()}
          </div>
        )}
      </div>

      {queueState==='cooldown'&&deniedReason&&(
        <div style={{position:'absolute',top:60,left:'50%',transform:'translateX(-50%)',background:'rgba(40,0,0,0.9)',border:'1px solid #ff4444',borderRadius:6,padding:'10px 20px',fontFamily:'monospace',fontSize:12,color:'#ff6666',textAlign:'center',maxWidth:300}}>
          <div style={{color:'#ff4444',marginBottom:4}}>{appText(language, 'ВХОД ОТКЛОНЁН', 'ENTRY DENIED')}</div>
          <div style={{color:'#888',fontSize:11}}>{reasonLabel(deniedReason, language)}</div>
          <div style={{color:'#e040fb',marginTop:6}}>{appText(language, 'Новая попытка через', 'Retry in')} {fmtSecs(cooldownSecs)}</div>
        </div>
      )}

      <div style={{position:'absolute',bottom:'calc(env(safe-area-inset-bottom, 0px) + 34px)',right:16,display:'flex',flexDirection:'column',gap:7,zIndex:showOutsideHints?270:150}}>
        <SettingsButton
          active={settingsOpen}
          onClick={() => { closeOutsideHints(); setSettingsOpen((open) => !open) }}
        />

        <button onClick={handleQueueBtn} style={{
          padding:'8px 10px',borderRadius:4,minWidth:112,minHeight:38,
          cursor: queueState==='cooldown'?'not-allowed':'pointer',
          fontFamily:'monospace',fontSize:9,fontWeight:700,letterSpacing:0.4,whiteSpace:'pre-line',lineHeight:1.12,
          background: queueState==='waiting'  ? 'rgba(224,64,251,0.2)'
                    : queueState==='cooldown' ? 'rgba(40,0,0,0.6)'
                    : '#e040fb',
          color:  queueState==='waiting'  ? '#e040fb'
                : queueState==='cooldown' ? '#ff6666'
                : '#0d0d1a',
          border: queueState==='waiting'  ? '1px solid #e040fb'
                : queueState==='cooldown' ? '1px solid #ff4444'
                : 'none',
        }}>
          {queueLabel()}
        </button>

        {canUseManagementPanel && (
          <button onClick={() => { closeOutsideHints(); setManagementPanelOpen((open) => !open) }} style={{
            padding:'8px 10px',borderRadius:4,minWidth:112,minHeight:32,
            fontFamily:'monospace',fontSize:9,fontWeight:700,letterSpacing:0.6,
            background: managementPanelOpen ? '#7cffc4' : 'rgba(20,32,28,0.88)',
            color: managementPanelOpen ? '#06100a' : '#9ad9c0',
            border:'1px solid rgba(124,255,196,0.32)',
            cursor:'pointer',
          }}>
            OPS
          </button>
        )}
      </div>

      {staffDoorOpen && (
        <StaffEntryModal
          role={staffRole}
          password={staffPassword}
          attemptsLeft={staffAttemptsLeft}
          error={staffError}
          onRoleChange={(role) => { setStaffRole(role); setStaffError(''); setStaffPassword('') }}
          onPasswordChange={(value) => { setStaffPassword(value); if (staffError) setStaffError('') }}
          onSubmit={handleStaffSubmit}
          onClose={() => { staffDoorOpenRef.current = false; setStaffDoorOpen(false); setStaffPassword(''); setStaffError('') }}
        />
      )}

      {canUseManagementPanel && managementPanelOpen && (
        <ManagementPanel
          language={language}
          role={myRole}
          activeTab={managementTab}
          players={managementPlayers}
          queue={queue}
          drinkMenu={drinkMenu}
          clubEnergy={clubEnergy}
          onTabChange={setManagementTab}
          onApprove={approveQueueEntry}
          onDeny={denyQueueEntry}
          onAction={runManagementAction}
          onSetDrinkPrice={setManagedDrinkPrice}
          onClose={() => setManagementPanelOpen(false)}
        />
      )}

      {canFaceControl && facePanelOpen && (
        <OutsideFaceControlPanel
          queue={queue}
          selected={selectedQueueEntry}
          log={faceLog}
          onSelect={(entry) => setSelectedQueueId(entry.id)}
          onApprove={approveQueueEntry}
          onDeny={denyQueueEntry}
          onClose={() => setFacePanelOpen(false)}
          language={language}
        />
      )}
      {canFaceControl && !facePanelOpen && (
        <button
          type="button"
          onClick={() => { closeOutsideHints(); setFacePanelOpen(true) }}
          style={outsideFaceBadgeButtonStyle}
          aria-label="Open facecontrol panel"
        >
          FACE
        </button>
      )}

      {isDj && (
        <>
          <div style={{ ...outsideDjPanelMountStyle, display: djPanelMinimized ? 'none' : 'block' }}>
            <DJBoothPanel embedded onMinimize={() => setDjPanelMinimized(true)} />
          </div>
          {djPanelMinimized && (
            <button
              type="button"
              onClick={() => setDjPanelMinimized(false)}
              style={outsideDjBadgeButtonStyle}
              aria-label="Open DJ panel"
            >
              DJ
            </button>
          )}
        </>
      )}

      <AppSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChangeOutfit={() => {
          if (!outfitOnCooldown) {
            closeOutsideHints()
            setResumeOutfitGeneration(false)
            setShowOutfit(true)
          }
        }}
        changeOutfitDisabled={outfitOnCooldown}
        changeOutfitLabel={outfitOnCooldown
          ? appText(language, `Сменить образ через ${fmtSecs(outfitCooldownSecs)}`, `Change outfit in ${fmtSecs(outfitCooldownSecs)}`)
          : appText(language, 'Сменить образ', 'Change outfit')}
      />

      {showOutfit && (
        <OutfitModal
          resumeActive={resumeOutfitGeneration}
          onClose={() => {
            setResumeOutfitGeneration(false)
            setShowOutfit(false)
          }}
          onDone={handleOutfitDone}
        />
      )}

      <VoiceChat myPlayerId={myPlayerId} environment="outside"/>
      {showOutsideIntro && <OutsideIntroModal onDone={closeOutsideIntro}/>}
      {!showOutsideIntro && showOutsideHints && <OutsideHintsOverlay onDone={closeOutsideHints}/>}
      <AdminDebugOverlay />
      <Joystick onMove={(x,z) => { if((window as any).__setJoy) (window as any).__setJoy(x,z) }}/>
    </div>
  )
}

function StaffEntryModal({
  role,
  password,
  attemptsLeft,
  error,
  onRoleChange,
  onPasswordChange,
  onSubmit,
  onClose,
}: {
  role: StaffInviteRole
  password: string
  attemptsLeft: number
  error: string
  onRoleChange: (role: StaffInviteRole) => void
  onPasswordChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onClose: () => void
}) {
  const { language } = useAppLanguage()
  return (
    <div style={staffModalBackdropStyle}>
      <form style={staffModalStyle} onSubmit={onSubmit}>
        <div style={staffModalHeaderStyle}>
          <div style={staffModalTitleStyle}>STAFF ENTRY</div>
          <button type="button" onClick={onClose} style={staffModalCloseStyle}>X</button>
        </div>

        <div style={staffRoleGridStyle}>
          {STAFF_INVITE_ROLES.map((option) => {
            const active = option.id === role
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onRoleChange(option.id)}
                style={{
                  ...staffRoleButtonStyle,
                  background: active ? '#f241ff' : 'rgba(14,12,24,0.92)',
                  color: active ? '#07070c' : '#d8b7ff',
                  borderColor: active ? '#f241ff' : 'rgba(242,65,255,0.28)',
                }}
              >
                {option.label}
              </button>
            )
          })}
        </div>

        <label style={staffInputLabelStyle}>
          {appText(language, 'ПАРОЛЬ ПРИГЛАШЕНИЯ', 'INVITE PASSWORD')}
          <input
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            style={staffPasswordInputStyle}
          />
        </label>

        <div style={staffModalStatusStyle}>
          <span>{appText(language, 'ПОПЫТКИ', 'ATTEMPTS')}: {attemptsLeft}/3</span>
          {error && <span style={staffModalErrorStyle}>{error}</span>}
        </div>

        <button type="submit" style={staffSubmitButtonStyle}>{appText(language, 'ВОЙТИ В КЛУБ', 'ENTER CLUB')}</button>
      </form>
    </div>
  )
}

function OutsideIntroModal({ onDone }: { onDone: () => void }) {
  const { language } = useAppLanguage()
  return (
    <>
      <div style={outsideIntroBackdropStyle} />
      <div style={outsideIntroCardStyle}>
        <div style={outsideIntroKickerStyle}>{appText(language, `ДОБРО ПОЖАЛОВАТЬ В ${CLUB_NAME}`, `WELCOME TO ${CLUB_NAME}`)}</div>
        <div style={outsideIntroTitleStyle}>{appText(language, 'Ты у входа в клуб', 'You are at the club entrance')}</div>
        <div style={outsideIntroTextStyle}>
          {appText(
            language,
            'Исследуй улицу, общайся голосом с игроками рядом, вставай в очередь на вход и следи за атмосферой клуба. Здесь можно обновить образ, а роли DJ, facecontrol и охраны открывают дополнительные панели управления.',
            'Explore the street, talk by voice with nearby players, join the entry queue, and keep an eye on the club mood. You can refresh your outfit here, while DJ, facecontrol, and security roles unlock extra control panels.'
          )}
        </div>
        <div style={outsideIntroGridStyle}>
          <div style={outsideIntroItemStyle}>
            <span style={outsideIntroItemTitleStyle}>{appText(language, 'ГОЛОС', 'VOICE')}</span>
            <span>{appText(language, 'Разговор слышен рядом с твоим персонажем.', 'Voice is heard near your character.')}</span>
          </div>
          <div style={outsideIntroItemStyle}>
            <span style={outsideIntroItemTitleStyle}>{appText(language, 'ОЧЕРЕДЬ', 'QUEUE')}</span>
            <span>{appText(language, 'Встань в очередь и дождись решения facecontrol.', 'Join the queue and wait for facecontrol.')}</span>
          </div>
          <div style={outsideIntroItemStyle}>
            <span style={outsideIntroItemTitleStyle}>{appText(language, 'ОБРАЗ', 'OUTFIT')}</span>
            <span>{appText(language, 'Меняй внешний вид с коротким кулдауном.', 'Change your look after a short cooldown.')}</span>
          </div>
          <div style={outsideIntroItemStyle}>
            <span style={outsideIntroItemTitleStyle}>{appText(language, 'РОЛИ', 'ROLES')}</span>
            <span>{appText(language, 'Персонал клуба управляет музыкой, входом и порядком.', 'Club staff controls music, entry, and order.')}</span>
          </div>
        </div>
        <button type="button" style={outsideIntroButtonStyle} onClick={onDone}>
          {appText(language, 'ПОНЯТНО', 'GOT IT')}
        </button>
      </div>
    </>
  )
}

function OutsideHintsOverlay({ onDone }: { onDone: () => void }) {
  const { language } = useAppLanguage()
  return (
    <>
      <div style={outsideHintDimStyle} />
      <div style={{ ...outsideHintCalloutStyle, left: 84, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 252px)' }}>
        <span style={outsideHintArrowStyle}>↙</span>
        <span>{appText(language, 'ГОЛОС', 'VOICE')}</span>
      </div>
      <div style={{ ...outsideHintCalloutStyle, right: 52, top: 'calc(env(safe-area-inset-top, 0px) + 95px)', textAlign: 'right' }}>
        <span>MUSIC</span>
        <span style={outsideHintArrowStyle}>↗</span>
      </div>
      <div style={{ ...outsideHintCalloutStyle, right: 56, top: 'calc(env(safe-area-inset-top, 0px) + 198px)', textAlign: 'right' }}>
        <span>{appText(language, 'ГРОМКОСТЬ', 'VOLUME')}</span>
        <span style={outsideHintArrowStyle}>→</span>
      </div>
      <div style={{ ...outsideHintCalloutStyle, right: 136, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 98px)', textAlign: 'right' }}>
        <span>{appText(language, 'ОЧЕРЕДЬ / ОБРАЗ', 'QUEUE / OUTFIT')}</span>
        <span style={outsideHintArrowStyle}>↘</span>
      </div>
      <button type="button" style={outsideHintOkStyle} onClick={onDone}>
        OK
      </button>
    </>
  )
}

const outsideHintDimStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 220,
  background: 'rgba(0,0,0,0.58)',
  boxShadow: 'inset 0 0 120px rgba(224,64,251,0.16)',
  pointerEvents: 'auto',
}

const outsideIntroBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 300,
  background: 'rgba(0,0,0,0.7)',
  boxShadow: 'inset 0 0 140px rgba(216,176,111,0.12)',
  pointerEvents: 'auto',
}

const outsideIntroCardStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 310,
  width: 'min(520px, calc(100vw - 32px))',
  maxHeight: 'calc(100dvh - 48px)',
  overflowY: 'auto',
  borderRadius: 6,
  border: '1px solid rgba(216,176,111,0.52)',
  background: 'rgba(8,7,5,0.94)',
  color: '#e8e0d0',
  fontFamily: 'monospace',
  padding: 20,
  boxShadow: '0 20px 80px rgba(0,0,0,0.7), 0 0 36px rgba(216,176,111,0.18)',
  pointerEvents: 'auto',
}

const outsideIntroKickerStyle: CSSProperties = {
  color: '#d8b06f',
  fontSize: 10,
  fontWeight: 900,
  letterSpacing: 2.2,
  marginBottom: 8,
}

const outsideIntroTitleStyle: CSSProperties = {
  color: '#ffffff',
  fontSize: 22,
  fontWeight: 900,
  letterSpacing: 0,
  marginBottom: 10,
}

const outsideIntroTextStyle: CSSProperties = {
  color: '#a9a194',
  fontSize: 12,
  lineHeight: 1.65,
  marginBottom: 16,
}

const outsideIntroGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 10,
  marginBottom: 18,
}

const outsideIntroItemStyle: CSSProperties = {
  minHeight: 72,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(255,255,255,0.035)',
  padding: 10,
  color: '#8f887c',
  fontSize: 11,
  lineHeight: 1.45,
}

const outsideIntroItemTitleStyle: CSSProperties = {
  display: 'block',
  color: '#7cffc4',
  fontSize: 10,
  fontWeight: 900,
  letterSpacing: 1.5,
  marginBottom: 5,
}

const outsideIntroButtonStyle: CSSProperties = {
  width: '100%',
  minHeight: 42,
  borderRadius: 4,
  border: 'none',
  background: '#d8b06f',
  color: '#0b0906',
  fontFamily: 'monospace',
  fontSize: 12,
  fontWeight: 900,
  letterSpacing: 1.5,
  cursor: 'pointer',
}

const OUTSIDE_FACE_REASONS = [
  { code: 'vibe_check', ru: 'Вайб-чек', en: 'Vibe check' },
  { code: 'dress_code', ru: 'Дресс-код', en: 'Dress code' },
  { code: 'overcrowded', ru: 'Переполнено', en: 'Overcrowded' },
  { code: 'behavior', ru: 'Поведение', en: 'Behavior' },
  { code: 'closed_event', ru: 'Закрыто', en: 'Closed event' },
]

function OutsideFaceControlPanel({
  queue,
  selected,
  log,
  onSelect,
  onApprove,
  onDeny,
  onClose,
  language,
}: {
  queue: QueueEntry[]
  selected: QueueEntry | null
  log: string[]
  onSelect: (entry: QueueEntry) => void
  onApprove: (entry: QueueEntry) => void
  onDeny: (entry: QueueEntry, reason: string) => void
  onClose: () => void
  language: AppLanguage
}) {
  return (
    <div style={outsideFacePanelStyle}>
      <div style={outsideFaceHeaderStyle}>
        <div style={{ color: '#7cffc4', letterSpacing: 2, fontSize: 12 }}>FACECONTROL / OUTSIDE</div>
        <button type="button" onClick={onClose} style={outsideFaceCloseStyle}>MIN</button>
      </div>
      <div style={outsideFaceBodyStyle}>
        <div style={outsideFaceQueueStyle}>
          <div style={outsideFaceColumnTitleStyle}>QUEUE / {queue.length}</div>
          {queue.length === 0 && <div style={outsideFaceEmptyStyle}>{appText(language, 'пусто', 'empty')}</div>}
          {queue.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onSelect(entry)}
              style={{
                ...outsideFaceQueueItemStyle,
                borderColor: selected?.id === entry.id ? '#7cffc4' : 'rgba(255,255,255,0.12)',
                background: selected?.id === entry.id ? 'rgba(124,255,196,0.12)' : 'rgba(255,255,255,0.035)',
              }}
            >
              <span style={{ ...outsideFaceAvatarDotStyle, background: entry.topColor }} />
              <span style={{ minWidth: 0 }}>
                <span style={outsideFaceQueueNameStyle}>{entry.displayName}</span>
                <span style={outsideFaceQueuePosStyle}>#{entry.pos} {appText(language, 'в очереди', 'in queue')}</span>
              </span>
            </button>
          ))}
        </div>
        <div style={outsideFaceDecisionStyle}>
          {!selected ? (
            <div style={outsideFaceEmptyStyle}>{appText(language, 'выбери игрока', 'select a player')}</div>
          ) : (
            <>
              <div style={{ color: '#e8e8f0', fontSize: 14, marginBottom: 4 }}>{selected.displayName}</div>
              <div style={{ color: '#5b6474', fontSize: 11, marginBottom: 12 }}>#{selected.pos} {appText(language, 'в очереди', 'in queue')}</div>
              <div style={{ display: 'grid', placeItems: 'center', marginBottom: 12 }}>
                <AvatarMini entry={selected} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button type="button" onClick={() => onApprove(selected)} style={outsideFaceApproveStyle}>{appText(language, 'ВПУСТИТЬ', 'ADMIT')}</button>
                <button type="button" onClick={() => onDeny(selected, 'vibe_check')} style={outsideFaceDenyStyle}>{appText(language, 'ОТКАЗАТЬ', 'DENY')}</button>
              </div>
              <div style={outsideFaceReasonsStyle}>
                {OUTSIDE_FACE_REASONS.map((reason) => (
                  <button key={reason.code} type="button" onClick={() => onDeny(selected, reason.code)} style={outsideFaceReasonButtonStyle}>
                    {appText(language, reason.ru, reason.en)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div style={outsideFaceLogStyle}>
          <div style={outsideFaceColumnTitleStyle}>LOG</div>
          {log.length === 0 && <div style={outsideFaceEmptyStyle}>{appText(language, 'нет действий', 'no actions')}</div>}
          {log.map((entry, index) => (
            <div key={`${entry}-${index}`} style={outsideFaceLogEntryStyle}>{entry}</div>
          ))}
        </div>
      </div>
    </div>
  )
}

const staffModalBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 320,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 18,
  background: 'rgba(4,3,10,0.68)',
  backdropFilter: 'blur(3px)',
}

const outsideFacePanelStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(env(safe-area-inset-top, 0px) + 56px)',
  left: 12,
  width: 'min(880px, calc(100vw - 24px))',
  maxHeight: 'calc(100dvh - 82px)',
  border: '1px solid rgba(124,255,196,0.34)',
  borderRadius: 8,
  background: 'rgba(8,8,18,0.94)',
  boxShadow: '0 18px 60px rgba(0,0,0,0.5), 0 0 32px rgba(124,255,196,0.14)',
  color: '#e8e8f0',
  fontFamily: 'monospace',
  overflow: 'hidden',
  pointerEvents: 'auto',
  zIndex: 300,
}

const outsideFaceHeaderStyle: CSSProperties = {
  minHeight: 52,
  padding: '0 14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
}

const outsideFaceBodyStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '220px minmax(280px, 1fr) 190px',
  gap: 12,
  padding: 12,
  overflow: 'auto',
  maxHeight: 'calc(100dvh - 138px)',
}

const outsideFaceQueueStyle: CSSProperties = {
  minHeight: 280,
  maxHeight: 460,
  overflowY: 'auto',
}

const outsideFaceDecisionStyle: CSSProperties = {
  minHeight: 280,
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.025)',
  padding: 14,
  overflowY: 'auto',
}

const outsideFaceLogStyle: CSSProperties = {
  minHeight: 280,
  maxHeight: 460,
  overflowY: 'auto',
}

const outsideFaceColumnTitleStyle: CSSProperties = {
  color: '#5b6474',
  fontSize: 10,
  letterSpacing: 1.8,
  marginBottom: 8,
}

const outsideFaceQueueItemStyle: CSSProperties = {
  width: '100%',
  minHeight: 48,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 7,
  padding: '8px 10px',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  color: '#e8e8f0',
  fontFamily: 'monospace',
  textAlign: 'left',
  cursor: 'pointer',
}

const outsideFaceAvatarDotStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.18)',
  flex: '0 0 auto',
}

const outsideFaceQueueNameStyle: CSSProperties = {
  display: 'block',
  fontSize: 12,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
}

const outsideFaceQueuePosStyle: CSSProperties = {
  display: 'block',
  color: '#5b6474',
  fontSize: 10,
  marginTop: 2,
}

const outsideFaceEmptyStyle: CSSProperties = {
  color: '#384050',
  fontSize: 12,
  textAlign: 'center',
  padding: '34px 8px',
}

const outsideFaceApproveStyle: CSSProperties = {
  flex: 1,
  minHeight: 40,
  border: 'none',
  borderRadius: 4,
  background: '#00e676',
  color: '#06100a',
  fontFamily: 'monospace',
  fontWeight: 800,
  cursor: 'pointer',
}

const outsideFaceDenyStyle: CSSProperties = {
  flex: 1,
  minHeight: 40,
  border: 'none',
  borderRadius: 4,
  background: '#d92300',
  color: '#fff',
  fontFamily: 'monospace',
  fontWeight: 800,
  cursor: 'pointer',
}

const outsideFaceReasonsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 7,
}

const outsideFaceReasonButtonStyle: CSSProperties = {
  minHeight: 32,
  border: '1px solid rgba(217,35,0,0.34)',
  borderRadius: 4,
  background: 'rgba(217,35,0,0.12)',
  color: '#ff9a82',
  fontFamily: 'monospace',
  fontSize: 10,
  cursor: 'pointer',
}

const outsideFaceLogEntryStyle: CSSProperties = {
  color: '#8f95aa',
  fontSize: 10,
  lineHeight: 1.45,
  marginBottom: 7,
  wordBreak: 'break-word',
}

const outsideFaceCloseStyle: CSSProperties = {
  minWidth: 42,
  minHeight: 28,
  border: '1px solid rgba(255,255,255,0.16)',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.06)',
  color: '#d8f7ff',
  fontFamily: 'monospace',
  fontSize: 10,
  fontWeight: 700,
  cursor: 'pointer',
}

const outsideDjPanelMountStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(env(safe-area-inset-top, 0px) + 56px)',
  left: 12,
  zIndex: 300,
  pointerEvents: 'auto',
}

const outsideDjBadgeButtonStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(env(safe-area-inset-top, 0px) + 66px)',
  left: 18,
  width: 58,
  height: 58,
  borderRadius: '50%',
  border: '1px solid rgba(224,64,251,0.58)',
  background: 'radial-gradient(circle at 35% 25%, rgba(242,65,255,0.95), rgba(8,8,18,0.94) 68%)',
  color: '#ffffff',
  fontFamily: 'monospace',
  fontSize: 14,
  fontWeight: 900,
  letterSpacing: 1.4,
  boxShadow: '0 0 28px rgba(224,64,251,0.36)',
  cursor: 'pointer',
  zIndex: 305,
}

const outsideFaceBadgeButtonStyle: CSSProperties = {
  ...outsideDjBadgeButtonStyle,
  top: 'calc(env(safe-area-inset-top, 0px) + 136px)',
  background: 'radial-gradient(circle at 35% 25%, rgba(124,255,196,0.94), rgba(8,8,18,0.94) 68%)',
  borderColor: 'rgba(124,255,196,0.58)',
  boxShadow: '0 0 28px rgba(124,255,196,0.28)',
  fontSize: 11,
}

const staffModalStyle: CSSProperties = {
  width: 'min(420px, 100%)',
  border: '1px solid rgba(242,65,255,0.58)',
  borderRadius: 6,
  background: 'rgba(8,6,16,0.96)',
  boxShadow: '0 0 28px rgba(242,65,255,0.28), inset 0 0 24px rgba(80,35,140,0.22)',
  padding: 16,
  fontFamily: 'monospace',
  color: '#f7d8ff',
}

const staffModalHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 14,
}

const staffModalTitleStyle: CSSProperties = {
  color: '#f241ff',
  fontSize: 14,
  fontWeight: 900,
  letterSpacing: 2,
  textShadow: '0 0 14px rgba(242,65,255,0.9)',
}

const staffModalCloseStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(20,18,30,0.9)',
  color: '#aaa',
  fontFamily: 'monospace',
  cursor: 'pointer',
}

const staffRoleGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
  marginBottom: 14,
}

const staffRoleButtonStyle: CSSProperties = {
  minHeight: 34,
  borderRadius: 4,
  border: '1px solid rgba(242,65,255,0.28)',
  fontFamily: 'monospace',
  fontSize: 10,
  fontWeight: 900,
  letterSpacing: 0.8,
  cursor: 'pointer',
}

const staffInputLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  color: '#8f95aa',
  fontSize: 10,
  letterSpacing: 1.4,
  marginBottom: 10,
}

const staffPasswordInputStyle: CSSProperties = {
  minHeight: 38,
  borderRadius: 4,
  border: '1px solid rgba(242,65,255,0.36)',
  background: '#05040a',
  color: '#ffffff',
  outline: 'none',
  padding: '0 10px',
  fontFamily: 'monospace',
  fontSize: 14,
}

const staffModalStatusStyle: CSSProperties = {
  minHeight: 34,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 4,
  color: '#8f95aa',
  fontSize: 10,
  letterSpacing: 0.8,
}

const staffModalErrorStyle: CSSProperties = {
  color: '#ff6b8a',
}

const staffSubmitButtonStyle: CSSProperties = {
  width: '100%',
  minHeight: 40,
  marginTop: 8,
  borderRadius: 4,
  border: 'none',
  background: '#f241ff',
  color: '#07070c',
  fontFamily: 'monospace',
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: 1.2,
  cursor: 'pointer',
}

const outsideHintCalloutStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 280,
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  color: '#f241ff',
  fontFamily: 'monospace',
  fontSize: 10,
  fontWeight: 900,
  letterSpacing: 1.2,
  textShadow: '0 0 12px rgba(242,65,255,0.95)',
  pointerEvents: 'none',
}

const outsideHintArrowStyle: CSSProperties = {
  color: '#7cffc4',
  fontSize: 25,
  lineHeight: 1,
  textShadow: '0 0 14px rgba(124,255,196,0.95)',
}

const outsideHintOkStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 290,
  width: 76,
  height: 76,
  borderRadius: '50%',
  border: '1px solid rgba(242,65,255,0.95)',
  background: 'rgba(20,6,32,0.9)',
  color: '#f8d7ff',
  fontFamily: 'monospace',
  fontSize: 15,
  fontWeight: 900,
  letterSpacing: 2,
  boxShadow: '0 0 22px rgba(242,65,255,0.9), inset 0 0 18px rgba(242,65,255,0.26)',
  cursor: 'pointer',
  pointerEvents: 'auto',
}

// ── Outfit Camera Modal ───────────────────────────────────────────────────────
type ModalStep = 'intro' | 'fullbody' | 'review' | 'generating' | 'preview' | 'saving'
type OutfitCameraFacing = 'user' | 'environment'
type OutfitNotice = {
  tone: 'pending' | 'success' | 'warning'
  message: string
} | null

interface OutfitPhotos {
  fullbody: string | null
  face: string | null
}

type OutfitPipelineStage = AvatarPipelineStage

interface OutfitGenerationProcess {
  stage: OutfitPipelineStage
  sourceImage: string | null
  kieImage: string | null
  progress: number
  message: string
}

function createInitialOutfitGenerationProcess(): OutfitGenerationProcess {
  return {
    stage: 'source',
    sourceImage: null,
    kieImage: null,
    progress: 0,
    message: 'Готовим фото',
  }
}

async function attachStreamToVideo(video: HTMLVideoElement, stream: MediaStream): Promise<boolean> {
  video.srcObject = stream
  video.muted = true
  video.playsInline = true
  video.setAttribute('playsinline', 'true')
  video.setAttribute('webkit-playsinline', 'true')

  try {
    await waitForVideoMetadata(video)
    await video.play()
    return waitForRenderableVideoFrame(video)
  } catch {
    return false
  }
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let timeoutId: number | null = null
    const finish = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId)
      video.removeEventListener('loadedmetadata', finish)
      video.removeEventListener('canplay', finish)
      resolve()
    }

    video.addEventListener('loadedmetadata', finish)
    video.addEventListener('canplay', finish)
    timeoutId = window.setTimeout(finish, 1200)
  })
}

function waitForRenderableVideoFrame(video: HTMLVideoElement): Promise<boolean> {
  const startedAt = performance.now()

  return new Promise((resolve) => {
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        resolve(true)
        return
      }

      if (performance.now() - startedAt > 2500) {
        resolve(false)
        return
      }

      window.requestAnimationFrame(check)
    }

    check()
  })
}

function OutfitModal({
  resumeActive = false,
  onClose,
  onDone,
}: {
  resumeActive?: boolean
  onClose: () => void
  onDone: (until: number) => void
}) {
  const { language } = useAppLanguage()
  const [step,   setStep]   = useState<ModalStep>('intro')
  const [photos, setPhotos] = useState<OutfitPhotos>({ fullbody: null, face: null })
  const [generated, setGenerated] = useState<AvatarConfig | null>(null)
  const [error,  setError]  = useState<string|null>(null)
  const [notice, setNotice] = useState<OutfitNotice>(null)
  const [generationProcess, setGenerationProcess] = useState<OutfitGenerationProcess>(createInitialOutfitGenerationProcess)
  const [cameraMode, setCameraMode] = useState<'live'|'file'>('live')
  const [cameraFacing, setCameraFacing] = useState<OutfitCameraFacing>('environment')
  const [isDetecting, setIsDetecting] = useState(false)
  const [isCameraReady, setIsCameraReady] = useState(false)
  const [stream, setStream] = useState<MediaStream|null>(null)
  const videoRef  = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const resumedRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const stopStream = useCallback(() => {
    setIsCameraReady(false)
    if (videoRef.current?.srcObject === stream) {
      videoRef.current.pause()
      videoRef.current.srcObject = null
    }
    stream?.getTracks().forEach(t=>t.stop())
    setStream(null)
  }, [stream])
  useEffect(() => () => { stream?.getTracks().forEach(t=>t.stop()) }, [stream])

  useEffect(() => {
    if (!resumeActive || resumedRef.current) return
    resumedRef.current = true
    let cancelled = false

    stopStream()
    setStep('generating')
    setError(null)
    setNotice({ tone: 'pending', message: 'Возвращаемся к текущей генерации' })
    setGenerationProcess(createInitialOutfitGenerationProcess())

    resumeTrellisAvatarStream((event) => {
      if (cancelled) return
      if (event.type === 'result') return
      setGenerationProcess((current) => processOutfitPipelineEvent(current, event, event.sourceImage))
      if (event.type !== 'error') setNotice({ tone: 'pending', message: event.message })
    })
      .then((result) => {
        if (cancelled) return
        setGenerated(result.avatar)
        setGenerationProcess((current) => ({
          ...current,
          stage: 'done',
          kieImage: result.prepared?.image ?? current.kieImage,
          progress: 100,
          message: 'Аватар готов',
        }))
        setNotice({
          tone: result.trellis.status === 'generated' ? 'success' : 'warning',
          message: result.trellis.status === 'generated'
            ? `3D-модель готова. ${formatOutfitAutorigMessage(result.autorig ?? result.avatar.autorig ?? null)}`
            : `Показываем быстрый аватар. ${result.trellis.error ?? '3D-модель не успела собраться.'}`,
        })
        setStep('preview')
      })
      .catch((generationError) => {
        if (cancelled) return
        const message = generationError instanceof Error ? generationError.message : 'Не удалось восстановить генерацию'
        setError(message)
        setNotice({ tone: 'warning', message })
      })

    return () => {
      cancelled = true
    }
  }, [resumeActive, stopStream])

  const startCamera = useCallback(async (facing: OutfitCameraFacing) => {
    stopStream(); setError(null)
    setCameraFacing(facing)
    setIsCameraReady(false)
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCameraMode('file')
      setError('Камера в браузере на iPhone работает только через HTTPS. Сделай фото через системную камеру ниже или открой приложение по HTTPS.')
      return
    }
    try {
      setCameraMode('live')
      const s = await navigator.mediaDevices.getUserMedia({video:{facingMode:facing,width:{ideal:1280},height:{ideal:720}},audio:false})
      setStream(s)
      if (videoRef.current) {
        const ready = await attachStreamToVideo(videoRef.current, s)
        if (videoRef.current?.srcObject === s) setIsCameraReady(ready)
      }
    } catch {
      setCameraMode('file')
      setError('Камера недоступна. Разреши доступ в Safari или сделай фото через системную камеру ниже.')
    }
  }, [stopStream])

  const handleSwitchCamera = useCallback(() => {
    const nextFacing: OutfitCameraFacing = cameraFacing === 'environment' ? 'user' : 'environment'
    void startCamera(nextFacing)
  }, [cameraFacing, startCamera])

  useEffect(() => {
    if (step !== 'fullbody' || cameraMode !== 'live' || !stream || !videoRef.current) return

    let cancelled = false
    setIsCameraReady(false)
    void attachStreamToVideo(videoRef.current, stream).then((ready) => {
      if (!cancelled && videoRef.current?.srcObject === stream) setIsCameraReady(ready)
    })

    return () => {
      cancelled = true
    }
  }, [cameraMode, step, stream])

  const takePhoto = useCallback((): string|null => {
    const video=videoRef.current, canvas=canvasRef.current; if(!video||!canvas) return null
    if (!isCameraReady || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      setError('Камера ещё запускается — подожди секунду и попробуй снова')
      return null
    }
    canvas.width=video.videoWidth; canvas.height=video.videoHeight
    const ctx=canvas.getContext('2d')!
    ctx.drawImage(video,0,0,canvas.width,canvas.height)
    return compressCameraPhoto(canvas)
  }, [isCameraReady])

  const acceptPhoto = useCallback(async (dataUrl: string) => {
    setIsDetecting(true)
    setError(null)

    let normalizedFullbody = dataUrl
    let normalizedFace = dataUrl
    try {
      const [fullbody, face] = await Promise.all([
        normalizeFullBodyPhoto(dataUrl),
        normalizeFacePhoto(dataUrl),
      ])
      normalizedFullbody = fullbody
      normalizedFace = face
    } catch {
      normalizedFullbody = dataUrl
      normalizedFace = dataUrl
    } finally {
      setIsDetecting(false)
    }

    stopStream()
    setGenerated(null)
    setNotice(null)
    setGenerationProcess(createInitialOutfitGenerationProcess())
    setPhotos({ fullbody: normalizedFullbody, face: normalizedFace })
    setStep('review')
  }, [stopStream])

  const handleCapture = useCallback(async () => {
    const dataUrl=takePhoto()
    if (dataUrl) {
      await acceptPhoto(dataUrl)
      return
    }
    cameraInputRef.current?.click()
  }, [acceptPhoto, takePhoto])

  const handleSelectedFile = useCallback((file: File) => {
    const reader=new FileReader()
    reader.onload=ev=>{
      const dataUrl=ev.target?.result
      if (typeof dataUrl === 'string') void acceptPhoto(dataUrl)
    }
    reader.readAsDataURL(file)
  }, [acceptPhoto])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (file) handleSelectedFile(file)
  }, [handleSelectedFile])

  const handleGenerate = useCallback(async () => {
    const fullbody = photos.fullbody
    if (!fullbody) return
    const face = photos.face ?? fullbody
    setStep('generating')
    setError(null)
    setGenerationProcess({
      stage: 'source',
      sourceImage: fullbody,
      kieImage: null,
      progress: 5,
      message: 'Готовим исходное фото',
    })
    setNotice({ tone: 'pending', message: 'Собираем быстрый превью-аватар' })
    try {
      const fallback = await generateNoAiAvatar(fullbody, face)
      setGenerated(fallback.config)
      setGenerationProcess({
        stage: 'fallback',
        sourceImage: fullbody,
        kieImage: null,
        progress: 22,
        message: 'Быстрый аватар готов',
      })
      setNotice({ tone: 'pending', message: 'Подготавливаем фото' })

      const { prepared } = await prepareTrellisModelPhoto(fullbody)
      setGenerationProcess({
        stage: 'kie_done',
        sourceImage: fullbody,
        kieImage: prepared.image,
        progress: 58,
        message: 'Фото готово, запускаем 3D на вашем устройстве',
      })
      setNotice({ tone: 'pending', message: 'Собираем 3D-модель прямо с вашего устройства' })
      setGenerationProcess({
        stage: 'trellis_connect',
        sourceImage: fullbody,
        kieImage: prepared.image,
        progress: 62,
        message: 'Подключаемся к 3D-сервису с вашего устройства',
      })

      const result = await generateBrowserTrellisAvatarFromPreparedImages([prepared.image], fallback.config)

      setGenerated(result.avatar)
      setGenerationProcess({
        stage: 'done',
        sourceImage: fullbody,
        kieImage: prepared.image,
        progress: 100,
        message: 'Аватар готов',
      })
      if (result.trellis.status === 'generated') {
        setNotice({
          tone: 'success',
          message: `3D-модель готова. ${formatOutfitAutorigMessage(result.autorig ?? result.avatar.autorig ?? null)}`,
        })
      } else {
        setNotice({
          tone: 'warning',
          message: `3D-модель не получилась, оставили быстрый аватар. ${cleanOutfitGenerationDetails(result.trellis.error ?? '')}`.trim(),
        })
      }
      setStep('preview')
    } catch (generationError) {
      const message = generationError instanceof Error ? generationError.message : 'Не удалось создать аватар'
      setError(formatOutfitGenerationError(message))
      setStep('review')
    }
  }, [photos.face, photos.fullbody])

  const handleConfirm = useCallback(async () => {
    if (!generated && !photos.fullbody) return
    const fullbody = photos.fullbody
    const face = photos.face ?? fullbody
    setStep('saving')
    setError(null)
    try {
      const { userId } = usePlayerStore.getState()
      if (!userId) throw new Error('Не авторизован')
      const finalAvatar = generated ?? (await generateNoAiAvatar(fullbody!, face!)).config
      const avatarPayload = {
        user_id: userId,
        glb_url: finalAvatar.modelUrl ?? finalAvatar.rpmGlbUrl,
        face_tex_url: finalAvatar.faceTextureUrl,
        config_json: finalAvatar,
      }

      const { data: existingAvatar, error: selectError } = await supabase
        .from('avatars')
        .select('id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (selectError) throw selectError

      const { error: dbError } = existingAvatar?.id
        ? await supabase.from('avatars').update(avatarPayload).eq('id', existingAvatar.id)
        : await supabase.from('avatars').insert(avatarPayload)
      if (dbError) throw dbError

      usePlayerStore.getState().setAvatarConfig(finalAvatar)
      onDone(Date.now() + OUTFIT_COOLDOWN_MS)
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Не удалось сохранить аватар'
      setError(message)
      setStep('preview')
    }
  }, [generated, onDone, photos.face, photos.fullbody])

  const resetFlow = useCallback(() => {
    resumedRef.current = false
    stopStream()
    setPhotos({ fullbody: null, face: null })
    setGenerated(null)
    setError(null)
    setNotice(null)
    setGenerationProcess(createInitialOutfitGenerationProcess())
    setCameraFacing('environment')
    setStep('intro')
  }, [stopStream])

  const close = () => {
    stopStream()
    onClose()
  }

  const overlay: CSSProperties = {
    position:'fixed',inset:0,zIndex:300,background:'rgba(5,5,16,0.97)',
    display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'flex-start',
    height:'100vh',maxHeight:'100dvh',minHeight:'100svh',
    fontFamily:'monospace',color:'#e8e8f0',
    padding:'calc(20px + env(safe-area-inset-top, 0px)) 16px calc(32px + env(safe-area-inset-bottom, 0px))',
    overflowX:'hidden',overflowY:'auto',overscrollBehaviorY:'contain',touchAction:'pan-y',
  }
  const btnStyle: CSSProperties = {marginTop:16,padding:'13px 28px',minHeight:44,background:'#e040fb',color:'#0d0d1a',border:'none',borderRadius:4,fontSize:13,fontFamily:'monospace',fontWeight:700,cursor:'pointer',letterSpacing:1.4}
  const ghostStyle: CSSProperties = {marginTop:8,padding:'10px 22px',minHeight:40,background:'transparent',color:'#888',border:'1px solid #333',borderRadius:4,fontSize:12,fontFamily:'monospace',cursor:'pointer'}
  const pickerLabelStyle: CSSProperties = {position:'relative',overflow:'hidden',display:'inline-flex',alignItems:'center',justifyContent:'center'}
  const pickerInputStyle: CSSProperties = {position:'absolute',inset:0,opacity:0,cursor:'pointer',fontSize:80}

  return (
    <div style={overlay}>
      <button onClick={close} style={{position:'absolute',top:16,right:16,background:'transparent',border:'1px solid #333',borderRadius:4,color:'#888',fontFamily:'monospace',fontSize:12,padding:'6px 14px',cursor:'pointer'}}>
        {appText(language, 'ЗАКРЫТЬ', 'CLOSE')}
      </button>

      {step==='intro' && <>
        <div style={{fontSize:11,color:'#e040fb',letterSpacing:3,marginBottom:8}}>{appText(language, 'СМЕНА ОБРАЗА', 'OUTFIT CHANGE')}</div>
        <div style={{fontSize:20,fontWeight:700,marginBottom:12}}>{appText(language, 'Новый аватар', 'New avatar')}</div>
        <div style={{fontSize:13,color:'#888',textAlign:'center',lineHeight:1.7,maxWidth:330}}>
          {appText(language, 'Нужен один кадр в полный рост. Система подготовит фото, соберёт 3D-модель и заменит персонажа в outside.', 'You need one full-body shot. The system will prepare the photo, build a 3D model, and replace your outside character.')}
          <br/><br/>
          <span style={{fontSize:11,color:'#555'}}>{appText(language, 'После сохранения смена снова закроется на 10 минут', 'After saving, changing will be locked again for 10 minutes')}</span>
        </div>
        <button style={btnStyle} onClick={()=>{setStep('fullbody');startCamera('environment')}}>
          {appText(language, 'НАЧАТЬ', 'START')}
        </button>
      </>}

      {step==='fullbody' && <>
        <div style={{fontSize:11,color:'#e040fb',letterSpacing:3,marginBottom:8}}>{appText(language, 'ШАГ 1 из 1', 'STEP 1 OF 1')}</div>
        <div style={{fontSize:20,fontWeight:700,marginBottom:8}}>{appText(language, 'Полный рост', 'Full body')}</div>
        <div style={{fontSize:13,color:'#888',textAlign:'center',lineHeight:1.6,maxWidth:330}}>
          {appText(language, 'Встань прямо: лицо, руки и обувь должны попасть в кадр.', 'Stand straight: face, hands, and shoes should be in frame.')}
        </div>
        {error && <div style={{color:'#ff4444',fontSize:13,marginTop:8,textAlign:'center'}}>{error}</div>}
        <div style={{width:'100%',maxWidth:400,position:'relative',marginTop:16}}>
          {cameraMode==='live' ? (
            <video ref={videoRef} playsInline muted autoPlay style={{width:'100%',maxWidth:400,borderRadius:8,border:'1px solid #2a2a3a',display:'block',background:'#111'}}/>
          ) : (
            <div style={{width:'100%',maxWidth:400,minHeight:240,borderRadius:8,border:'1px solid #2a2a3a',background:'rgba(13,13,26,0.82)',display:'flex',alignItems:'center',justifyContent:'center',padding:24,textAlign:'center',fontSize:12,lineHeight:1.7,color:'#888'}}>
              {appText(language, 'Сделай фото в полный рост или выбери готовое из галереи.', 'Take a full-body photo or choose one from your gallery.')}
            </div>
          )}
          {isDetecting && (
            <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',borderRadius:8,background:'rgba(13,13,26,0.68)',color:'#e8e8f0',fontSize:13,fontWeight:700,letterSpacing:2}}>
              {appText(language, 'ОПРЕДЕЛЯЕМ...', 'DETECTING...')}
            </div>
          )}
        </div>
        <canvas ref={canvasRef} style={{display:'none'}}/>
        {cameraMode==='live' ? (
          <>
            <button style={btnStyle} onClick={handleCapture} disabled={isDetecting}>{isDetecting ? appText(language, 'ОБРАБОТКА', 'PROCESSING') : appText(language, 'СНЯТЬ', 'CAPTURE')}</button>
            <button style={ghostStyle} onClick={handleSwitchCamera} disabled={isDetecting}>
              {cameraFacing === 'environment' ? appText(language, 'ФРОНТАЛЬНАЯ КАМЕРА', 'FRONT CAMERA') : appText(language, 'ЗАДНЯЯ КАМЕРА', 'REAR CAMERA')}
            </button>
            <input ref={cameraInputRef} type="file" accept="image/*" capture={cameraFacing} style={{display:'none'}} onChange={handleFileInput}/>
          </>
        ) : (
          <label style={{...btnStyle,...pickerLabelStyle}}>
            <span>{appText(language, 'СНЯТЬ', 'CAPTURE')}</span>
            <input type="file" accept="image/*" capture={cameraFacing} style={pickerInputStyle} onChange={handleFileInput}/>
          </label>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" style={{display:'none'}} onChange={handleFileInput}/>
        <button style={ghostStyle} onClick={() => fileInputRef.current?.click()} disabled={isDetecting}>{appText(language, 'ЗАГРУЗИТЬ ИЗ ГАЛЕРЕИ', 'UPLOAD FROM GALLERY')}</button>
        <button style={{...ghostStyle,marginTop:4}} onClick={resetFlow}>{appText(language, 'НАЗАД', 'BACK')}</button>
      </>}

      {step==='review' && <>
        <div style={{fontSize:11,color:'#e040fb',letterSpacing:3,marginBottom:8}}>DOOR//CLUB</div>
        <div style={{fontSize:20,fontWeight:700,marginBottom:12}}>{appText(language, 'Проверь фото', 'Check the photo')}</div>
        <OutfitPhotoReview
          label={appText(language, 'ПОЛНЫЙ РОСТ', 'FULL BODY')}
          src={photos.fullbody}
          onRetake={() => {
            setGenerated(null)
            setStep('fullbody')
            startCamera('environment')
          }}
        />
        {error && <div style={{color:'#ff4444',fontSize:13,marginTop:8,textAlign:'center',maxWidth:360}}>{error}</div>}
        <button style={btnStyle} onClick={handleGenerate}>{appText(language, 'СОЗДАТЬ 3D АВАТАР', 'CREATE 3D AVATAR')}</button>
        <button style={ghostStyle} onClick={resetFlow}>{appText(language, 'ПЕРЕСНЯТЬ', 'RETAKE')}</button>
      </>}

      {(step==='generating'||step==='saving') && <>
        <div style={{fontSize:11,color:'#e040fb',letterSpacing:3,marginBottom:8}}>{appText(language, 'СМЕНА ОБРАЗА', 'OUTFIT CHANGE')}</div>
        <div style={{fontSize:20,fontWeight:700}}>{step==='saving' ? appText(language, 'Сохраняем...', 'Saving...') : appText(language, 'Собираем персонажа...', 'Building character...')}</div>
        <div style={{fontSize:13,color:'#888',marginTop:12,textAlign:'center',lineHeight:1.6,maxWidth:380}}>
          {step==='saving' ? appText(language, 'Секунду', 'One second') : translateOutfitMessage(notice?.message ?? 'Собираем 3D-модель', language)}
        </div>
        {step==='generating' && <OutfitGenerationProcessView process={generationProcess} language={language} />}
        {error && <div style={{color:'#ff4444',fontSize:13,marginTop:12,textAlign:'center',maxWidth:360}}>{error}</div>}
      </>}

      {step==='preview' && generated && <>
        <div style={{fontSize:11,color:'#e040fb',letterSpacing:3,marginBottom:8}}>DOOR//CLUB</div>
        <div style={{fontSize:20,fontWeight:700,marginBottom:10}}>{appText(language, 'Новый персонаж', 'New character')}</div>
        <AvatarPreview3D config={generated} width={260} height={350} />
        <div style={{display:'flex',gap:8,marginTop:12}}>
          <span style={{...outfitModalStyles.swatch,background:generated.skinTone}} />
          <span style={{...outfitModalStyles.swatch,background:generated.hairColor}} />
          <span style={{...outfitModalStyles.swatch,background:generated.topColor}} />
          <span style={{...outfitModalStyles.swatch,background:generated.bottomColor}} />
          <span style={{...outfitModalStyles.swatch,background:generated.shoesColor}} />
        </div>
        {notice && <div style={{...outfitModalStyles.notice,...outfitNoticeToneStyle(notice.tone)}}>{translateOutfitMessage(notice.message, language)}</div>}
        {error && <div style={{color:'#ff4444',fontSize:13,marginTop:8,textAlign:'center',maxWidth:360}}>{error}</div>}
        <div style={{display:'flex',gap:10,justifyContent:'center',flexWrap:'wrap'}}>
          <button style={btnStyle} onClick={handleConfirm}>{appText(language, 'СОХРАНИТЬ ОБРАЗ', 'SAVE OUTFIT')}</button>
          <button style={{...ghostStyle,marginTop:16}} onClick={resetFlow}>{appText(language, 'ПЕРЕСНЯТЬ', 'RETAKE')}</button>
        </div>
      </>}
    </div>
  )
}

function isOutfitKiePreparationError(message: string): boolean {
  return message.includes('KIE') || message.includes('KIE_API_KEYS')
}

function cleanOutfitGenerationDetails(details: string): string {
  return details
    .replace(/<[^>]*>/g, ' ')
    .replace(/KIE_API_KEYS/g, 'ключи модуля генерации')
    .replace(/Hugging Face Pixal3D/gi, 'модуль 3D-сборки')
    .replace(/Hugging Face TRELLIS\.?2?/gi, 'модуль 3D-сборки')
    .replace(/Pixal3D/gi, 'модуль 3D-сборки')
    .replace(/TRELLIS\.?2?/gi, 'модуль 3D-сборки')
    .replace(/\bKIE\b/gi, 'модуль подготовки фото')
    .replace(/ENOENT: no such file or directory, open '[^']*rigged\.(?:glb|3D-модель)'/gi, 'подготовка движений не создала файл 3D-модели')
    .replace(/\bGLB\b/gi, '3D-модель')
    .replace(/Blender autorig/gi, 'подготовка движений')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatOutfitGenerationError(message: string): string {
  if (/\bload failed\b/i.test(message)) {
    return 'Не удалось получить подготовленное фото от сервиса генерации. Попробуй ещё раз.'
  }

  if (isOutfitKiePreparationError(message)) {
    return `Не удалось подготовить фото для 3D-модели. ${cleanOutfitGenerationDetails(message)}`.trim()
  }
  return cleanOutfitGenerationDetails(message)
}

function formatOutfitAutorigMessage(autorig: AvatarConfig['autorig']): string {
  if (!autorig) return 'Подготовка движений: локальная анимация включена'
  if (autorig.status === 'generated') return 'Подготовка движений: готово'
  return 'Подготовка движений: локальная анимация включена'
}

function outfitNoticeToneStyle(tone: NonNullable<OutfitNotice>['tone']): CSSProperties {
  if (tone === 'success') return { color: '#75ff9b' }
  if (tone === 'warning') return { color: '#ffcc66' }
  return { color: '#888' }
}

function processOutfitPipelineEvent(
  current: OutfitGenerationProcess,
  event: AvatarPipelineEvent,
  sourceImage?: string,
): OutfitGenerationProcess {
  return {
    stage: event.stage,
    sourceImage: event.sourceImage ?? sourceImage ?? current.sourceImage,
    kieImage: event.prepared?.image ?? current.kieImage,
    progress: Math.max(current.progress, event.progress),
    message: event.message,
  }
}

function OutfitGenerationProcessView({ process, language }: { process: OutfitGenerationProcess; language: AppLanguage }) {
  const stages: Array<{ key: OutfitPipelineStage; ru: string; en: string }> = [
    { key: 'source', ru: 'Исходное фото', en: 'Source photo' },
    { key: 'fallback', ru: 'Быстрый аватар', en: 'Quick avatar' },
    { key: 'kie_upload', ru: 'Загрузка фото', en: 'Photo upload' },
    { key: 'kie_create', ru: 'Подготовка', en: 'Preparation' },
    { key: 'kie_wait', ru: 'Обработка фото', en: 'Photo processing' },
    { key: 'kie_download', ru: 'Получение фото', en: 'Photo download' },
    { key: 'kie_done', ru: 'Фото готово', en: 'Photo ready' },
    { key: 'trellis_connect', ru: '3D подключение', en: '3D connection' },
    { key: 'trellis_session', ru: 'Очередь сборки', en: 'Build queue' },
    { key: 'trellis_preprocess', ru: 'Нормализация', en: 'Normalization' },
    { key: 'trellis_generate', ru: '3D сборка', en: '3D build' },
    { key: 'trellis_upload', ru: 'Сохранение модели', en: 'Model save' },
    { key: 'autorig', ru: 'Движения', en: 'Motion' },
    { key: 'save', ru: 'Сохранение', en: 'Saving' },
    { key: 'done', ru: 'Готово', en: 'Done' },
  ]
  const activeIndex = Math.max(0, stages.findIndex((stage) => stage.key === process.stage))
  const showProgress = process.stage !== 'source'

  return (
    <div style={outfitModalStyles.pipelinePanel}>
      <div style={outfitModalStyles.pipelineSteps}>
        {stages.map((stage, index) => (
          <div
            key={stage.key}
            style={{
              ...outfitModalStyles.pipelineStep,
              ...(index < activeIndex ? outfitModalStyles.pipelineStepDone : {}),
              ...(index === activeIndex ? outfitModalStyles.pipelineStepActive : {}),
            }}
          >
            {appText(language, stage.ru, stage.en)}
          </div>
        ))}
      </div>

      {showProgress && (
        <div style={outfitModalStyles.progressWrap}>
          <div style={outfitModalStyles.progressTrack}>
            <div style={{ ...outfitModalStyles.progressFill, width: `${Math.max(0, Math.min(100, process.progress))}%` }} />
          </div>
          <div style={outfitModalStyles.progressText}>{Math.round(process.progress)}%</div>
        </div>
      )}

      <div style={outfitModalStyles.pipelineImages}>
        {process.sourceImage && <OutfitPipelineImage label={appText(language, 'исходное фото', 'source photo')} src={process.sourceImage} />}
        {process.kieImage && <OutfitPipelineImage label={appText(language, 'подготовленное фото', 'prepared photo')} src={process.kieImage} />}
      </div>

      <div style={outfitModalStyles.pipelinePlaceholder}>
        {translateOutfitMessage(process.message || formatOutfitPipelineHint(process.stage), language)}
      </div>
    </div>
  )
}

function OutfitPipelineImage({ label, src }: { label: string; src: string }) {
  return (
    <div style={outfitModalStyles.pipelineImageWrap}>
      <div style={outfitModalStyles.photoLabel}>{label}</div>
      <img src={src} alt={label} style={outfitModalStyles.pipelineImage} />
    </div>
  )
}

function formatOutfitPipelineHint(stage: OutfitPipelineStage): string {
  if (stage === 'fallback') return 'Быстрый аватар готов'
  if (stage.startsWith('kie_')) return 'Готовим фото для 3D-модели'
  if (stage.startsWith('trellis_')) return 'Собираем 3D-модель'
  if (stage === 'autorig') return 'Подготавливаем модель для движения'
  if (stage === 'save') return 'Сохраняем аватар'
  if (stage === 'done') return '3D-модель готова для персонажа'
  if (stage === 'failed') return 'Генерация остановилась'
  return 'Готовим фото'
}

function translateOutfitMessage(message: string, language: AppLanguage) {
  if (language === 'ru') return message
  return message
    .replace('Готовим фото', 'Preparing photo')
    .replace('Готовим исходное фото', 'Preparing source photo')
    .replace('Собираем быстрый превью-аватар', 'Building quick preview avatar')
    .replace('Быстрый аватар готов', 'Quick avatar is ready')
    .replace('Подготавливаем фото', 'Preparing photo')
    .replace('Аватар готов', 'Avatar is ready')
    .replace('3D-модель готова', '3D model is ready')
    .replace('3D-модель не получилась, оставили быстрый аватар', '3D model failed, keeping quick avatar')
    .replace('3D-модель не успела собраться', '3D model did not finish in time')
    .replace('Собираем 3D-модель', 'Building 3D model')
    .replace('Подготавливаем модель для движения', 'Preparing model for motion')
    .replace('Сохраняем аватар', 'Saving avatar')
    .replace('3D-модель готова для персонажа', '3D model is ready for the character')
    .replace('Генерация остановилась', 'Generation stopped')
}

function OutfitPhotoReview({ label, src, onRetake }: {
  label: string
  src: string | null
  onRetake: () => void
}) {
  const { language } = useAppLanguage()
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={outfitModalStyles.photoLabel}>{label}</div>
      {src && <img src={src} style={outfitModalStyles.photo} alt={label} />}
      <button style={{ ...outfitModalStyles.ghostButton, marginTop: 8 }} onClick={onRetake}>{appText(language, 'Переснять', 'Retake')}</button>
    </div>
  )
}

const outfitModalStyles: Record<string, CSSProperties> = {
  ghostButton: {
    marginTop: 8,
    padding: '10px 22px',
    minHeight: 40,
    background: 'transparent',
    color: '#888',
    border: '1px solid #333',
    borderRadius: 4,
    fontSize: 12,
    fontFamily: 'monospace',
    cursor: 'pointer',
  },
  photo: {
    width: '100%',
    maxWidth: 170,
    height: 220,
    objectFit: 'cover',
    borderRadius: 8,
    border: '1px solid #2a2a3a',
    background: '#111',
  },
  photoLabel: {
    fontSize: 11,
    color: '#888',
    marginBottom: 8,
  },
  notice: {
    fontSize: 12,
    marginTop: 10,
    maxWidth: 760,
    textAlign: 'center',
    lineHeight: 1.5,
  },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 3,
    border: '1px solid rgba(255,255,255,0.18)',
  },
  pipelinePanel: {
    width: '100%',
    maxWidth: 640,
    marginTop: 18,
  },
  pipelineSteps: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 6,
    width: '100%',
  },
  pipelineStep: {
    minHeight: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '4px 6px',
    border: '1px solid #292938',
    borderRadius: 4,
    color: '#666',
    fontSize: 9,
    lineHeight: 1.15,
    textAlign: 'center',
    overflow: 'hidden',
    whiteSpace: 'normal',
  },
  pipelineStepDone: {
    color: '#b18bb9',
    borderColor: '#4a3050',
    background: 'rgba(224,64,251,0.08)',
  },
  pipelineStepActive: {
    color: '#0d0d1a',
    background: '#e040fb',
    borderColor: '#e040fb',
  },
  progressWrap: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 44px',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    background: '#1a1a28',
    border: '1px solid #292938',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
    background: '#e040fb',
    transition: 'width 0.24s ease',
  },
  progressText: {
    color: '#e8e8f0',
    fontSize: 12,
    textAlign: 'right',
  },
  pipelineImages: {
    display: 'flex',
    gap: 12,
    justifyContent: 'center',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    marginTop: 16,
  },
  pipelineImageWrap: {
    width: 120,
    textAlign: 'center',
  },
  pipelineImage: {
    width: 120,
    height: 220,
    objectFit: 'contain',
    objectPosition: 'center',
    borderRadius: 6,
    border: '1px solid #2a2a3a',
    background: '#050509',
  },
  pipelinePlaceholder: {
    marginTop: 18,
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
  },
}

const REASON_LABELS: Record<string, { ru: string; en: string }> = {
  dress_code: { ru: 'Не тот дресс-код', en: 'Wrong dress code' },
  overcrowded: { ru: 'Клуб переполнен', en: 'Club is full' },
  behavior: { ru: 'Поведение в очереди', en: 'Queue behavior' },
  closed_event: { ru: 'Закрытое мероприятие', en: 'Closed event' },
  vibe_check: { ru: 'Не прошёл вайб-чек', en: 'Failed vibe check' },
}

function reasonLabel(reason: string, language: AppLanguage) {
  const label = REASON_LABELS[reason]
  return label ? appText(language, label.ru, label.en) : reason
}

function fmtSecs(s: number) { return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}` }

function Joystick({ onMove }: { onMove: (x:number,z:number)=>void }) {
  const stickRef = useRef<HTMLDivElement>(null)
  const active=useRef(false), origin=useRef({x:0,y:0}), MAX=36
  const start=(cx:number,cy:number)=>{active.current=true;origin.current={x:cx,y:cy}}
  const move=(cx:number,cy:number)=>{
    if(!active.current||!stickRef.current) return
    const dx=cx-origin.current.x, dy=cy-origin.current.y
    const dist=Math.min(MAX,Math.sqrt(dx*dx+dy*dy)), a=Math.atan2(dy,dx)
    stickRef.current.style.transform=`translate(${Math.cos(a)*dist}px,${Math.sin(a)*dist}px)`
    onMove(dx/MAX,dy/MAX)
  }
  const end=()=>{active.current=false;if(stickRef.current)stickRef.current.style.transform='translate(0,0)';onMove(0,0)}
  return (
    <div onTouchStart={e=>start(e.touches[0].clientX,e.touches[0].clientY)}
      onTouchMove={e=>{e.preventDefault();move(e.touches[0].clientX,e.touches[0].clientY)}}
      onTouchEnd={end}
      style={{position:'absolute',bottom:'calc(env(safe-area-inset-bottom, 0px) + 34px)',left:22,width:80,height:80,borderRadius:'50%',background:'rgba(255,255,255,0.06)',border:'1px solid rgba(255,255,255,0.12)',display:'flex',alignItems:'center',justifyContent:'center',touchAction:'none',zIndex:130}}>
      <div ref={stickRef} style={{width:34,height:34,borderRadius:'50%',background:'rgba(224,64,251,0.45)',border:'1px solid #e040fb',transition:'transform 0.04s',pointerEvents:'none'}}/>
    </div>
  )
}
