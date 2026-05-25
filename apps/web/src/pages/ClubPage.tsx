import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import AdminDebugOverlay from '@/components/AdminDebugOverlay'
import { MUSIC_BPM_EVENT, MUSIC_OUTPUT_EVENT } from '@/components/MusicPlayer'
import VoiceChat, { PROXIMITY_VOICE_POSITIONS_EVENT, VOICE_LEVELS_EVENT, VOICE_TALKING_EVENT } from '@/components/VoiceChat'
import { usePlayerStore } from '@/store/playerStore'
import { loadGeneratedAvatarRig, type GeneratedAvatarRig, type GeneratedDanceId } from '@/utils/generatedAvatarRig'
import { applyAvatarFacingRotation, getAvatarMovementRotationY } from '@/utils/avatarFacing'
import { supabase } from '@/utils/supabase'
import { gameClient, getGameServerUrl } from '@/utils/wsClient'
import type { BarOrder, DrinkMenuItem, GameplayEvent, GameplayState, ManagementPlayer, PlayerDrink, QueueEntry, RemotePlayer } from '@/utils/wsClient'
import { AvatarMini } from '@/pages/BouncerPage'
import { DJBoothPanel } from '@/pages/DJPage'

type ClubZone = 'floor' | 'dj' | 'bar' | 'vip'
type ClubFloorLevel = 'ground' | 'stairs' | 'vip'
type DanceId = GeneratedDanceId
type NearbyPlayer = { id: string; displayName: string }
type ManagementTab = 'security' | 'owner' | 'admin'

const CLUB_NAME = 'DOOR//CLUB'
const ZONE_LABELS: Record<ClubZone, string> = {
  floor: 'ТАНЦПОЛ',
  dj: 'DJ BOOTH',
  bar: 'БАР',
  vip: 'VIP',
}

const DANCE_OPTIONS: Array<{ id: DanceId; label: string; shortLabel: string }> = [
  { id: 'dance_idle_groove_01', label: '01 IDLE GROOVE', shortLabel: '01' },
  { id: 'dance_side_step_turn_02', label: '02 SIDE STEP', shortLabel: '02' },
  { id: 'dance_head_touch_groove_03', label: '03 HEAD TOUCH', shortLabel: '03' },
]
const DANCE_IDS = DANCE_OPTIONS.map((option) => option.id)
const TAU = Math.PI * 2
const VOICE_MOUTH_TEXTURE_URL = '/images/voice-mouth.png'
const DOORCLUB_ASSET_BASE = '/images/doorclub'
const CLUB_MODEL_BASE = '/models/club'
const DRINK_EFFECT_DURATION_MS = 60_000
const BAR_NEARBY_PLAYER_DISTANCE = 2.4
const MANAGEMENT_PANEL_OPEN_KEY = 'doorclub-management-panel-open'
const MANAGEMENT_PANEL_TAB_KEY = 'doorclub-management-panel-tab'
const CLUB_POSITION_SESSION_KEY = 'doorclub-club-position'
const FACE_CONTROL_REASONS = [
  { code: 'vibe_check', label: 'Вайб-чек' },
  { code: 'dress_code', label: 'Дресс-код' },
  { code: 'overcrowded', label: 'Переполнено' },
  { code: 'behavior', label: 'Поведение' },
  { code: 'closed_event', label: 'Закрыто' },
]
const DEFAULT_DRINK_MENU: DrinkMenuItem[] = [
  { id: 'smoke_spritz', name: 'Дымный спритц', price: 120, effect: 'spark' },
  { id: 'bass_tonic', name: 'Басс-тоник', price: 180, effect: 'bass' },
  { id: 'velvet_shot', name: 'Вельвет-шот', price: 240, effect: 'focus' },
  { id: 'ice_zero', name: 'Айс-зеро', price: 90, effect: 'chill' },
]

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

function isClubFloorLevel(value: unknown): value is ClubFloorLevel {
  return value === 'ground' || value === 'stairs' || value === 'vip'
}

function readStoredClubPosition(): { x: number; z: number; floorLevel: ClubFloorLevel } | null {
  try {
    const raw = sessionStorage.getItem(CLUB_POSITION_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { x?: unknown; z?: unknown; floorLevel?: unknown }
    const x = Number(parsed.x)
    const z = Number(parsed.z)
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null
    return {
      x,
      z,
      floorLevel: isClubFloorLevel(parsed.floorLevel) ? parsed.floorLevel : 'ground',
    }
  } catch {
    return null
  }
}

function writeStoredClubPosition(x: number, z: number, floorLevel: ClubFloorLevel) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return
  try {
    sessionStorage.setItem(CLUB_POSITION_SESSION_KEY, JSON.stringify({
      x: Math.round(x * 100) / 100,
      z: Math.round(z * 100) / 100,
      floorLevel,
    }))
  } catch {
    // Best-effort reconnect smoothing only.
  }
}

export default function ClubPage() {
  const navigate = useNavigate()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const displayName = usePlayerStore((s) => s.displayName)
  const role = usePlayerStore((s) => s.role)
  const clublesBalance = usePlayerStore((s) => s.clublesBalance)
  const status = usePlayerStore((s) => s.status)
  const userId = usePlayerStore((s) => s.userId)
  const avatarConfig = usePlayerStore((s) => s.avatarConfig)
  const [zone, setZone] = useState<ClubZone>('floor')
  const [danceMode, setDanceMode] = useState(false)
  const [danceMenuOpen, setDanceMenuOpen] = useState(false)
  const [selectedDance, setSelectedDance] = useState<DanceId>('dance_idle_groove_01')
  const [playerCount, setPlayerCount] = useState(1)
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null)
  const [clubEnergy, setClubEnergy] = useState(0.58)
  const [currentBpm, setCurrentBpm] = useState<number | null>(null)
  const [djPanelMinimized, setDjPanelMinimized] = useState(false)
  const [bartenderPanelOpen, setBartenderPanelOpen] = useState(false)
  const [barCustomerOpen, setBarCustomerOpen] = useState(false)
  const [facePanelOpen, setFacePanelOpen] = useState(false)
  const [managementPanelOpen, setManagementPanelOpen] = useState(readStoredManagementOpen)
  const [managementTab, setManagementTab] = useState<ManagementTab>(readStoredManagementTab)
  const [queue, setQueue] = useState<QueueEntry[]>([])
  const [drinkMenu, setDrinkMenu] = useState<DrinkMenuItem[]>(DEFAULT_DRINK_MENU)
  const [barOrders, setBarOrders] = useState<BarOrder[]>([])
  const [myDrinks, setMyDrinks] = useState<PlayerDrink[]>([])
  const [managementPlayers, setManagementPlayers] = useState<ManagementPlayer[]>([])
  const [nearbyPlayers, setNearbyPlayers] = useState<NearbyPlayer[]>([])
  const [bartenderStats, setBartenderStats] = useState({ sales: 0, tips: 0 })
  const [clubToast, setClubToast] = useState('')
  const [drinkEffect, setDrinkEffect] = useState<DrinkMenuItem['effect'] | null>(null)
  const [drinkEffectKey, setDrinkEffectKey] = useState(0)
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null)
  const [faceLog, setFaceLog] = useState<string[]>([])

  const spawnFn = useRef<(p: RemotePlayer) => void>(() => {})
  const moveFn = useRef<(id: string, x: number, z: number, rotY: number, moving: boolean, musicDanceIntensity?: number, floorLevel?: ClubFloorLevel) => void>(() => {})
  const removeFn = useRef<(id: string) => void>(() => {})
  const teleportFn = useRef<(x: number, z: number, floorLevel?: ClubFloorLevel) => void>(() => {})
  const selfPositionFn = useRef<(x: number, z: number, floorLevel?: ClubFloorLevel, rotY?: number, moving?: boolean) => void>(() => {})
  const updateRemoteRef = useRef<(id: string, faceUrl: string, bodyUrl: string, topColor: string, bottomColor: string, modelUrl?: string) => void>(() => {})
  const updateRemoteNameRef = useRef<(id: string, displayName: string) => void>(() => {})
  const updatePlayerNameRef = useRef<(displayName: string) => void>(() => {})
  const updateDjBoothNameRef = useRef<(djName: string) => void>(() => {})
  const crowdEnergyRef = useRef(0.58)
  const musicBpmRef = useRef(124)
  const musicTrackIdxRef = useRef(0)
  const musicBeatSyncRef = useRef<{ beatAtMs: number; beatIntervalSec: number; confidence: number } | null>(null)
  const musicOutputIntensityRef = useRef(0)
  const musicAudibleIntensityRef = useRef(0)
  const musicRhythmIntensityRef = useRef(0)
  const musicKickIntensityRef = useRef(0)
  const musicOnsetStrengthRef = useRef(0)
  const danceModeRef = useRef(danceMode)
  const selectedDanceRef = useRef<DanceId>(selectedDance)
  const talkingRef = useRef(false)
  const voiceLevelRef = useRef(0)
  const remoteVoiceLevelsRef = useRef(new Map<string, number>())
  const clubInputLockedRef = useRef(false)
  const wasDjRef = useRef(false)
  const drinkEffectDurationRef = useRef(DRINK_EFFECT_DURATION_MS)

  const admitted = status === 'inside' || sessionStorage.getItem('doorclub-admitted') === '1'
  const isDj = admitted && role === 'dj'
  const isBartender = admitted && role === 'bartender'
  const isFaceControl = admitted && role === 'bouncer'
  const canUseSecurityPanel = admitted && (role === 'guard' || role === 'bouncer' || role === 'owner' || role === 'admin')
  const canUseOwnerPanel = admitted && (role === 'owner' || role === 'admin')
  const canUseAdminPanel = admitted && role === 'admin'
  const canUseManagementPanel = canUseSecurityPanel || canUseOwnerPanel || canUseAdminPanel
  const canUseDjBooth = role === 'dj' || role === 'vip' || role === 'owner' || role === 'admin'
  const canUseVipMezzanine =
    role === 'vip' ||
    role === 'dj' ||
    role === 'owner' ||
    role === 'guard' ||
    role === 'bartender' ||
    role === 'bouncer' ||
    role === 'admin'
  const selectedQueueEntry = queue.find((entry) => entry.id === selectedQueueId) ?? null

  useEffect(() => {
    if (!admitted) navigate('/outside', { replace: true })
  }, [admitted, navigate])

  useEffect(() => {
    if (!admitted) return
    window.dispatchEvent(new CustomEvent('music-environment', {
      detail: { environment: 'club' }
    }))
  }, [admitted])

  useEffect(() => {
    clubInputLockedRef.current = (isDj && !djPanelMinimized) || (isBartender && bartenderPanelOpen) || (isFaceControl && facePanelOpen) || managementPanelOpen || barCustomerOpen
  }, [isDj, djPanelMinimized, isBartender, bartenderPanelOpen, isFaceControl, facePanelOpen, managementPanelOpen, barCustomerOpen])

  useEffect(() => {
    if (isDj && !wasDjRef.current) setDjPanelMinimized(false)
    wasDjRef.current = isDj
  }, [isDj])

  useEffect(() => {
    if (isBartender) setBartenderPanelOpen(true)
  }, [isBartender])

  useEffect(() => {
    if (!canUseManagementPanel) {
      setManagementPanelOpen(false)
      return
    }
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

  useEffect(() => {
    if (!clubToast) return
    const timeout = window.setTimeout(() => setClubToast(''), 3200)
    return () => window.clearTimeout(timeout)
  }, [clubToast])

  useEffect(() => {
    if (!drinkEffect) return
    const timeout = window.setTimeout(() => setDrinkEffect(null), drinkEffectDurationRef.current)
    return () => window.clearTimeout(timeout)
  }, [drinkEffect, drinkEffectKey])

  useEffect(() => {
    if (!isDj) return
    const onDjNamePreview = (event: Event) => {
      const djName = (event as CustomEvent).detail?.djName
      if (typeof djName === 'string') updateDjBoothNameRef.current(djName)
    }
    window.addEventListener('dj-name-preview', onDjNamePreview)
    return () => window.removeEventListener('dj-name-preview', onDjNamePreview)
  }, [isDj])

  useEffect(() => {
    if (!userId || avatarConfig?.faceTextureUrl) return
    supabase.from('avatars').select('config_json').eq('user_id', userId).single()
      .then(({ data }) => {
        if (data?.config_json) usePlayerStore.getState().setAvatarConfig(data.config_json as any)
      })
  }, [userId, avatarConfig?.faceTextureUrl])

  useEffect(() => {
    crowdEnergyRef.current = clubEnergy
  }, [clubEnergy])

  useEffect(() => {
    danceModeRef.current = danceMode
  }, [danceMode])

  useEffect(() => {
    selectedDanceRef.current = selectedDance
  }, [selectedDance])

  useEffect(() => {
    if (!admitted) return
    const onDjState = (e: Event) => {
      const { active } = (e as CustomEvent).detail ?? {}
      if (active) {
        setClubEnergy((energy) => Math.min(1, energy + 0.12))
      }
    }
    window.addEventListener('dj-stream-state', onDjState)
    return () => window.removeEventListener('dj-stream-state', onDjState)
  }, [admitted])

  useEffect(() => {
    if (!admitted) return

    const onBpm = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {}
      const bpm = detail.bpm
      if (typeof bpm !== 'number' || !Number.isFinite(bpm)) {
        setCurrentBpm(null)
        musicBeatSyncRef.current = null
        return
      }
      const nextBpm = Math.max(60, Math.min(180, bpm))
      musicBpmRef.current = nextBpm
      setCurrentBpm(Math.round(nextBpm * 10) / 10)
      if (typeof detail.trackIdx === 'number' && Number.isFinite(detail.trackIdx)) {
        musicTrackIdxRef.current = Math.max(0, Math.floor(detail.trackIdx))
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
      const rhythmIntensity = detail.rhythmIntensity
      if (typeof rhythmIntensity === 'number' && Number.isFinite(rhythmIntensity)) {
        musicRhythmIntensityRef.current = Math.max(0, Math.min(1, rhythmIntensity))
      }
      const kickIntensity = detail.kickIntensity
      if (typeof kickIntensity === 'number' && Number.isFinite(kickIntensity)) {
        musicKickIntensityRef.current = Math.max(0, Math.min(1, kickIntensity))
      }
      const onsetStrength = detail.onsetStrength
      if (typeof onsetStrength === 'number' && Number.isFinite(onsetStrength)) {
        musicOnsetStrengthRef.current = Math.max(0, Math.min(1, onsetStrength))
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
  }, [admitted])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !admitted) return

    const store = usePlayerStore.getState()
    const config = store.avatarConfig

    const getRenderSize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect?.width || window.innerWidth))
      const height = Math.max(1, Math.round(rect?.height || window.visualViewport?.height || window.innerHeight))
      return { width, height }
    }
    const initialSize = getRenderSize()
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.35))
    renderer.setSize(initialSize.width, initialSize.height, false)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.08

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x050403)
    scene.fog = new THREE.FogExp2(0x080705, 0.026)

    const camera = new THREE.PerspectiveCamera(62, initialSize.width / initialSize.height, 0.1, 90)

    const ambient = new THREE.AmbientLight(0x24190f, 1.45)
    scene.add(ambient)

    const architecturalFill = new THREE.HemisphereLight(0x7a6042, 0x151009, 0.66)
    scene.add(architecturalFill)

    const longWarmFill = new THREE.DirectionalLight(0xc08f5a, 0.42)
    longWarmFill.position.set(-5.8, 7.2, 7.4)
    scene.add(longWarmFill)

    const longOliveFill = new THREE.DirectionalLight(0x536a45, 0.38)
    longOliveFill.position.set(7.4, 5.6, -8.4)
    scene.add(longOliveFill)

    const lowWarmWash = new THREE.PointLight(0x9a6739, 3.4, 62, 0.62)
    lowWarmWash.position.set(0, 3.3, -3.2)
    scene.add(lowWarmWash)

    const vipWarmLight = new THREE.PointLight(0xd88942, 3.4, 48, 0.74)
    vipWarmLight.position.set(-10.4, 2.55, -1.2)
    scene.add(vipWarmLight)

    const mezzanineWarmLight = new THREE.PointLight(0xc58a4b, 3.2, 52, 0.74)
    mezzanineWarmLight.position.set(0, 4.55, -13.2)
    scene.add(mezzanineWarmLight)

    const barWarmLight = new THREE.PointLight(0xe09a54, 3.4, 48, 0.74)
    barWarmLight.position.set(11.7, 2.35, 0.25)
    scene.add(barWarmLight)

    const djBoothGlow = new THREE.PointLight(0xb88755, 3.2, 45, 0.68)
    djBoothGlow.position.set(0, 2.7, -8.7)
    scene.add(djBoothGlow)

    const oliveRoomWash = new THREE.PointLight(0x5d7a4a, 3.4, 64, 0.72)
    oliveRoomWash.position.set(-5.8, 2.7, 4.2)
    scene.add(oliveRoomWash)

    const centralFloorFill = new THREE.PointLight(0xb56e3a, 0, 62, 0.48)
    centralFloorFill.position.set(0, 1.15, 0.8)
    scene.add(centralFloorFill)

    const rearFloorFill = new THREE.PointLight(0x7d744b, 0, 58, 0.5)
    rearFloorFill.position.set(0, 1.35, -10.8)
    scene.add(rearFloorFill)

    const amberBeaconFill = new THREE.AmbientLight(0xff6d1a, 0)
    scene.add(amberBeaconFill)

    const greenBeaconFill = new THREE.AmbientLight(0x0d5f2d, 0)
    scene.add(greenBeaconFill)

    const redBreakdownFill = new THREE.AmbientLight(0xb40013, 0)
    scene.add(redBreakdownFill)

    const amberBeaconFlood = new THREE.DirectionalLight(0xff6d1a, 0)
    amberBeaconFlood.position.set(5.8, 8.5, 6.2)
    scene.add(amberBeaconFlood)

    const greenBeaconFlood = new THREE.DirectionalLight(0x0d5f2d, 0)
    greenBeaconFlood.position.set(-5.8, 8.5, 4.2)
    scene.add(greenBeaconFlood)

    const redBreakdownFlood = new THREE.DirectionalLight(0xc40018, 0)
    redBreakdownFlood.position.set(0, 8.2, 6.8)
    scene.add(redBreakdownFlood)

    const strobeLight = new THREE.PointLight(0xf2eee2, 0, 72, 0.88)
    strobeLight.position.set(0, 7.4, -1.2)
    scene.add(strobeLight)

    const strobeBackLight = new THREE.PointLight(0xf8f4e7, 0, 64, 0.88)
    strobeBackLight.position.set(0, 6.5, -10.8)
    scene.add(strobeBackLight)

    const floorReadTarget = new THREE.Object3D()
    floorReadTarget.position.set(0, 0.04, -0.4)
    scene.add(floorReadTarget)
    const floorReadWash = new THREE.SpotLight(0xc9a46f, 0, 48, 1.05, 0.82, 0.62)
    floorReadWash.position.set(0, 6.7, -1.6)
    floorReadWash.target = floorReadTarget
    scene.add(floorReadWash)

    const djDeckGreenTarget = new THREE.Object3D()
    djDeckGreenTarget.position.set(0, 1.62, -6.56)
    scene.add(djDeckGreenTarget)
    const djDeckGreenSpot = new THREE.SpotLight(0x0dff72, 8.2, 18, 0.42, 0.58, 0.8)
    djDeckGreenSpot.position.set(0, 4.45, -5.7)
    djDeckGreenSpot.target = djDeckGreenTarget
    scene.add(djDeckGreenSpot)

    const disposables: Array<{ dispose: () => void }> = []
    const nameTags: THREE.Object3D[] = []
    const danceTiles: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>[] = []
    const beams: THREE.Mesh[] = []
    const beaconMeshes: THREE.Mesh[] = []
    const amberBeaconLights: THREE.SpotLight[] = []
    const greenBeaconLights: THREE.SpotLight[] = []
    const redBreakdownLights: THREE.SpotLight[] = []
    const beaconTargets: THREE.Object3D[] = []
    const beaconConeMeshes: THREE.Mesh[] = []
    const dancerGroups: THREE.Group[] = []
    const smokeSprites: THREE.Sprite[] = []
    const lowCoveLights: THREE.PointLight[] = []
    const architecturalGlowMaterials: THREE.MeshBasicMaterial[] = []
    const floorEqualizerStrips: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>[] = []

    function track<T extends { dispose: () => void }>(item: T): T {
      disposables.push(item)
      return item
    }

    function mat(color: number, emissive = 0x000000, emissiveIntensity = 0) {
      return track(new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity }))
    }

    function basic(color: number, opacity = 1) {
      return track(new THREE.MeshBasicMaterial({
        color,
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity >= 1,
      }))
    }

    function glowMaterial(color: number, opacity = 0.36) {
      const material = track(new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }))
      material.userData.baseOpacity = opacity
      architecturalGlowMaterials.push(material)
      return material
    }

    function box(
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      material: THREE.Material,
      parent: THREE.Object3D = scene,
    ) {
      const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), material)
      mesh.position.set(x, y, z)
      parent.add(mesh)
      return mesh
    }

    const textureLoader = new THREE.TextureLoader()
    const modelLoader = new GLTFLoader()
    const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
    let sceneDisposed = false

    function doorclubTexture(file: string, repeatX = 1, repeatY = 1) {
      const texture = track(textureLoader.load(`${DOORCLUB_ASSET_BASE}/${file}`))
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = maxAnisotropy
      if (repeatX !== 1 || repeatY !== 1) {
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping
        texture.repeat.set(repeatX, repeatY)
      }
      return texture
    }

    function textureMat(file: string, repeatX = 1, repeatY = 1, emissive = 0x000000, emissiveIntensity = 0) {
      return track(new THREE.MeshLambertMaterial({
        color: 0xffffff,
        map: doorclubTexture(file, repeatX, repeatY),
        emissive,
        emissiveIntensity,
      }))
    }

    function boxWithFrontTexture(
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      sideMaterial: THREE.Material,
      frontTextureFile: string,
      frontMaterialIndex: number,
      parent: THREE.Object3D = scene,
    ) {
      const frontMaterial = textureMat(frontTextureFile, 1, 1, 0x070604, 0.04)
      const materials = Array.from({ length: 6 }, () => sideMaterial)
      materials[frontMaterialIndex] = frontMaterial
      const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), materials)
      mesh.position.set(x, y, z)
      parent.add(mesh)
      return mesh
    }

    function texturePlane(
      file: string,
      w: number,
      h: number,
      x: number,
      y: number,
      z: number,
      rotY = 0,
      _emissiveIntensity = 0.16,
    ) {
      const mesh = new THREE.Mesh(
        track(new THREE.PlaneGeometry(w, h)),
        track(new THREE.MeshBasicMaterial({
          color: 0xffffff,
          map: doorclubTexture(file),
          side: THREE.DoubleSide,
          toneMapped: false,
        })),
      )
      mesh.position.set(x, y, z)
      mesh.rotation.y = rotY
      scene.add(mesh)
      return mesh
    }

    function atlasTexture(file: string, x: number, y: number, w: number, h: number) {
      const texture = doorclubTexture(file)
      texture.wrapS = THREE.ClampToEdgeWrapping
      texture.wrapT = THREE.ClampToEdgeWrapping
      texture.repeat.set(w, h)
      texture.offset.set(x, 1 - y - h)
      texture.needsUpdate = true
      return texture
    }

    function atlasPlane(
      file: string,
      cropX: number,
      cropY: number,
      cropW: number,
      cropH: number,
      w: number,
      h: number,
      x: number,
      y: number,
      z: number,
      rotY = 0,
      _emissiveIntensity = 0.2,
    ) {
      const mesh = new THREE.Mesh(
        track(new THREE.PlaneGeometry(w, h)),
        track(new THREE.MeshBasicMaterial({
          color: 0xffffff,
          map: atlasTexture(file, cropX, cropY, cropW, cropH),
          side: THREE.DoubleSide,
          toneMapped: false,
        })),
      )
      mesh.position.set(x, y, z)
      mesh.rotation.y = rotY
      scene.add(mesh)
      return mesh
    }

    function disposeLoadedObject(root: THREE.Object3D) {
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry?.dispose()
        const material = mesh.material
        if (Array.isArray(material)) material.forEach((m) => m.dispose())
        else material?.dispose()
      })
    }

    function loadStageModel(
      file: string,
      options: {
        x: number
        y: number
        z: number
        width?: number
        height?: number
        depth?: number
        fitBy?: 'width' | 'height' | 'depth'
        rotX?: number
        rotY?: number
        rotZ?: number
      },
    ) {
      modelLoader.load(
        `${CLUB_MODEL_BASE}/${file}`,
        (gltf) => {
          const model = gltf.scene
          model.rotation.set(options.rotX ?? 0, options.rotY ?? 0, options.rotZ ?? 0)
          model.traverse((obj) => {
            const mesh = obj as THREE.Mesh
            if (mesh.isMesh) mesh.frustumCulled = false
          })
          model.updateMatrixWorld(true)

          const initialBox = new THREE.Box3().setFromObject(model)
          const initialSize = initialBox.getSize(new THREE.Vector3())
          let scale = 1
          if (options.fitBy === 'width' && options.width && initialSize.x > 0) {
            scale = options.width / initialSize.x
          } else if (options.fitBy === 'height' && options.height && initialSize.y > 0) {
            scale = options.height / initialSize.y
          } else if (options.fitBy === 'depth' && options.depth && initialSize.z > 0) {
            scale = options.depth / initialSize.z
          } else {
            const scaleLimits = [
              options.width && initialSize.x > 0 ? options.width / initialSize.x : Infinity,
              options.height && initialSize.y > 0 ? options.height / initialSize.y : Infinity,
              options.depth && initialSize.z > 0 ? options.depth / initialSize.z : Infinity,
            ].filter(Number.isFinite)
            scale = scaleLimits.length > 0 ? Math.min(...scaleLimits) : 1
          }
          if (scale > 0 && Number.isFinite(scale)) model.scale.multiplyScalar(scale)
          model.updateMatrixWorld(true)

          const fittedBox = new THREE.Box3().setFromObject(model)
          const fittedCenter = fittedBox.getCenter(new THREE.Vector3())
          model.position.add(new THREE.Vector3(
            options.x - fittedCenter.x,
            options.y - fittedBox.min.y,
            options.z - fittedCenter.z,
          ))

          if (sceneDisposed) {
            disposeLoadedObject(model)
            return
          }
          scene.add(model)
        },
        undefined,
        (error) => console.warn(`Club model failed to load: ${file}`, error),
      )
    }

    const floorMat = textureMat('doorclub_polished_concrete_dance_floor_tile_2048.png', 3.4, 3.2)
    floorMat.color.setHex(0x777168)
    const wallMat = textureMat('doorclub_interior_concrete_greenery_wall_tile_2048.png', 2.3, 1.35, 0x060806, 0.04)
    const blackMat = mat(0x07070c)
    const concreteMat = textureMat('doorclub_concrete_ivy_living_wall_tile_2048.png', 1.25, 1.25, 0x080806, 0.05)
    const railMat = mat(0x252432, 0x080816, 0.4)
    const chromeMat = mat(0x3e4656, 0x101525, 0.7)
    const redSeatMat = mat(0x263229, 0x0b160c, 0.35)
    const voiceMouthTexture = track(new THREE.TextureLoader().load(VOICE_MOUTH_TEXTURE_URL))
    voiceMouthTexture.colorSpace = THREE.SRGBColorSpace
    voiceMouthTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())

    const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(34, 32)), floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.01
    scene.add(floor)

    box(34, 9.6, 0.6, 0, 4.8, -14.4, wallMat)
    box(0.6, 9.6, 32, -16.8, 4.8, 1, wallMat)
    box(0.6, 9.6, 32, 16.8, 4.8, 1, wallMat)
    box(34, 0.5, 32, 0, 9.45, 1, mat(0x0b0b13))
    texturePlane('doorclub_interior_concrete_greenery_wall_tile_2048.png', 33.6, 9.4, 0, 4.75, -14.07, 0, 0.08)
    texturePlane('doorclub_concrete_ivy_living_wall_tile_2048.png', 31.6, 9.4, -16.46, 4.75, 0.9, Math.PI / 2, 0.06)
    texturePlane('doorclub_concrete_ivy_living_wall_tile_2048.png', 31.6, 9.4, 16.46, 4.75, 0.9, -Math.PI / 2, 0.06)

    const dancePalette = [0x090907, 0x11100c, 0x17130d, 0x10160f]

    buildArchitecturalLowLighting()
    buildDjBooth()
    buildBar()
    buildVip()
    buildLightingRig()
    buildSmoke()

    createNeonSign(CLUB_NAME, 7.5, 1.1, '#d9c093', 0, 5.45, -14.06)
    createNeonSign('BAR', 3.2, 0.9, '#b86524', 11.25, 3.65, -4.7, -Math.PI / 2)
    createNeonSign('VIP', 2.8, 0.9, '#426b43', -11.6, 3.15, -5.25, Math.PI / 2)
    const djBoothSign = createNeonSign('DJ', 5.4, 0.75, '#d8c7a0', 0, 2.55, -7.2, 0, false)
    updateDjBoothNameRef.current = (djName: string) => {
      setNeonSignText(djBoothSign, djName || 'DJ', '#d8c7a0')
    }
    if (role === 'dj') updateDjBoothNameRef.current(store.djName || store.displayName || 'DJ')

    const toHex = (s: string | null | undefined, fallback: number): number => {
      if (!s) return fallback
      const rgb = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
      if (rgb) return (parseInt(rgb[1]) << 16) | (parseInt(rgb[2]) << 8) | parseInt(rgb[3])
      const n = parseInt(s.replace('#', ''), 16)
      return Number.isNaN(n) ? fallback : n
    }

    function makeMouth() {
      const mouth = new THREE.Mesh(
        track(new THREE.PlaneGeometry(0.38, 0.205)),
        track(new THREE.MeshBasicMaterial({
          map: voiceMouthTexture,
          transparent: true,
          opacity: 0,
          alphaTest: 0.02,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        })),
      )
      mouth.position.set(0, 1.78, 0.235)
      mouth.userData.isMouth = true
      return mouth
    }

    function makeCharacter(
      topColor: number,
      bottomColor: number,
      skinTone: number,
      hairColor: number,
      x: number,
      z: number,
      parent: THREE.Object3D = scene,
    ) {
      const group = new THREE.Group()
      group.position.set(x, 0, z)
      parent.add(group)

      const skin = mat(skinTone)
      const top = mat(topColor)
      const bottom = mat(bottomColor)
      const hair = mat(hairColor)
      const shoes = mat(0x09090b)

      const torso = box(0.55, 0.75, 0.3, 0, 1.3, 0, top, group)
      torso.userData.zone = 'top'

      const headGeo = track(new THREE.SphereGeometry(0.21, 8, 6))
      headGeo.scale(0.95, 1.1, 0.9)
      const head = new THREE.Mesh(headGeo, skin)
      head.position.set(0, 1.86, 0)
      head.userData.part = 'head'
      group.add(head)
      const mouth = makeMouth()
      group.add(mouth)

      const hairGeo = track(new THREE.SphereGeometry(0.215, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.52))
      const hairMesh = new THREE.Mesh(hairGeo, hair)
      hairMesh.position.set(0, 1.99, -0.04)
      group.add(hairMesh)

      function makeArm(side: -1 | 1) {
        const arm = new THREE.Group()
        arm.position.set(0.33 * side, 1.5, 0)
        arm.rotation.z = -0.16 * side
        group.add(arm)

        const sleeve = box(0.18, 0.65, 0.18, 0, -0.325, 0, top, arm)
        sleeve.userData.zone = 'top'
        box(0.16, 0.18, 0.16, 0, -0.69, 0, skin, arm)
        return arm
      }

      const armL = makeArm(-1)
      const armR = makeArm(1)

      const legL = box(0.23, 0.75, 0.23, -0.15, 0.6, 0, bottom, group)
      const legR = box(0.23, 0.75, 0.23, 0.15, 0.6, 0, bottom, group)
      legL.userData.zone = 'bottom'
      legR.userData.zone = 'bottom'

      const shoeL = box(0.24, 0.16, 0.3, -0.15, 0.16, 0.04, shoes, group)
      const shoeR = box(0.24, 0.16, 0.3, 0.15, 0.16, 0.04, shoes, group)
      shoeL.userData.zone = 'shoes'
      shoeR.userData.zone = 'shoes'

      group.userData.limbs = { torso, armL, armR, legL, legR, shoeL, shoeR, head, hairMesh, mouth }
      return group
    }

    function makeNameTag(name: string) {
      const cv = document.createElement('canvas')
      cv.width = 256
      cv.height = 48
      const ctx = cv.getContext('2d')!
      ctx.clearRect(0, 0, 256, 48)
      ctx.shadowColor = '#d8b06f'
      ctx.shadowBlur = 7
      ctx.fillStyle = '#d8d0c2'
      ctx.font = 'bold 19px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(name.slice(0, 14), 128, 24)
      const texture = track(new THREE.CanvasTexture(cv))
      texture.colorSpace = THREE.SRGBColorSpace
      const mesh = new THREE.Mesh(
        track(new THREE.PlaneGeometry(1.45, 0.27)),
        track(new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })),
      )
      mesh.position.set(0, 2.55, 0)
      mesh.userData.billboard = true
      mesh.userData.isNameTag = true
      nameTags.push(mesh)
      return mesh
    }

    function removeNameTag(group: THREE.Group) {
      const tag = group.children.find((child) => child.userData.isNameTag)
      if (!tag) return
      group.remove(tag)
      const idx = nameTags.indexOf(tag)
      if (idx !== -1) nameTags.splice(idx, 1)
    }

    function setNameTag(group: THREE.Group, name: string) {
      removeNameTag(group)
      group.add(makeNameTag(name || 'GUEST'))
    }

    function applyFaceTex(group: THREE.Group, faceUrl: string | null | undefined) {
      if (!faceUrl) return
      const img = new Image()
      img.onload = () => {
        const cv = document.createElement('canvas')
        cv.width = 256
        cv.height = 256
        const ctx = cv.getContext('2d')!
        ctx.imageSmoothingEnabled = false
        ctx.fillStyle = '#c8956c'
        ctx.fillRect(0, 0, 256, 256)
        ctx.drawImage(img, 0, 0, 256, 256)
        const texture = track(new THREE.CanvasTexture(cv))
        texture.colorSpace = THREE.SRGBColorSpace
        texture.magFilter = THREE.NearestFilter
        texture.minFilter = THREE.NearestFilter
        const material = track(new THREE.MeshLambertMaterial({ map: texture }))
        group.traverse((obj) => {
          const mesh = obj as THREE.Mesh
          if (mesh.isMesh && mesh.userData.part === 'head') mesh.material = material
        })
      }
      img.src = faceUrl
    }

    function applyBodyTex(group: THREE.Group, bodyUrl: string | null | undefined) {
      void group
      void bodyUrl
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

    function loadGeneratedAvatarModel(group: THREE.Group, modelUrl: string) {
      if (group.userData.generatedModelUrl === modelUrl || group.userData.pendingGeneratedModelUrl === modelUrl) return
      group.userData.pendingGeneratedModelUrl = modelUrl
      void loadGeneratedAvatarRig(modelUrl, { rotationY: Math.PI, targetHeight: 2.15 })
        .then((rig) => {
          if (group.userData.pendingGeneratedModelUrl !== modelUrl) return
          const previousModel = group.userData.generatedModel as THREE.Object3D | undefined
          if (previousModel?.parent === group) group.remove(previousModel)
          forceGeneratedAvatarVisible(rig.root)
          group.children.forEach((child) => {
            if (!child.userData.isNameTag && !child.userData.isMouth) child.visible = false
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
          console.warn('[Club avatar] GLB load failed:', loadError)
        })
    }

    function setShoes(group: THREE.Group, color: number) {
      group.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.isMesh && mesh.userData.zone === 'shoes') mesh.material = mat(color)
      })
    }

    const player = makeCharacter(
      toHex(config?.topColor, 0x222244),
      toHex(config?.bottomColor, 0x111133),
      toHex(config?.skinTone, 0xc8956c),
      toHex(config?.hairColor, 0x1a1008),
      0,
      4.8,
    )
    applyAvatarFacingRotation(player, 0)
    setShoes(player, toHex(config?.shoesColor, 0x0d0d0d))
    applyFaceTex(player, config?.faceTextureUrl)
    applyBodyTex(player, config?.bodyTextureUrl)
    if (role !== 'dj') setNameTag(player, store.displayName || 'АНОНИМ')
    if (config?.modelUrl) loadGeneratedAvatarModel(player, config.modelUrl)

    const dancerData = [
      [-3.8, -0.2, 0x35145a, 0x15152a, 0xae7757, 0x140807],
      [-2.2, 1.7, 0x0e3f55, 0x10131d, 0xd1a277, 0x21110a],
      [-0.7, -1.2, 0x5a1630, 0x151018, 0x8f6148, 0x050505],
      [1.1, 1.2, 0x17194a, 0x090c20, 0xc89068, 0x3a1808],
      [2.8, -0.5, 0x21410e, 0x11151b, 0x6d4b35, 0x101010],
      [4.1, 1.8, 0x473111, 0x121018, 0xc9a083, 0x111111],
      [-8.2, 2.7, 0x241a45, 0x11111a, 0xb8845d, 0x201007],
      [-9.8, -1.2, 0x143636, 0x0f1520, 0xd4ad86, 0x2b180d],
    ] as const

    dancerData.forEach((d, i) => {
      const dancer = makeCharacter(d[2], d[3], d[4], d[5], d[0], d[1])
      dancer.rotation.y = Math.random() * Math.PI * 2
      dancer.userData.phase = i * 0.91
      dancerGroups.push(dancer)
    })

    const remotePlayers = new Map<string, THREE.Group>()

    spawnFn.current = (p) => {
      if (remotePlayers.has(p.id)) return
      const remote = makeCharacter(
        toHex(p.topColor, 0x222244),
        toHex(p.bottomColor, 0x111133),
        toHex(p.skinTone, 0xc8956c),
        toHex(p.hairColor, 0x1a1008),
        p.x,
        p.z,
      )
      applyAvatarFacingRotation(remote, p.rotY ?? 0)
      remote.userData.tx = p.x
      remote.userData.tz = p.z
      remote.userData.rotY = p.rotY ?? 0
      remote.userData.floorLevel = p.floorLevel ?? 'ground'
      remote.userData.moving = Boolean(p.moving)
      setVisualStopTurn(remote, false)
      remote.userData.displayName = p.displayName
      remote.userData.musicDanceIntensity = Math.max(0, Math.min(1, p.musicDanceIntensity ?? 0))
      remote.userData.walkT = Math.random() * 10
      remote.userData.phase = Math.random() * Math.PI * 2
      remote.userData.danceId = DANCE_IDS[Math.floor(Math.random() * DANCE_IDS.length)]
      if (p.faceTextureUrl) applyFaceTex(remote, p.faceTextureUrl)
      if (p.bodyTextureUrl) applyBodyTex(remote, p.bodyTextureUrl)
      remote.userData.role = p.role || 'guest'
      if (p.role === 'dj') updateDjBoothNameRef.current(p.djName || p.displayName || 'DJ')
      else setNameTag(remote, p.displayName)
      if (p.modelUrl) loadGeneratedAvatarModel(remote, p.modelUrl)
      remotePlayers.set(p.id, remote)
    }

    moveFn.current = (id, x, z, rotY, moving, musicDanceIntensity, floorLevel) => {
      const remote = remotePlayers.get(id)
      if (!remote) return
      const wasRemoteMoving = Boolean(remote.userData.moving)
      remote.userData.tx = x
      remote.userData.tz = z
      remote.userData.rotY = rotY
      remote.userData.floorLevel = floorLevel ?? 'ground'
      remote.userData.moving = moving
      if (moving) setVisualStopTurn(remote, false)
      else if (wasRemoteMoving) setVisualStopTurn(remote, true)
      if (typeof musicDanceIntensity === 'number' && Number.isFinite(musicDanceIntensity)) {
        remote.userData.musicDanceIntensity = Math.max(0, Math.min(1, musicDanceIntensity))
      }
      if (moving) delete remote.userData.danceBaseRotY
    }

    removeFn.current = (id) => {
      const remote = remotePlayers.get(id)
      if (!remote) return
      scene.remove(remote)
      remotePlayers.delete(id)
    }

    updateRemoteRef.current = (id, faceUrl, bodyUrl, topColor, bottomColor, modelUrl) => {
      const remote = remotePlayers.get(id)
      if (!remote) return
      remote.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        if (mesh.userData.zone === 'top') mesh.material = mat(toHex(topColor, 0x222244))
        if (mesh.userData.zone === 'bottom') mesh.material = mat(toHex(bottomColor, 0x111133))
      })
      if (faceUrl) applyFaceTex(remote, faceUrl)
      if (bodyUrl) applyBodyTex(remote, bodyUrl)
      if (modelUrl) loadGeneratedAvatarModel(remote, modelUrl)
    }

    updateRemoteNameRef.current = (id, displayName) => {
      const remote = remotePlayers.get(id)
      if (!remote) return
      remote.userData.displayName = displayName
      if (remote.userData.role === 'dj') {
        updateDjBoothNameRef.current(displayName || 'DJ')
        return
      }
      setNameTag(remote, displayName)
    }

    updatePlayerNameRef.current = (displayName) => {
      if (role === 'dj') {
        updateDjBoothNameRef.current(displayName || 'DJ')
        return
      }
      setNameTag(player, displayName)
    }

    const keys: Record<string, boolean> = {}
    const joystick = { x: 0, z: 0 }
    const clearMovementInput = () => {
      Object.keys(keys).forEach((key) => { keys[key] = false })
      joystick.x = 0
      joystick.z = 0
    }
    const isTextInputTarget = (target: EventTarget | null) => {
      return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (clubInputLockedRef.current || isTextInputTarget(e.target)) {
        clearMovementInput()
        return
      }
      keys[e.key.toLowerCase()] = true
    }
    const onKeyUp = (e: KeyboardEvent) => { keys[e.key.toLowerCase()] = false }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    ;(window as any).__clubJoy = (x: number, z: number) => {
      if (clubInputLockedRef.current) {
        clearMovementInput()
        return
      }
      joystick.x = x
      joystick.z = z
    }

    const cam = { yaw: 0, pitch: 0.22, dist: 7.2 }
    const setCameraDistance = (dist: number) => {
      cam.dist = Math.max(3.2, Math.min(12, dist))
    }
    let rightMouse = false
    let lastMouseX = 0
    let lastMouseY = 0
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2) {
        rightMouse = true
        lastMouseX = e.clientX
        lastMouseY = e.clientY
      }
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!rightMouse) return
      cam.yaw -= (e.clientX - lastMouseX) * 0.005
      cam.pitch = Math.max(-0.25, Math.min(1.2, cam.pitch - (e.clientY - lastMouseY) * 0.004))
      lastMouseX = e.clientX
      lastMouseY = e.clientY
    }
    const onMouseUp = () => { rightMouse = false }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setCameraDistance(cam.dist + e.deltaY * 0.006)
    }
    const onContextMenu = (e: MouseEvent) => e.preventDefault()
    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContextMenu)

    let touchLook: { id: number; x: number; y: number } | null = null
    let pinch: { distance: number; camDist: number } | null = null
    const touchDistance = (touches: TouchList) => {
      const a = touches[0]
      const b = touches[1]
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    }
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        pinch = { distance: touchDistance(e.touches), camDist: cam.dist }
        touchLook = null
        return
      }
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX > window.innerWidth * 0.42 && !touchLook) touchLook = { id: t.identifier, x: t.clientX, y: t.clientY }
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length >= 2 && pinch) {
        e.preventDefault()
        setCameraDistance(pinch.camDist * (pinch.distance / Math.max(1, touchDistance(e.touches))))
        return
      }
      if (!touchLook) return
      const look = touchLook
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === look.id) {
          cam.yaw -= (t.clientX - look.x) * 0.005
          cam.pitch = Math.max(-0.25, Math.min(1.2, cam.pitch - (t.clientY - look.y) * 0.004))
          look.x = t.clientX
          look.y = t.clientY
        }
      }
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null
      if (!touchLook) return
      const look = touchLook
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === look.id) touchLook = null
      }
    }
    canvas.addEventListener('touchstart', onTouchStart, { passive: true })
    canvas.addEventListener('touchmove', onTouchMove, { passive: false })
    canvas.addEventListener('touchend', onTouchEnd, { passive: true })

    const storedClubPosition = readStoredClubPosition()
    const pos = new THREE.Vector3(storedClubPosition?.x ?? 0, 0, storedClubPosition?.z ?? 4.8)
    const serverCorrection = { active: false, x: pos.x, z: pos.z }
    let selfFloorLevel: ClubFloorLevel = storedClubPosition?.floorLevel ?? 'ground'
    const selfCanUseDjBooth = canUseDjBooth
    const selfCanUseVipMezzanine = canUseVipMezzanine
    let lastStoredPositionAt = 0
    const rememberSelfPosition = (nowMs = performance.now()) => {
      if (nowMs - lastStoredPositionAt < 350) return
      lastStoredPositionAt = nowMs
      writeStoredClubPosition(pos.x, pos.z, selfFloorLevel)
    }
    teleportFn.current = (x, z, floorLevel = 'ground') => {
      serverCorrection.active = false
      pos.x = x
      pos.z = z
      selfFloorLevel = floorLevel
      player.position.set(x, floorHeightAt(x, z, selfFloorLevel), z)
      writeStoredClubPosition(pos.x, pos.z, selfFloorLevel)
    }
    selfPositionFn.current = (x, z, floorLevel = 'ground', rotY, _moving = true) => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return
      if (typeof rotY === 'number' && Number.isFinite(rotY)) {
        lastMoveRotY = rotY
        applyAvatarFacingRotation(player, lastMoveRotY)
      }
      const distance = Math.hypot(x - pos.x, z - pos.z)
      if (distance > 4.5) {
        teleportFn.current(x, z, floorLevel)
        return
      }
      serverCorrection.active = true
      serverCorrection.x = x
      serverCorrection.z = z
      selfFloorLevel = floorLevel
    }
    const clock = new THREE.Clock()
    const lastZoneRef = { current: zoneFromPos(pos.x, pos.z, selfFloorLevel) }
    const PLAYER_RADIUS = 0.93
    const PLAYER_COLLISION_EPS = 0.001
    const PLAYER_COLLISION_PUSH = 0.015
    let walkT = 0
    let moveRamp = 0
    let sendZoneT = 0
    let sendMoveT = 0
    let voiceT = 0
    let nearbyT = 0
    let musicPhase = 0
    let lastMusicOutput = 0
    let lastKickIntensity = 0
    let transientEnergy = 0
    let kickFlash = 0
    let rhythmGlow = 0
    let smokeBurst = 0
    let smokeEmissionCarry = 0
    let smokeCursor = 0
    let lastSmokeDropSlot = -1
    let lastMoveRotY = 0
    let wasMoving = false
    let animId = 0
    const coneUpAxis = new THREE.Vector3(0, 1, 0)

    function musicDanceIntensity(baseIntensity: number) {
      const heardMusic = Math.max(0, Math.min(1, musicOutputIntensityRef.current))
      const audibleMusic = Math.max(0, Math.min(1, musicAudibleIntensityRef.current))
      return Math.max(0, Math.min(1, baseIntensity * Math.pow(heardMusic, 0.82) * audibleMusic))
    }

    function wrapPhase(value: number) {
      return Math.atan2(Math.sin(value), Math.cos(value))
    }

    function setVisualStopTurn(group: THREE.Group, enabled: boolean) {
      group.userData.visualStopTurnOffsetY = enabled ? Math.PI : 0
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

    function beatDistance(value: number, target: number, cycle = 1) {
      const raw = Math.abs(((value - target) % cycle + cycle) % cycle)
      return Math.min(raw, cycle - raw)
    }

    function beatPulse(value: number, target: number, width: number, cycle = 1) {
      return Math.pow(Math.max(0, 1 - beatDistance(value, target, cycle) / width), 2.2)
    }

    function seededUnit(seed: number) {
      const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
      return value - Math.floor(value)
    }

    function deterministicStrobeMode(beatCount: number) {
      const slot = Math.floor(beatCount / 8)
      const trackSeed = musicTrackIdxRef.current * 1009
      const seed = trackSeed + slot * 37 + 11
      const previousSeed = trackSeed + (slot - 1) * 37 + 11
      let mode = Math.floor(seededUnit(seed) * 10)
      const previousMode = Math.floor(seededUnit(previousSeed) * 10)
      if (mode === previousMode) mode = (mode + 1 + Math.floor(seededUnit(seed + 5) * 8)) % 10
      return mode
    }

    function strobePattern(mode: number, beatCount: number, transient: number) {
      const beat1 = ((beatCount % 1) + 1) % 1
      const beat2 = ((beatCount % 2) + 2) % 2
      const beat4 = ((beatCount % 4) + 4) % 4
      const beat8 = ((beatCount % 8) + 8) % 8

      switch (mode) {
        case 0: return beatPulse(beat1, 0, 0.038)
        case 1: return Math.max(beatPulse(beat4, 1, 0.048, 4), beatPulse(beat4, 3, 0.048, 4))
        case 2: return beatPulse(beatCount % 0.5, 0, 0.026, 0.5) * 0.78
        case 3: return transient > 0.18 ? Math.max(beatPulse(beatCount % 0.25, 0, 0.016, 0.25), transient * 0.72) : 0
        case 4: return Math.max(0, Math.min(1, beat4 / 3.75)) * beatPulse(beat1, 0, 0.04)
        case 5: return Math.max(0, 1 - beat4 / 3.75) * beatPulse(beat1, 0, 0.04)
        case 6: return seededUnit(musicTrackIdxRef.current * 2003 + Math.floor(beatCount * 8)) > 0.982 - transient * 0.018 ? 1 : 0
        case 7: return Math.max(beatPulse(beat2, 0, 0.046, 2), beatPulse(beat2, 1, 0.046, 2))
        case 8: return beatPulse(beat8, Math.floor(beat8) + 0.02, 0.036, 8)
        case 9: return Math.max(beatPulse(beat8, 0, 0.07, 8) * 1.1, transient * 0.58)
        default: return 0
      }
    }

    function strobeZoneGate(mode: number, zone: number, beatCount: number) {
      if (mode === 7) return (zone + Math.floor(beatCount * 2)) % 2 === 0 ? 1 : 0.18
      if (mode === 8) return zone === Math.floor(beatCount * 2) % 4 ? 1 : 0.08
      if (mode === 6) return seededUnit(musicTrackIdxRef.current * 3079 + zone * 17 + Math.floor(beatCount * 2)) > 0.58 ? 1 : 0.05
      return 1
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
      player.position.x = pos.x
      player.position.z = pos.z
    }

    const onResize = () => {
      const { width, height } = getRenderSize()
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    const initialResizeFrame = window.requestAnimationFrame(onResize)

    function animate() {
      animId = requestAnimationFrame(animate)
      const dt = Math.min(clock.getDelta(), 0.05)
      const elapsed = clock.elapsedTime
      musicPhase += dt * (musicBpmRef.current / 60) * Math.PI * 2
      const beatSync = musicBeatSyncRef.current
      const nowMs = performance.now()
      if (beatSync && nowMs - beatSync.beatAtMs < 8_000) {
        const targetBeat = (nowMs - beatSync.beatAtMs) / (beatSync.beatIntervalSec * 1000)
        const targetPhase = targetBeat * TAU
        const phaseError = wrapPhase(targetPhase - musicPhase)
        const lockStrength = Math.min(1, dt * (1.4 + beatSync.confidence * 3.2))
        musicPhase += phaseError * lockStrength
      }
      const beat = musicPhase
      const feetBeat = musicPhase * 0.5
      const crowdEnergy = crowdEnergyRef.current
      const selfMusicDance = musicDanceIntensity(1)
      const heardMusic = Math.max(0, Math.min(1, musicOutputIntensityRef.current))
      const rhythmIntensity = Math.max(0, Math.min(1, musicRhythmIntensityRef.current))
      const kickIntensity = Math.max(0, Math.min(1, musicKickIntensityRef.current))
      const onsetStrength = Math.max(0, Math.min(1, musicOnsetStrengthRef.current))
      const outputJump = Math.max(0, heardMusic - lastMusicOutput)
      lastMusicOutput += (heardMusic - lastMusicOutput) * Math.min(1, dt * 9)
      const kickAttack = Math.max(0, kickIntensity - lastKickIntensity)
      lastKickIntensity = kickIntensity
      transientEnergy = Math.max(
        transientEnergy * Math.exp(-dt * 7.6),
        Math.min(1, outputJump * 2.5 + onsetStrength * 0.95 + kickIntensity * 0.82 + rhythmIntensity * 0.38),
      )
      const lowEndDrive = Math.pow(kickIntensity, 1.42)
      const rhythmDrive = Math.pow(Math.max(rhythmIntensity, onsetStrength * 0.62), 1.18)
      kickFlash = Math.max(
        kickFlash * Math.exp(-dt * 24),
        Math.min(1, kickAttack * 5.8 + lowEndDrive * onsetStrength * 0.42),
      )
      rhythmGlow = Math.max(
        rhythmGlow * Math.exp(-dt * 5.2),
        Math.min(1, rhythmDrive * 0.78 + transientEnergy * 0.42),
      )
      const drumReturnDrive = Math.max(kickIntensity, onsetStrength * 0.88, rhythmIntensity * 0.92)
      const dropDrive = Math.max(kickIntensity * 0.78 + onsetStrength * 0.58, transientEnergy)
      const strobeDrumGate = heardMusic > 0.08 && drumReturnDrive > 0.13
        ? smooth01((drumReturnDrive - 0.13) / 0.28)
        : 0
      const beatCount = beat / TAU
      const beatKickPulse = beatPulse(beatCount % 1, 0, 0.056)
      const kickStrobePulse = heardMusic > 0.08
        ? Math.max(
          kickFlash,
          beatKickPulse * smooth01((kickIntensity - 0.16) / 0.44),
          transientEnergy > 0.58 && kickIntensity > 0.32 ? transientEnergy * 0.38 : 0,
        ) * strobeDrumGate
        : 0
      const musicReactiveDrive = heardMusic > 0.06
        ? Math.max(rhythmGlow, lowEndDrive * 0.72, transientEnergy * 0.58)
        : 0
      const breakdownLight = heardMusic > 0.14 ? (1 - strobeDrumGate) * (0.42 + heardMusic * 0.24) : 0
      const redBreakdownPulse = Math.max(
        breakdownLight * Math.max(0.72, 0.88 + Math.sin(elapsed * 0.68) * 0.08 + Math.sin(elapsed * 1.17 + 1.8) * 0.05),
        strobeDrumGate * beatPulse(beatCount % 8, 2, 0.24, 8) * 0.68,
        transientEnergy > 0.74 ? transientEnergy * 0.46 * strobeDrumGate : 0,
      )
      const smokeDropSlot = Math.floor((beatCount - 16) / 32)
      const smokeDropPulse = beatPulse(beatCount % 32, 16, 0.18, 32)
      const smokeDropHit = beatCount >= 16 && heardMusic > 0.42 && dropDrive > 0.78 && transientEnergy > 0.58 && smokeDropPulse > 0.35 && smokeDropSlot !== lastSmokeDropSlot
      if (smokeDropHit) {
        lastSmokeDropSlot = smokeDropSlot
        smokeBurst = Math.min(0.96, Math.max(smokeBurst, 0.44 + dropDrive * 0.42))
      }
      smokeBurst *= Math.exp(-dt * 3.4)
      const strobeModeIndex = deterministicStrobeMode(beatCount)
      const strobeTransient = Math.pow(smooth01((transientEnergy - 0.36) / 0.48), 2)
      const patternStrobePulse = strobeDrumGate > 0.15
        ? Math.max(0, Math.min(1, strobePattern(strobeModeIndex, beatCount, strobeTransient))) * strobeDrumGate
        : 0
      const rawStrobePulse = Math.max(patternStrobePulse, kickStrobePulse)
      const strobePulse = Math.pow(Math.max(0, Math.min(1, rawStrobePulse)), 2.1)
      const amberBeaconPulse = Math.max(
        (strobeModeIndex === 1 || strobeModeIndex === 4 || strobeModeIndex === 9 ? beatPulse(beatCount % 4, 0, 0.22, 4) : 0) * strobeDrumGate,
        transientEnergy > 0.45 ? transientEnergy * 0.82 * strobeDrumGate : 0,
        kickFlash * 0.48,
        rhythmGlow * 0.18,
        breakdownLight * 0.42,
      )
      const greenBeaconPulse = Math.max(
        (strobeModeIndex === 5 || strobeModeIndex === 7 || strobeModeIndex === 8 ? beatPulse(beatCount % 8, 4, 0.28, 8) : 0) * strobeDrumGate,
        transientEnergy > 0.68 ? transientEnergy * 0.55 * strobeDrumGate : 0,
        beatPulse(beatCount % 4, 2, 0.22, 4) * strobeDrumGate * 0.72,
        rhythmGlow * 0.34,
        kickFlash * 0.24,
        breakdownLight * 0.36,
      )

      let dx = 0
      let dz = 0
      const fwd = new THREE.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw))
      const right = new THREE.Vector3(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw))
      if (clubInputLockedRef.current) {
        clearMovementInput()
      } else {
        if (keys.w || keys.arrowup) { dx += fwd.x; dz += fwd.z }
        if (keys.s || keys.arrowdown) { dx -= fwd.x; dz -= fwd.z }
        if (keys.a || keys.arrowleft) { dx -= right.x; dz -= right.z }
        if (keys.d || keys.arrowright) { dx += right.x; dz += right.z }
        if (joystick.x || joystick.z) {
          dx += fwd.x * (-joystick.z) + right.x * joystick.x
          dz += fwd.z * (-joystick.z) + right.z * joystick.x
        }
      }

      const hasMoveInput = Math.abs(dx) + Math.abs(dz) > 0.01
      let moving = false
      if (hasMoveInput) {
        setVisualStopTurn(player, false)
        const len = Math.sqrt(dx * dx + dz * dz)
        lastMoveRotY = Math.atan2(dx / len, dz / len)
        delete player.userData.danceBaseRotY
        applyAvatarFacingRotation(player, lastMoveRotY)
          moveRamp = Math.min(1, moveRamp + dt * 2.8)
          const strideSpeed = 4.25 * moveRamp
          const prevX = pos.x
          const prevZ = pos.z
          let nextX = pos.x + (dx / len) * strideSpeed * dt
          let nextZ = pos.z + (dz / len) * strideSpeed * dt
          nextX = Math.max(-15.2, Math.min(15.2, nextX))
          nextZ = Math.max(-14.7, Math.min(9.8, nextZ))
          let nextFloorLevel = resolveClubFloorLevel(selfFloorLevel, nextX, nextZ)
          let blocked = hitsSolid(nextX, nextZ, nextFloorLevel)

          if (!blocked) {
            remotePlayers.forEach((remote) => {
              if ((remote.userData.floorLevel ?? 'ground') !== nextFloorLevel) return
              const ex = Number.isFinite(remote.userData.tx) ? remote.userData.tx : remote.position.x
              const ez = Number.isFinite(remote.userData.tz) ? remote.userData.tz : remote.position.z
              const ddx = nextX - ex
              const ddz = nextZ - ez
              const dist = Math.sqrt(ddx * ddx + ddz * ddz)

              if (dist < PLAYER_RADIUS) {
                const moveX = nextX - pos.x
                const moveZ = nextZ - pos.z
                const moveDist = Math.sqrt(moveX * moveX + moveZ * moveZ)
                const normalX = dist > PLAYER_COLLISION_EPS
                  ? ddx / dist
                  : (moveDist > PLAYER_COLLISION_EPS ? moveX / moveDist : 1)
                const normalZ = dist > PLAYER_COLLISION_EPS
                  ? ddz / dist
                  : (moveDist > PLAYER_COLLISION_EPS ? moveZ / moveDist : 0)
                const inward = moveX * normalX + moveZ * normalZ
                if (inward < 0) {
                  nextX -= inward * normalX
                  nextZ -= inward * normalZ
                }
                const nextDx = nextX - ex
                const nextDz = nextZ - ez
                const nextDist = Math.sqrt(nextDx * nextDx + nextDz * nextDz)
                if (nextDist < PLAYER_RADIUS) {
                  const separateX = nextDist > PLAYER_COLLISION_EPS ? nextDx / nextDist : normalX
                  const separateZ = nextDist > PLAYER_COLLISION_EPS ? nextDz / nextDist : normalZ
                  const overlap = PLAYER_RADIUS - nextDist + PLAYER_COLLISION_PUSH
                  nextX += separateX * overlap
                  nextZ += separateZ * overlap
                }
                nextX = Math.max(-15.2, Math.min(15.2, nextX))
                nextZ = Math.max(-14.7, Math.min(9.8, nextZ))
                nextFloorLevel = resolveClubFloorLevel(selfFloorLevel, nextX, nextZ)
                if (hitsSolid(nextX, nextZ, nextFloorLevel)) blocked = true
              }
            })
          }

          if (!blocked) {
            pos.x = nextX
            pos.z = nextZ
            selfFloorLevel = nextFloorLevel
          }
          player.position.set(pos.x, 0, pos.z)
          const moveX = pos.x - prevX
          const moveZ = pos.z - prevZ
          if (Math.hypot(moveX, moveZ) > 0.0005) {
            moving = true
            walkT += dt * 9
            animateWalk(player, walkT)
          }
      }
      if (wasMoving && !moving && !hasMoveInput) {
        setVisualStopTurn(player, true)
      }
      if (!hasMoveInput && danceModeRef.current) {
        moveRamp = 0
        applyAvatarFacingRotation(player, lastMoveRotY)
        animateDance(player, beat, 0, true, feetBeat, selectedDanceRef.current, selfMusicDance)
      } else if (!hasMoveInput) {
        moveRamp = 0
        applyAvatarFacingRotation(player, lastMoveRotY)
        animateIdleGroove(player, beat, 0, musicDanceIntensity(0.82))
      } else if (!moving) {
        moveRamp = 0
        walkT = 0
        animateIdleGroove(player, beat, 0, musicDanceIntensity(0.5))
      }
      applyServerCorrection(dt)
      animateTalking(player, voiceLevelRef.current, beat)
      player.position.y += floorHeightAt(pos.x, pos.z, selfFloorLevel)

      sendMoveT += dt
      if (sendMoveT > 0.08) {
        sendMoveT = 0
        gameClient.move(pos.x, pos.z, lastMoveRotY, moving, selfMusicDance, selfFloorLevel)
        rememberSelfPosition(nowMs)
      }
      wasMoving = moving

      sendZoneT += dt
      if (sendZoneT > 0.12) {
        sendZoneT = 0
          const nextZone = zoneFromPos(pos.x, pos.z, selfFloorLevel)
        if (nextZone !== lastZoneRef.current) {
          lastZoneRef.current = nextZone
          setZone(nextZone)
        }
      }

      dancerGroups.forEach((dancer, i) => {
        const danceId = DANCE_IDS[i % DANCE_IDS.length]
        animateDance(dancer, beat, dancer.userData.phase ?? i, true, feetBeat, danceId)
      })
      remotePlayers.forEach((remote, id) => {
        const voiceLevel = remoteVoiceLevelsRef.current.get(id) ?? 0
        const tx = typeof remote.userData.tx === 'number' ? remote.userData.tx : remote.position.x
        const tz = typeof remote.userData.tz === 'number' ? remote.userData.tz : remote.position.z
        const toTargetX = tx - remote.position.x
        const toTargetZ = tz - remote.position.z
        const moveAlpha = Math.min(1, dt * 12)
        remote.position.x += toTargetX * moveAlpha
        remote.position.z += toTargetZ * moveAlpha
        remote.position.y = 0
        if (remote.userData.moving) {
          const targetRotY = Math.hypot(toTargetX, toTargetZ) > 0.001
            ? Math.atan2(toTargetX, toTargetZ)
            : (Number.isFinite(remote.userData.rotY) ? remote.userData.rotY : getAvatarMovementRotationY(remote))
          remote.userData.rotY = targetRotY
          applyAvatarFacingRotation(remote, targetRotY)
          remote.userData.walkT = (remote.userData.walkT ?? 0) + dt * 9
          animateWalk(remote, remote.userData.walkT)
        } else {
          const targetRotY = Number.isFinite(remote.userData.rotY) ? remote.userData.rotY : getAvatarMovementRotationY(remote)
          applyAvatarFacingRotation(remote, targetRotY)
          const musicDance = typeof remote.userData.musicDanceIntensity === 'number'
            ? Math.max(0, Math.min(1, remote.userData.musicDanceIntensity))
            : 0
          animateIdleGroove(remote, beat, remote.userData.phase ?? 0, musicDance * 0.85)
        }
        animateTalking(remote, voiceLevel, beat)
        remote.position.y += floorHeightAt(remote.position.x, remote.position.z, remote.userData.floorLevel ?? 'ground')
      })
      nearbyT += dt
      if (nearbyT > 0.35) {
        nearbyT = 0
        const nearby = Array.from(remotePlayers, ([id, remote]) => {
          const remoteFloor = remote.userData.floorLevel ?? 'ground'
          if (remoteFloor !== selfFloorLevel) return null
          const tx = typeof remote.userData.tx === 'number' ? remote.userData.tx : remote.position.x
          const tz = typeof remote.userData.tz === 'number' ? remote.userData.tz : remote.position.z
          if (Math.hypot(tx - pos.x, tz - pos.z) > BAR_NEARBY_PLAYER_DISTANCE) return null
          return { id, displayName: String(remote.userData.displayName || 'GUEST') }
        }).filter((item): item is NearbyPlayer => Boolean(item))
        setNearbyPlayers(nearby)
      }
      voiceT += dt
      if (voiceT > 0.1) {
        voiceT = 0
        window.dispatchEvent(new CustomEvent(PROXIMITY_VOICE_POSITIONS_EVENT, {
          detail: {
            self: { x: pos.x, z: pos.z },
            players: Array.from(remotePlayers, ([id, remote]) => ({
              id,
              x: remote.position.x,
              z: remote.position.z,
            })),
          },
        }))
      }

      danceTiles.forEach((tile, i) => {
        const pulse = 0.22 + 0.78 * Math.max(0, Math.sin(beat + tile.userData.phase))
        const zoneGate = strobeZoneGate(strobeModeIndex, i % 4, beatCount)
        const rhythmTilePulse = rhythmGlow * (0.52 + pulse * 0.48)
        tile.material.color.setHex(dancePalette[(i + Math.floor(beatCount)) % dancePalette.length])
        tile.material.color.multiplyScalar(0.42 + heardMusic * 0.2 + breakdownLight * 0.38 + strobePulse * zoneGate * 1.65 + kickFlash * zoneGate * 1.2 + rhythmTilePulse * 0.28 + musicReactiveDrive * 0.18 + pulse * 0.1)
        tile.scale.y = 1 + strobePulse * zoneGate * 0.38 + kickFlash * zoneGate * 0.28 + lowEndDrive * zoneGate * 0.16 + rhythmTilePulse * 0.12 + transientEnergy * 0.18
      })

      const covePulse = 0.62 + heardMusic * 0.34 + crowdEnergy * 0.22 + transientEnergy * 0.14 + musicReactiveDrive * 0.18
      architecturalGlowMaterials.forEach((material, i) => {
        const baseOpacity = typeof material.userData.baseOpacity === 'number' ? material.userData.baseOpacity : 0.24
        const shimmer = 0.82 + Math.sin(elapsed * 0.8 + i * 0.71 + beat * 0.08) * 0.12 + rhythmGlow * 0.12 + kickFlash * 0.1
        material.opacity = Math.min(0.72, baseOpacity * covePulse * shimmer)
      })
      floorEqualizerStrips.forEach((strip, i) => {
        const material = strip.material
        const chase = Math.max(0, Math.sin(beat * 0.5 + strip.userData.phase))
        const bandKick = lowEndDrive * (0.58 + ((i % 4) / 3) * 0.28) + kickFlash * (0.62 + (i % 2) * 0.18)
        const bandRhythm = rhythmGlow * (0.34 + chase * 0.48)
        material.opacity = Math.min(0.34, 0.045 + heardMusic * 0.035 + chase * 0.045 + transientEnergy * 0.05 + bandRhythm * 0.08 + bandKick * 0.08)
        strip.scale.y = 1 + bandKick * (0.42 + heardMusic * 0.24) + bandRhythm * 0.24 + strobePulse * 0.16
      })

      beams.forEach((beam, i) => {
        const zoneGate = strobeZoneGate(strobeModeIndex, beam.userData.zone ?? i % 4, beatCount)
        beam.rotation.z = Math.sin(elapsed * 0.55 + i) * 0.28
        beam.rotation.x = Math.cos(elapsed * 0.42 + i * 0.8) * 0.16
        const beamMaterial = beam.material as THREE.MeshBasicMaterial
        const rhythmBeam = rhythmGlow * (0.18 + Math.max(0, Math.sin(beat * 0.25 + i * 0.68)) * 0.18)
        const beamFlash = Math.max(strobePulse * zoneGate, kickFlash * zoneGate * 0.62, rhythmBeam)
        const outlineColor = typeof beam.userData.outlineColor === 'number' ? beam.userData.outlineColor : 0xd0005b
        beamMaterial.opacity = Math.min(0.38, 0.005 + beamFlash * (0.28 + strobeTransient * 0.14) + musicReactiveDrive * 0.018)
        if (beamFlash > 0.12) {
          beamMaterial.color.setRGB(1, 0.78 + beamFlash * 0.18, 0.93 + beamFlash * 0.07)
        } else {
          beamMaterial.color.setHex(outlineColor)
        }
      })
      const roomGlow = 0.58 + heardMusic * 0.18 + crowdEnergy * 0.08 + musicReactiveDrive * 0.06
      const amberRoomFlood = amberBeaconPulse * (0.74 + heardMusic * 0.2 + transientEnergy * 0.18) + breakdownLight * 0.12
      const greenRoomFlood = greenBeaconPulse * (0.72 + heardMusic * 0.2 + transientEnergy * 0.18) + breakdownLight * 0.12
      ambient.intensity = 1.34 + heardMusic * 0.1 + crowdEnergy * 0.06 + rhythmGlow * 0.06
      architecturalFill.intensity = 0.58 + heardMusic * 0.08 + crowdEnergy * 0.06 + musicReactiveDrive * 0.05
      longWarmFill.intensity = 0.34 + heardMusic * 0.07 + crowdEnergy * 0.04 + kickFlash * 0.12
      longOliveFill.intensity = 0.24 + heardMusic * 0.05 + greenBeaconPulse * 0.36 + rhythmGlow * 0.08
      amberBeaconFill.intensity = amberRoomFlood * 1.05
      greenBeaconFill.intensity = greenRoomFlood * 1.08
      redBreakdownFill.intensity = redBreakdownPulse * 0.24
      amberBeaconFlood.intensity = amberBeaconPulse * (26 + heardMusic * 8.5 + transientEnergy * 10.0) + breakdownLight * 4.8
      greenBeaconFlood.intensity = greenBeaconPulse * (28 + heardMusic * 9.5 + transientEnergy * 11.0) + breakdownLight * 5.2
      redBreakdownFlood.intensity = redBreakdownPulse * (12 + heardMusic * 2.8)
      lowWarmWash.intensity = 1.35 + heardMusic * 0.72 + crowdEnergy * 0.34 + lowEndDrive * 0.5 + kickFlash * 0.35
      lowCoveLights.forEach((light) => {
        const chase = 0.62 + Math.max(0, Math.sin(beat * 0.5 + light.userData.phase)) * 0.36
        light.intensity = (1.65 + heardMusic * 0.66 + crowdEnergy * 0.34 + transientEnergy * 0.24 + rhythmGlow * 0.42 + kickFlash * 0.55) * chase
        light.distance = 22 + heardMusic * 3 + musicReactiveDrive * 2
      })
      centralFloorFill.intensity = 0
      rearFloorFill.intensity = 0
      vipWarmLight.intensity = 2.2 * roomGlow + amberBeaconPulse * 2.2 + greenBeaconPulse * 0.9 + strobePulse * 0.6
      mezzanineWarmLight.intensity = 2.0 * roomGlow + amberBeaconPulse * 1.9 + greenBeaconPulse * 0.8
      barWarmLight.intensity = 2.1 * roomGlow + amberBeaconPulse * 2.1 + greenBeaconPulse * 0.7
      djBoothGlow.intensity = 1.7 * roomGlow + transientEnergy * 1.05 + rhythmGlow * 0.7 + kickFlash * 0.55
      oliveRoomWash.intensity = 0.95 + heardMusic * 0.4 + greenBeaconPulse * 3.2 + amberBeaconPulse * 0.3 + rhythmGlow * 0.42
      floorReadWash.intensity = 0
      djDeckGreenSpot.intensity = 5.8 + greenBeaconPulse * 4.8 + heardMusic * 0.2 + rhythmGlow * 1.2
      strobeLight.intensity = strobePulse * (30 + strobeTransient * 54 + crowdEnergy * 4) + kickFlash * (34 + lowEndDrive * 28)
      strobeBackLight.intensity = strobePulse * (21 + strobeTransient * 40) + kickFlash * (22 + lowEndDrive * 20)
      const amberBeaconIntensity = breakdownLight * 8 + amberBeaconPulse * (96 + heardMusic * 26 + transientEnergy * 42)
      const greenBeaconIntensity = breakdownLight * 8 + greenBeaconPulse * (112 + heardMusic * 30 + transientEnergy * 48)
      const redBreakdownIntensity = redBreakdownPulse * (58 + heardMusic * 18)
      amberBeaconLights.forEach((light) => {
        light.intensity = amberBeaconIntensity
      })
      greenBeaconLights.forEach((light) => {
        light.intensity = greenBeaconIntensity
      })
      redBreakdownLights.forEach((light) => {
        light.intensity = redBreakdownIntensity
      })
      beaconTargets.forEach((target, i) => {
        const phase = target.userData.phase ?? i
        const sweep = 0.55 + heardMusic * 0.55 + transientEnergy * 0.38
        const beatSwing = Math.sin(beatCount * Math.PI * 0.5 + phase)
        const crossSwing = Math.cos(beatCount * Math.PI + phase * 1.3)
        target.position.x = (target.userData.baseX ?? 0) + beatSwing * sweep
        target.position.z = (target.userData.baseZ ?? 0) + crossSwing * sweep * 0.68
      })
      beaconMeshes.forEach((beacon) => {
        const material = beacon.material as THREE.MeshBasicMaterial
        const pulse = beacon.userData.kind === 'amber'
          ? amberBeaconPulse
          : beacon.userData.kind === 'green'
            ? greenBeaconPulse
            : redBreakdownPulse
        material.opacity = Math.min(1, 0.18 + breakdownLight * 0.12 + musicReactiveDrive * 0.1 + pulse * 2.2)
        beacon.scale.setScalar(0.9 + breakdownLight * 0.1 + musicReactiveDrive * 0.12 + pulse * 1.65)
      })
      beaconConeMeshes.forEach((cone, i) => {
        const material = cone.material as THREE.MeshBasicMaterial
        const target = cone.userData.target as THREE.Object3D | undefined
        if (!target) return
        const source = new THREE.Vector3(cone.userData.sourceX, cone.userData.sourceY, cone.userData.sourceZ)
        const floorTarget = new THREE.Vector3(target.position.x, target.position.y, target.position.z)
        const center = source.clone().add(floorTarget).multiplyScalar(0.5)
        const direction = source.clone().sub(floorTarget).normalize()
        const kind = cone.userData.kind
        const pulse = kind === 'amber'
          ? amberBeaconPulse
          : kind === 'green'
            ? greenBeaconPulse
            : redBreakdownPulse
        cone.position.copy(center)
        cone.quaternion.setFromUnitVectors(coneUpAxis, direction)
        cone.scale.set(0.88 + pulse * 0.34, 1, 0.88 + pulse * 0.34)
        material.opacity = Math.min(0.3, 0.012 + heardMusic * 0.014 + musicReactiveDrive * 0.018 + pulse * 0.22 + strobePulse * 0.035)
        cone.visible = material.opacity > 0.014 || i % 3 === 0
      })

      if (smokeBurst > 0.2 && heardMusic > 0.38 && smokeSprites.length > 0) {
        smokeEmissionCarry += dt * (2.8 + dropDrive * 7 + smokeBurst * 10)
        while (smokeEmissionCarry >= 1) {
          const sprite = smokeSprites[smokeCursor % smokeSprites.length]
          const material = sprite.material as THREE.SpriteMaterial
          smokeCursor += 1
          smokeEmissionCarry -= 1

          const spread = 0.18 + smokeBurst * 0.22
          sprite.visible = true
          sprite.userData.age = Math.random() * 0.05
          sprite.userData.power = smokeBurst
          sprite.position.set(
            sprite.userData.baseX + (Math.random() - 0.5) * spread,
            0.3 + Math.random() * 0.2,
            sprite.userData.baseZ + (Math.random() - 0.5) * spread,
          )
          sprite.scale.setScalar(0.8 + Math.random() * 0.52 + smokeBurst * 0.42)
          material.opacity = 0
        }
      } else {
        smokeEmissionCarry = Math.min(smokeEmissionCarry, 0.35)
      }

      smokeSprites.forEach((sprite, i) => {
        const material = sprite.material as THREE.SpriteMaterial
        const currentAge = sprite.userData.age ?? 99
        if (!sprite.visible && currentAge > 4.1) return

        const seed = sprite.userData.seed ?? i
        const power = Math.max(0, Math.min(1.18, sprite.userData.power ?? 0.7))
        const age = currentAge + dt * (1.15 + heardMusic * 0.26)
        sprite.userData.age = age

        if (age > 2.65 || sprite.position.y > 4.2) {
          material.opacity = Math.max(0, material.opacity - dt * 1.65)
          if (material.opacity <= 0.02) {
            material.opacity = 0
            sprite.visible = false
            sprite.userData.age = 99
          }
          return
        }

        const lift = Math.max(0, Math.min(1, (age - 0.42) / 1.48))
        const forward = Math.max(0.1, 1 - lift * 0.68)
        const jet = (1.05 + heardMusic * 0.35 + power * 1.2) * forward
        sprite.position.x += sprite.userData.dirX * dt * jet
          + Math.sin(elapsed * 0.46 + seed) * dt * (0.1 + lift * 0.24)
        sprite.position.z += sprite.userData.dirZ * dt * jet
          + Math.cos(elapsed * 0.38 + seed * 0.4) * dt * (0.1 + lift * 0.2)
        sprite.position.y += dt * (0.006 + lift * (0.52 + heardMusic * 0.08) + power * lift * 0.08)

        const fadeIn = Math.min(1, age / 0.12)
        const fadeOut = Math.max(0, 1 - Math.max(0, age - 0.85) / 1.8)
        material.opacity = Math.min(0.46, (0.08 + power * 0.22 + strobePulse * 0.04) * fadeIn * fadeOut)
        sprite.scale.setScalar(1.0 + Math.sin(elapsed * 0.42 + seed) * 0.12 + lift * 1.55 + power * 0.5)
      })

      nameTags.forEach((tag) => tag.quaternion.copy(camera.quaternion))

      const floorY = floorHeightAt(pos.x, pos.z, selfFloorLevel)
      const cx = pos.x + cam.dist * Math.sin(cam.yaw) * Math.cos(cam.pitch)
      const cy = floorY + 1.75 + cam.dist * Math.sin(cam.pitch)
      const cz = pos.z + cam.dist * Math.cos(cam.yaw) * Math.cos(cam.pitch)
      camera.position.set(cx, cy, cz)
      camera.lookAt(pos.x, floorY + 1.25, pos.z)

      renderer.render(scene, camera)
    }

    animate()

    function zoneFromPos(x: number, z: number, floorLevel: ClubFloorLevel = 'ground'): ClubZone {
      if (floorLevel === 'vip' || floorLevel === 'stairs') return 'vip'
      if (z < -5.1 && Math.abs(x) < 5.3) return 'dj'
      if (x > 7.4 && z > -5.8 && z < 6.2) return 'bar'
      if (x < -7.2 && z > -6.3 && z < 5.8) return 'vip'
      return 'floor'
    }

    function floorHeightAt(x: number, z: number, floorLevel: ClubFloorLevel = 'ground') {
      if (floorLevel === 'vip') return 3.55
      if (floorLevel === 'stairs') return 0.24 + smooth01((-z - 8.36) / 1.82) * 3.31
      return z < -7.35 && z > -9.3 && Math.abs(x) < 5.3 ? 0.24 : 0
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

    function hitsSolid(x: number, z: number, targetFloorLevel = resolveClubFloorLevel(selfFloorLevel, x, z)) {
      if ((targetFloorLevel === 'vip' || targetFloorLevel === 'stairs') && !selfCanUseVipMezzanine) return true
      if (selfFloorLevel === 'vip' && targetFloorLevel === 'ground') return true
      if (targetFloorLevel === 'vip' || targetFloorLevel === 'stairs') return false
      if (!selfCanUseVipMezzanine && isVipMezzanineGroundRestrictedPosition(x, z)) return true
      if (x > -5.05 && x < 5.05 && z > -7.85 && z < -5.75) return true
      if (x > -7.25 && x < -4.35 && z > -7.45 && z < -6.05) return true
      if (x > 4.35 && x < 7.25 && z > -7.45 && z < -6.05) return true
      if (z < -7.15 && z > -9.55 && Math.abs(x) < 5.45) return !selfCanUseDjBooth
      if (x < -8.6 && z > -3.8 && z < 3.9) return false
      return false
    }

    function resetLimbs(group: THREE.Group) {
      const limbs = group.userData.limbs
      if (limbs) {
        limbs.armL.rotation.set(0, 0, 0)
        limbs.armR.rotation.set(0, 0, 0)
        limbs.legL.rotation.set(0, 0, 0)
        limbs.legR.rotation.set(0, 0, 0)
        limbs.torso.rotation.set(0, 0, 0)
        limbs.head.rotation.set(0, 0, 0)
        limbs.hairMesh.rotation.set(0, 0, 0)
        limbs.mouth.rotation.set(0, 0, 0)
        limbs.armL.position.set(-0.33, 1.5, 0)
        limbs.armR.position.set(0.33, 1.5, 0)
        limbs.armL.rotation.z = 0.16
        limbs.armR.rotation.z = -0.16
        limbs.legL.position.set(-0.15, 0.6, 0)
        limbs.legR.position.set(0.15, 0.6, 0)
        limbs.shoeL.position.set(-0.15, 0.16, 0.04)
        limbs.shoeR.position.set(0.15, 0.16, 0.04)
        limbs.shoeL.rotation.set(0, 0, 0)
        limbs.shoeR.rotation.set(0, 0, 0)
      }
      const rig = group.userData.generatedRig as GeneratedAvatarRig | undefined
      if (rig) {
        rig.reset()
        applyVisualStopTurn(group)
        if (typeof group.userData.danceBaseRotY === 'number') group.rotation.y = group.userData.danceBaseRotY
        delete group.userData.danceBaseRotY
        group.position.y = 0
        return
      }
      const generated = group.userData.generatedModel as THREE.Object3D | undefined
      if (generated) {
        generated.rotation.x = 0
        generated.rotation.z = 0
        generated.position.set(generated.userData.baseX ?? generated.position.x, generated.userData.baseY ?? generated.position.y, generated.userData.baseZ ?? generated.position.z)
      }
      if (typeof group.userData.danceBaseRotY === 'number') group.rotation.y = group.userData.danceBaseRotY
      delete group.userData.danceBaseRotY
      group.position.y = 0
    }

    function animateWalk(group: THREE.Group, t: number) {
      const limbs = group.userData.limbs
      if (limbs) {
        limbs.legL.position.z = Math.sin(t) * 0.18
        limbs.legR.position.z = Math.sin(t + Math.PI) * 0.18
        limbs.legL.position.y = 0.6 + Math.abs(Math.sin(t)) * 0.04
        limbs.legR.position.y = 0.6 + Math.abs(Math.sin(t + Math.PI)) * 0.04
        limbs.legL.rotation.x = Math.sin(t) * 0.36
        limbs.legR.rotation.x = Math.sin(t + Math.PI) * 0.36
        limbs.shoeL.position.z = 0.04 + limbs.legL.position.z
        limbs.shoeR.position.z = 0.04 + limbs.legR.position.z
        limbs.shoeL.position.y = 0.16 + Math.abs(Math.sin(t)) * 0.04
        limbs.shoeR.position.y = 0.16 + Math.abs(Math.sin(t + Math.PI)) * 0.04
        limbs.shoeL.rotation.x = limbs.legL.rotation.x * 0.45
        limbs.shoeR.rotation.x = limbs.legR.rotation.x * 0.45
        limbs.armL.rotation.x = Math.sin(t + Math.PI) * 0.34
        limbs.armR.rotation.x = Math.sin(t) * 0.34
        limbs.armL.rotation.z = 0.16 + Math.sin(t + Math.PI / 2) * 0.035
        limbs.armR.rotation.z = -0.16 + Math.sin(t - Math.PI / 2) * 0.035
        limbs.head.rotation.x = Math.sin(t * 0.5) * 0.035
        limbs.hairMesh.rotation.copy(limbs.head.rotation)
        limbs.mouth.rotation.copy(limbs.head.rotation)
      }
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
        if (typeof group.userData.danceBaseRotY === 'number') group.rotation.y = group.userData.danceBaseRotY
        delete group.userData.danceBaseRotY
        group.position.y = 0
        return
      }

      resetLimbs(group)
      const limbs = group.userData.limbs
      if (!limbs) return
      const pulse = Math.sin(p)
      const side = Math.sin(p * 0.5)
      group.position.y = Math.max(0, pulse) * 0.012 * amount
      limbs.torso.rotation.x = (0.025 + pulse * 0.025) * amount
      limbs.torso.rotation.z = side * 0.035 * amount
      limbs.head.rotation.x = pulse * 0.035 * amount
      limbs.head.rotation.z = -side * 0.035 * amount
      limbs.armL.rotation.x = Math.sin(p + Math.PI) * 0.08 * amount
      limbs.armR.rotation.x = Math.sin(p) * 0.08 * amount
      limbs.armL.rotation.z = 0.16 + 0.08 * amount
      limbs.armR.rotation.z = -0.16 - 0.08 * amount
      limbs.hairMesh.rotation.copy(limbs.head.rotation)
      limbs.mouth.rotation.copy(limbs.head.rotation)
    }

    function loopBeat(t: number, beats: number) {
      const beat = t / TAU
      return ((beat % beats) + beats) % beats
    }

    function smooth01(value: number) {
      const x = Math.max(0, Math.min(1, value))
      return x * x * (3 - 2 * x)
    }

    function pulse(beat: number, center: number, width: number) {
      return smooth01(1 - Math.abs(beat - center) / width)
    }

    function setDanceRootRotation(group: THREE.Group, rotationY: number) {
      if (typeof group.userData.danceBaseRotY !== 'number') {
        group.userData.danceBaseRotY = group.rotation.y
      }
      group.rotation.y = group.userData.danceBaseRotY + rotationY
    }

    function resetDancePose(limbs: any) {
      limbs.armL.position.set(-0.33, 1.5, 0)
      limbs.armR.position.set(0.33, 1.5, 0)
      limbs.armL.rotation.z = 0.16
      limbs.armR.rotation.z = -0.16
      limbs.legL.position.set(-0.15, 0.6, 0)
      limbs.legR.position.set(0.15, 0.6, 0)
      limbs.shoeL.position.set(-0.15, 0.16, 0.04)
      limbs.shoeR.position.set(0.15, 0.16, 0.04)
      limbs.torso.rotation.set(0, 0, 0)
      limbs.armL.rotation.set(0, 0, 0)
      limbs.armR.rotation.set(0, 0, 0)
      limbs.legL.rotation.set(0, 0, 0)
      limbs.legR.rotation.set(0, 0, 0)
      limbs.shoeL.rotation.set(0, 0, 0)
      limbs.shoeR.rotation.set(0, 0, 0)
      limbs.head.rotation.set(0, 0, 0)
      limbs.hairMesh.rotation.set(0, 0, 0)
      limbs.mouth.rotation.set(0, 0, 0)
    }

    function finishHead(limbs: any) {
      limbs.hairMesh.rotation.copy(limbs.head.rotation)
      limbs.mouth.rotation.copy(limbs.head.rotation)
    }

    function scaleRotation(object: THREE.Object3D | undefined, amount: number) {
      if (!object) return
      object.rotation.x *= amount
      object.rotation.y *= amount
      object.rotation.z *= amount
    }

    function scalePositionFromBase(object: THREE.Object3D | undefined, x: number, y: number, z: number, amount: number) {
      if (!object) return
      object.position.x = x + (object.position.x - x) * amount
      object.position.y = y + (object.position.y - y) * amount
      object.position.z = z + (object.position.z - z) * amount
    }

    function scaleDancePose(group: THREE.Group, limbs: any, amount: number) {
      group.position.y *= amount
      if (typeof group.userData.danceBaseRotY === 'number') {
        group.rotation.y = group.userData.danceBaseRotY + (group.rotation.y - group.userData.danceBaseRotY) * amount
      }
      scalePositionFromBase(limbs.armL, -0.33, 1.5, 0, amount)
      scalePositionFromBase(limbs.armR, 0.33, 1.5, 0, amount)
      scalePositionFromBase(limbs.legL, -0.15, 0.6, 0, amount)
      scalePositionFromBase(limbs.legR, 0.15, 0.6, 0, amount)
      scalePositionFromBase(limbs.shoeL, -0.15, 0.16, 0.04, amount)
      scalePositionFromBase(limbs.shoeR, 0.15, 0.16, 0.04, amount)
      scaleRotation(limbs.torso, amount)
      scaleRotation(limbs.armL, amount)
      scaleRotation(limbs.armR, amount)
      scaleRotation(limbs.legL, amount)
      scaleRotation(limbs.legR, amount)
      scaleRotation(limbs.shoeL, amount)
      scaleRotation(limbs.shoeR, amount)
      scaleRotation(limbs.head, amount)
      finishHead(limbs)
    }

    function animateDance(
      group: THREE.Group,
      t: number,
      phase: number,
      moveFeet = false,
      feetT = t * 0.5,
      danceId: DanceId = 'dance_idle_groove_01',
      intensity = 1,
    ) {
      const limbs = group.userData.limbs
      const p = t + phase
      const footP = feetT + phase
      const amount = Math.max(0, Math.min(1, intensity))
      if (limbs) {
        resetDancePose(limbs)
        if (danceId === 'dance_idle_groove_01') {
          const side = Math.sin(loopBeat(p, 8) / 8 * TAU)
          const bounce = Math.max(0, Math.sin(p))
          const sideLook = pulse(loopBeat(p, 8), 4.25, 1.2)
          setDanceRootRotation(group, 0)
          group.position.y = moveFeet ? bounce * 0.018 : 0
          limbs.torso.rotation.x = Math.sin(p) * 0.055
          limbs.torso.rotation.y = side * -0.055
          limbs.torso.rotation.z = side * 0.085
          limbs.armL.rotation.x = Math.sin(p + 0.6) * 0.16
          limbs.armR.rotation.x = Math.sin(p + Math.PI) * 0.13
          limbs.armL.rotation.z = 0.08 + side * 0.08
          limbs.armR.rotation.z = -0.13 + side * 0.07
          limbs.head.rotation.x = Math.sin(p) * 0.28
          limbs.head.rotation.y = side * 0.07 + sideLook * 0.28
          limbs.head.rotation.z = side * -0.08
          limbs.legL.position.y = 0.6 - Math.max(0, -side) * 0.015 + bounce * 0.012
          limbs.legR.position.y = 0.6 - Math.max(0, side) * 0.015 + bounce * 0.012
          limbs.shoeL.position.y = 0.16 + (limbs.legL.position.y - 0.6)
          limbs.shoeR.position.y = 0.16 + (limbs.legR.position.y - 0.6)
          finishHead(limbs)
        } else if (danceId === 'dance_side_step_turn_02') {
          const side = Math.sin(loopBeat(p, 14) / 14 * TAU)
          const pump = Math.sin(p)
          const bounce = Math.max(0, Math.sin(p * 2))
          setDanceRootRotation(group, side * 0.82)
          group.position.y = moveFeet ? bounce * 0.025 : 0
          limbs.torso.rotation.x = 0.08 + bounce * 0.025
          limbs.torso.rotation.y = side * 0.12
          limbs.torso.rotation.z = side * 0.06
          limbs.armL.rotation.x = pump * 0.28
          limbs.armR.rotation.x = -pump * 0.28
          limbs.armL.rotation.z = 0.18 + side * 0.12
          limbs.armR.rotation.z = -0.18 + side * 0.12
          limbs.head.rotation.x = 0.04 + Math.sin(p) * 0.12
          limbs.head.rotation.y = side * 0.32
          limbs.head.rotation.z = side * -0.06
          limbs.legL.position.z = moveFeet ? Math.max(0, side) * 0.08 + Math.sin(footP) * 0.035 : 0
          limbs.legR.position.z = moveFeet ? Math.max(0, -side) * 0.08 + Math.sin(footP + Math.PI) * 0.035 : 0
          limbs.legL.position.y = 0.6 + bounce * 0.025
          limbs.legR.position.y = 0.6 + Math.max(0, Math.sin(p * 2 + Math.PI)) * 0.02
          limbs.legL.rotation.x = moveFeet ? Math.sin(footP) * 0.12 : 0
          limbs.legR.rotation.x = moveFeet ? Math.sin(footP + Math.PI) * 0.12 : 0
          limbs.shoeL.position.z = 0.04 + limbs.legL.position.z
          limbs.shoeR.position.z = 0.04 + limbs.legR.position.z
          limbs.shoeL.position.y = 0.16 + (limbs.legL.position.y - 0.6)
          limbs.shoeR.position.y = 0.16 + (limbs.legR.position.y - 0.6)
          limbs.shoeL.rotation.x = limbs.legL.rotation.x * 0.5
          limbs.shoeR.rotation.x = limbs.legR.rotation.x * 0.5
          finishHead(limbs)
        } else {
          const beat = loopBeat(p, 24)
          const side = Math.sin(beat / 24 * TAU)
          const bounce = Math.max(0, Math.sin(p * 2))
          const headTouch = Math.max(
            pulse(beat, 2.1, 1.1),
            pulse(beat, 12.4, 1.2),
            pulse(beat, 20.0, 1.15),
          )
          const faceTouch = Math.max(pulse(beat, 4.4, 1.0), pulse(beat, 14.7, 1.0), pulse(beat, 22.2, 1.0))
          const cover = pulse(beat, 15.2, 1.35)
          const guard = pulse(beat, 18.2, 1.25)
          const profile = pulse(beat, 6.3, 1.6) * 0.48 + pulse(beat, 18.4, 1.3) * 0.32
          setDanceRootRotation(group, profile + side * 0.12)
          group.position.y = moveFeet ? bounce * 0.025 : 0
          limbs.torso.rotation.x = 0.05 + bounce * 0.035 + cover * 0.1
          limbs.torso.rotation.y = profile * 0.25
          limbs.torso.rotation.z = side * 0.13 - headTouch * 0.08
          limbs.armR.rotation.x = -0.12 + faceTouch * 0.28 + guard * 0.18
          limbs.armR.rotation.z = -0.16 + headTouch * 2.22 + faceTouch * 1.35 + guard * 0.95
          limbs.armR.rotation.y = headTouch * -0.22 + faceTouch * -0.1
          limbs.armL.rotation.x = Math.sin(p + 0.9) * 0.12 + cover * 0.25
          limbs.armL.rotation.z = 0.12 - cover * 1.2 - guard * 0.85 - Math.max(0, side) * 0.12
          limbs.armL.rotation.y = guard * 0.18
          limbs.head.rotation.x = Math.sin(p) * 0.18 + cover * 0.2 + faceTouch * 0.06
          limbs.head.rotation.y = profile * 0.42 + guard * 0.1
          limbs.head.rotation.z = side * -0.12 - headTouch * 0.16 + faceTouch * -0.08
          limbs.legL.position.z = moveFeet ? Math.sin(footP) * 0.05 + Math.max(0, profile) * 0.06 : 0
          limbs.legR.position.z = moveFeet ? Math.sin(footP + Math.PI) * 0.05 : 0
          limbs.legL.position.y = 0.6 + bounce * 0.026
          limbs.legR.position.y = 0.6 + Math.max(0, Math.sin(p * 2 + Math.PI)) * 0.026
          limbs.legL.rotation.x = moveFeet ? Math.sin(footP) * 0.1 : 0
          limbs.legR.rotation.x = moveFeet ? Math.sin(footP + Math.PI) * 0.1 : 0
          limbs.shoeL.position.z = 0.04 + limbs.legL.position.z
          limbs.shoeR.position.z = 0.04 + limbs.legR.position.z
          limbs.shoeL.position.y = 0.16 + (limbs.legL.position.y - 0.6)
          limbs.shoeR.position.y = 0.16 + (limbs.legR.position.y - 0.6)
          limbs.shoeL.rotation.x = limbs.legL.rotation.x * 0.5
          limbs.shoeR.rotation.x = limbs.legR.rotation.x * 0.5
          finishHead(limbs)
        }
        scaleDancePose(group, limbs, amount)
      } else {
        setDanceRootRotation(group, danceId === 'dance_side_step_turn_02' ? Math.sin(loopBeat(p, 14) / 14 * TAU) * 0.82 : 0)
        if (typeof group.userData.danceBaseRotY === 'number') {
          group.rotation.y = group.userData.danceBaseRotY + (group.rotation.y - group.userData.danceBaseRotY) * amount
        }
      }
      const rig = group.userData.generatedRig as GeneratedAvatarRig | undefined
      if (rig) {
        rig.dance(p, moveFeet, footP, danceId, amount)
      } else {
        const generated = group.userData.generatedModel as THREE.Object3D | undefined
        if (!generated) return
        generated.position.set(generated.userData.baseX ?? generated.position.x, (generated.userData.baseY ?? 0) + (moveFeet ? Math.max(0, Math.sin(footP * 2)) * 0.02 * amount : 0), generated.userData.baseZ ?? generated.position.z)
        generated.rotation.x = Math.sin(p) * 0.045 * amount
        generated.rotation.z = Math.sin(p + Math.PI / 2) * 0.04 * amount
      }
      applyVisualStopTurn(group)
    }

    function animateTalking(group: THREE.Group, level: number, t: number) {
      const amount = Math.max(0, Math.min(1, level * 5))
      const talking = amount > 0.06
      const rig = group.userData.generatedRig as GeneratedAvatarRig | undefined
      rig?.talk(talking, t, amount)
      const mouth = group.userData.limbs?.mouth as THREE.Mesh | undefined
      if (!mouth) return
      const material = mouth.material as THREE.MeshBasicMaterial
      const openness = talking ? amount : 0
      const scale = 0.62 + openness * 0.95
      mouth.visible = openness > 0.01
      mouth.scale.setScalar(scale)
      material.opacity = Math.min(1, openness)
    }

    function createNeonTexture(text: string, color: string, withPanelBackground = true) {
      const cv = document.createElement('canvas')
      cv.width = 512
      cv.height = 128
      drawNeonLabel(cv, text, color, withPanelBackground)
      const texture = track(new THREE.CanvasTexture(cv))
      texture.colorSpace = THREE.SRGBColorSpace
      return texture
    }

    function drawNeonLabel(cv: HTMLCanvasElement, text: string, color: string, withPanelBackground: boolean) {
      const ctx = cv.getContext('2d')!
      const label = text.trim().slice(0, 24) || 'DJ'
      ctx.clearRect(0, 0, cv.width, cv.height)
      if (withPanelBackground) {
        ctx.fillStyle = 'rgba(7,7,5,0.96)'
        ctx.fillRect(0, 0, cv.width, cv.height)
        ctx.strokeStyle = 'rgba(110,88,58,0.52)'
        ctx.lineWidth = 4
        ctx.strokeRect(10, 10, cv.width - 20, cv.height - 20)
      }
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      let fontSize = 44
      do {
        ctx.font = `bold ${fontSize}px monospace`
        fontSize -= 2
      } while (ctx.measureText(label).width > 456 && fontSize > 22)
      ctx.shadowColor = color
      ctx.shadowBlur = 10
      ctx.strokeStyle = color
      ctx.lineWidth = 1.4
      ctx.strokeText(label, 256, 64)
      ctx.shadowBlur = 3
      ctx.fillStyle = '#d7d0c2'
      ctx.fillText(label, 256, 64)
    }

    function createNeonSign(text: string, w: number, h: number, color: string, x: number, y: number, z: number, rotY = 0, withPanelBackground = true) {
      const texture = createNeonTexture(text, color, withPanelBackground)
      const sign = new THREE.Mesh(
        track(new THREE.PlaneGeometry(w, h)),
        track(new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })),
      )
      sign.position.set(x, y, z)
      sign.rotation.y = rotY
      sign.userData.withPanelBackground = withPanelBackground
      scene.add(sign)
      return sign
    }

    function setNeonSignText(sign: THREE.Mesh, text: string, color: string) {
      const material = sign.material as THREE.MeshBasicMaterial
      const oldTexture = material.map
      const texture = createNeonTexture(text, color, sign.userData.withPanelBackground !== false)
      material.map = texture
      material.needsUpdate = true
      oldTexture?.dispose()
    }

    function buildArchitecturalLowLighting() {
      const warmCoveMat = glowMaterial(0xe0a45a, 0.34)
      const oliveCoveMat = glowMaterial(0x6f8a58, 0.24)
      const brassLineMat = glowMaterial(0xffc979, 0.28)
      const greenLineMat = glowMaterial(0x77ff96, 0.18)

      // Low cove and toe-kick lighting keeps the club readable without flattening the ceiling darkness.
      box(30.4, 0.035, 0.055, 0, 0.11, -13.98, warmCoveMat)
      box(0.055, 0.035, 27.2, -16.32, 0.11, 0.15, oliveCoveMat)
      box(0.055, 0.035, 27.2, 16.32, 0.11, 0.15, warmCoveMat)
      box(8.6, 0.035, 0.055, -10.4, 0.11, 6.85, oliveCoveMat)
      box(8.6, 0.035, 0.055, 10.4, 0.11, 6.85, brassLineMat)

      const lightSpecs = [
        { x: -11.5, z: -12.7, color: 0xe0a45a },
        { x: 0, z: -12.9, color: 0xf0bd74 },
        { x: 11.5, z: -12.7, color: 0xe0a45a },
        { x: -15.6, z: -5.8, color: 0x6f8a58 },
        { x: -15.6, z: 4.2, color: 0x84a666 },
        { x: 15.6, z: -4.8, color: 0xe0a45a },
        { x: 15.6, z: 5.1, color: 0xf0bd74 },
        { x: 10.2, z: 0.5, color: 0xffbf67 },
        { x: -10.8, z: -0.2, color: 0x6f8a58 },
      ]
      lightSpecs.forEach((spec, index) => {
        const light = new THREE.PointLight(spec.color, 0, 30, 0.52)
        light.position.set(spec.x, 0.52, spec.z)
        light.userData.phase = index * 0.74
        scene.add(light)
        lowCoveLights.push(light)
      })

      box(0.07, 0.055, 9.7, 9.98, 0.16, 0.35, brassLineMat)
      box(0.07, 0.04, 9.3, 12.94, 0.32, 0.35, greenLineMat)
      box(4.8, 0.05, 0.07, -10.55, 0.18, -4.05, oliveCoveMat)
      box(0.07, 0.05, 4.2, -12.96, 0.18, 0.82, oliveCoveMat)
      box(6.8, 0.045, 0.06, 0, 0.2, -6.04, brassLineMat)
    }

    function buildDjBooth() {
      const boothAmberStripMat = basic(0xd28a45, 0.5)
      const boothSoftWhiteMat = basic(0xd8c7a0, 0.34)
      const mainPioneerWidth = 4.15 * 0.54
      const pioneerX = 0
      const technicsWidth = 1.13 * 0.9
      const technicsX = mainPioneerWidth / 2 + technicsWidth / 2
      box(11.05, 0.38, 1.9, 0, 0.19, -8.35, concreteMat)
      box(10.95, 0.045, 1.82, 0, 0.405, -8.35, mat(0x171510, 0x050403, 0.24))
      box(11.15, 0.12, 0.08, 0, 0.46, -7.42, boothAmberStripMat)
      box(11.15, 0.08, 0.07, 0, 0.42, -9.29, basic(0x293825, 0.34))
      box(8.9, 0.24, 1.55, 0, 0.12, -8.35, mat(0x15130f, 0x050403, 0.28))
      box(9.15, 0.08, 0.08, 0, 0.27, -6.72, basic(0x8a5a2b, 0.42))
      box(8.8, 0.05, 0.06, 0, 1.28, -6.08, boothAmberStripMat)
      box(6.8, 0.04, 0.05, 0, 1.86, -6.0, boothSoftWhiteMat)
      box(0.08, 0.08, 2.65, -4.55, 0.27, -8.05, basic(0x293825, 0.36))
      box(0.08, 0.08, 2.65, 4.55, 0.27, -8.05, basic(0x293825, 0.36))
      boxWithFrontTexture(9.4, 1.45, 1.2, 0, 0.95, -6.75, blackMat, 'doorclub_dj_booth_concrete_greenery_front_2048x1024.png', 4)
      box(8.75, 0.16, 0.95, 0, 1.5, -6.35, chromeMat)
      loadStageModel('pioneer_cdj_3000_pioneer_djm_a9.glb', {
        x: pioneerX,
        y: 1.6,
        z: -6.58,
        width: mainPioneerWidth,
        fitBy: 'width',
        rotY: Math.PI,
      })
      loadStageModel('technics_sl-1210mk2.glb', {
        x: -technicsX,
        y: 1.6,
        z: -6.58,
        width: technicsWidth,
        fitBy: 'width',
        rotY: Math.PI,
      })
      loadStageModel('technics_sl-1210mk2.glb', {
        x: technicsX,
        y: 1.6,
        z: -6.58,
        width: technicsWidth,
        fitBy: 'width',
        rotY: Math.PI,
      })
      loadStageModel('funktion_one_res_2.glb', {
        x: -5.8,
        y: 0.04,
        z: -6.72,
        width: 2.15,
        height: 2.85,
        depth: 1.12,
      })
      loadStageModel('funktion_one_res_2.glb', {
        x: 5.8,
        y: 0.04,
        z: -6.72,
        width: 2.15,
        height: 2.85,
        depth: 1.12,
      })
    }

    function buildBar() {
      const barAmberStripMat = basic(0xd88a3d, 0.56)
      const backbarOliveMat = basic(0x60764b, 0.3)
      box(1.7, 0.2, 10.4, 10.8, 1.05, 0.4, chromeMat)
      box(1.35, 1.04, 10.4, 11.35, 0.52, 0.4, mat(0x17121a))
      boxWithFrontTexture(0.18, 2.55, 10.1, 13.12, 1.42, 0.35, mat(0x100c13), 'doorclub_bar_green_concrete_front_2048x1024.png', 1)
      box(0.08, 0.05, 9.6, 10.02, 1.72, 0.35, barAmberStripMat)
      box(0.08, 0.05, 7.8, 13.06, 2.66, 0.35, backbarOliveMat)
      for (let i = 0; i < 9; i++) {
        const z = -3.8 + i * 0.9
        const bottle = new THREE.Mesh(track(new THREE.CylinderGeometry(0.06, 0.075, 0.42, 7)), basic(i % 3 === 0 ? 0x5a3518 : 0x10140e, 0.92))
        bottle.position.set(13.05, 2.15 + (i % 2) * 0.32, z)
        scene.add(bottle)
      }
      for (let i = 0; i < 4; i++) {
        box(1.0, 0.08, 0.08, 10.02, 1.88, -3.2 + i * 2.1, basic(0x9a551c, 0.38))
      }
    }

    function buildVip() {
      const vipLevelRearOffset = -5.03
      const vipLevelZ = (z: number) => z + vipLevelRearOffset
      const vipLevelY = (y: number) => y + 0.5
      const vipAmberStripMat = basic(0xd48c48, 0.5)
      const vipOliveGlowMat = basic(0x62784c, 0.32)

      boxWithFrontTexture(0.42, 4.6, 10.4, -16.1, 3.05, -0.5, concreteMat, 'doorclub_vip_garden_mezzanine_front_2048x1024.png', 0)
      box(5.6, 0.28, 9.7, -10.6, 0.14, 0, mat(0x10151c))
      box(4.2, 0.5, 0.8, -10.8, 0.55, -3.4, redSeatMat)
      box(4.2, 0.62, 0.35, -10.8, 0.96, -3.75, redSeatMat)
      box(4.35, 0.05, 0.06, -10.8, 1.31, -3.08, vipAmberStripMat)
      box(0.8, 0.5, 3.8, -12.4, 0.55, 0.8, redSeatMat)
      box(0.35, 0.62, 3.8, -12.78, 0.96, 0.8, redSeatMat)
      box(0.06, 0.05, 3.55, -12.08, 1.31, 0.8, vipAmberStripMat)
      box(1.25, 0.24, 1.25, -9.8, 0.56, 0.4, chromeMat)
      box(1.0, 0.04, 0.78, -9.8, 0.84, 0.4, vipOliveGlowMat)
      for (let i = 0; i < 5; i++) {
        box(0.11, 0.9, 0.11, -7.4, 0.55, -3.7 + i * 1.7, railMat)
        if (i < 4) box(0.08, 0.08, 1.35, -7.4, 0.96, -2.85 + i * 1.7, basic(0x31452c, 0.42))
      }

      const mezzanineFloorMat = mat(0x11140f, 0x060704, 0.24)
      const mezzanineTrimMat = mat(0x20241d, 0x0d1209, 0.36)
      const glassMat = basic(0x31452c, 0.22)
      box(13.9, 0.24, 4.85, 0, vipLevelY(2.94), vipLevelZ(-7.55), mezzanineFloorMat)
      box(10.2, 0.12, 0.16, 0, vipLevelY(3.11), vipLevelZ(-5.12), mezzanineTrimMat)
      box(13.95, 0.12, 0.16, 0, vipLevelY(3.11), vipLevelZ(-9.98), mezzanineTrimMat)
      box(0.16, 0.12, 4.85, -6.98, vipLevelY(3.11), vipLevelZ(-7.55), mezzanineTrimMat)
      box(0.16, 0.12, 4.85, 6.98, vipLevelY(3.11), vipLevelZ(-7.55), mezzanineTrimMat)
      box(4.4, 0.12, 0.18, 0, vipLevelY(3.14), vipLevelZ(-6.06), basic(0x101018, 0.85))

      for (let i = 0; i < 8; i++) {
        const x = -6.2 + i * 1.78
        if (Math.abs(x) < 5.35) box(0.1, 1.06, 0.1, x, vipLevelY(3.62), vipLevelZ(-5.16), railMat)
        box(0.1, 1.06, 0.1, x, vipLevelY(3.62), vipLevelZ(-9.9), railMat)
        if (i < 7) {
          if (Math.abs(x + 0.89) < 5.35) box(1.42, 0.09, 0.08, x + 0.89, vipLevelY(4.05), vipLevelZ(-5.16), glassMat)
          box(1.42, 0.09, 0.08, x + 0.89, vipLevelY(4.05), vipLevelZ(-9.9), glassMat)
        }
      }
      for (const x of [-6.98, 6.98]) {
        for (let i = 0; i < 8; i++) {
          box(0.08, 0.09, 0.42, x, vipLevelY(4.05), vipLevelZ(-9.45 + i * 0.58), glassMat)
        }
      }

      for (const side of [-1, 1]) {
        for (let i = 0; i < 7; i++) {
          const t = i / 6
          const y = 0.38 + t * 3.02
          const z = -8.46 - t * 1.62
          box(1.38, 0.18, 0.35, side * 6.28, y, z, mezzanineFloorMat)
        }
        box(0.08, 2.4, 2.2, side * 5.42, 2, -9.27, railMat)
        box(0.08, 2.4, 2.2, side * 7.14, 2, -9.27, railMat)
      }

      box(4.25, 0.42, 0.86, -3.25, vipLevelY(3.34), vipLevelZ(-9.48), redSeatMat)
      box(4.25, 0.72, 0.28, -3.25, vipLevelY(3.78), vipLevelZ(-9.77), redSeatMat)
      box(4.35, 0.05, 0.06, -3.25, vipLevelY(4.16), vipLevelZ(-9.1), vipAmberStripMat)
      box(4.25, 0.42, 0.86, 3.25, vipLevelY(3.34), vipLevelZ(-9.48), redSeatMat)
      box(4.25, 0.72, 0.28, 3.25, vipLevelY(3.78), vipLevelZ(-9.77), redSeatMat)
      box(4.35, 0.05, 0.06, 3.25, vipLevelY(4.16), vipLevelZ(-9.1), vipAmberStripMat)
      box(1.55, 0.2, 0.82, 0, vipLevelY(3.32), vipLevelZ(-9.2), chromeMat)
      box(1.25, 0.04, 0.62, 0, vipLevelY(3.62), vipLevelZ(-9.2), vipOliveGlowMat)
      box(2.6, 0.72, 0.62, 0, vipLevelY(3.48), vipLevelZ(-9.78), mat(0x17121a, 0x180c10, 0.4))
      for (let i = 0; i < 5; i++) {
        const bottle = new THREE.Mesh(track(new THREE.CylinderGeometry(0.045, 0.055, 0.3, 7)), basic(i % 2 ? 0x4b2d15 : 0x11140e, 0.95))
        bottle.position.set(-0.8 + i * 0.4, vipLevelY(3.98), vipLevelZ(-9.42))
        scene.add(bottle)
      }
      createNeonSign('VIP LEVEL', 3.6, 0.64, '#6f7c55', 0, vipLevelY(4.35), vipLevelZ(-9.82), 0, false)
    }

    function buildLightingRig() {
      atlasPlane('doorclub_architectural_lighting_garden_atlas_2048x1024.png', 0.24, 0.08, 0.28, 0.14, 8.8, 1.1, 0, 7.36, 3.84, Math.PI, 0.18)
      box(22, 0.13, 0.13, 0, 7.9, -2.5, chromeMat)
      box(22, 0.13, 0.13, 0, 7.9, 3.9, chromeMat)
      for (let i = 0; i < 6; i++) {
        const x = -9 + i * 3.6
        box(0.32, 0.24, 0.5, x, 7.62, -2.5, blackMat)
        box(0.32, 0.24, 0.5, x, 7.62, 3.9, blackMat)
      }
      for (let i = 0; i < 8; i++) {
        const outlineColor = i % 2 === 0 ? 0xd0005b : 0xe040fb
        const beam = new THREE.Mesh(
          track(new THREE.ConeGeometry(1.15, 7.2, 18, 1, true)),
          track(new THREE.MeshBasicMaterial({
            color: outlineColor,
            transparent: true,
            opacity: 0.006,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          })),
        )
        beam.position.set(-9.2 + i * 2.65, 4.35, i % 2 ? 1.7 : -2.9)
        beam.rotation.x = 0
        beam.userData.zone = i % 4
        beam.userData.outlineColor = outlineColor
        scene.add(beam)
        beams.push(beam)
      }
      const beaconSpecs: Array<{ kind: 'amber' | 'green' | 'red'; color: number; x: number; z: number }> = [
        { kind: 'amber', color: 0xff6d1a, x: -11.3, z: -2.2 },
        { kind: 'amber', color: 0xff6d1a, x: 11.3, z: 3.3 },
        { kind: 'green', color: 0x00ff72, x: -11.3, z: 3.5 },
        { kind: 'green', color: 0x00ff72, x: 11.3, z: -2.6 },
        { kind: 'red', color: 0xff1028, x: -5.7, z: 5.0 },
        { kind: 'red', color: 0xff1028, x: 5.7, z: 5.0 },
        { kind: 'red', color: 0xff1230, x: -5.2, z: -8.7 },
        { kind: 'red', color: 0xff1230, x: 5.2, z: -8.7 },
      ]
      beaconSpecs.forEach((spec) => {
        const beacon = new THREE.Mesh(
          track(new THREE.SphereGeometry(0.38, 16, 10)),
          track(new THREE.MeshBasicMaterial({
            color: spec.color,
            transparent: true,
            opacity: 0.18,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          })),
        )
        beacon.position.set(spec.x, 7.55, spec.z)
        beacon.userData.kind = spec.kind
        beacon.userData.phase = beaconMeshes.length * 0.78
        scene.add(beacon)
        beaconMeshes.push(beacon)

        const beaconTarget = new THREE.Object3D()
        beaconTarget.position.set(spec.x * 0.36, 0.06, spec.z * 0.18 - 0.8)
        beaconTarget.userData.baseX = beaconTarget.position.x
        beaconTarget.userData.baseZ = beaconTarget.position.z
        beaconTarget.userData.phase = beacon.userData.phase
        scene.add(beaconTarget)
        beaconTargets.push(beaconTarget)

        const coneHeight = 7.05
        const beaconCone = new THREE.Mesh(
          track(new THREE.ConeGeometry(1.15, coneHeight, 28, 1, true)),
          track(new THREE.MeshBasicMaterial({
            color: spec.color,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
          })),
        )
        beaconCone.position.set((spec.x + beaconTarget.position.x) / 2, 3.82, (spec.z + beaconTarget.position.z) / 2)
        beaconCone.userData.kind = spec.kind
        beaconCone.userData.sourceX = spec.x
        beaconCone.userData.sourceY = 7.42
        beaconCone.userData.sourceZ = spec.z
        beaconCone.userData.target = beaconTarget
        beaconCone.userData.phase = beacon.userData.phase
        scene.add(beaconCone)
        beaconConeMeshes.push(beaconCone)

        const beaconLight = new THREE.SpotLight(spec.color, 0, 38, 0.46, 0.68, 0.88)
        beaconLight.position.set(spec.x, 7.42, spec.z)
        beaconLight.target = beaconTarget
        scene.add(beaconLight)
        if (spec.kind === 'amber') {
          amberBeaconLights.push(beaconLight)
        } else if (spec.kind === 'green') {
          greenBeaconLights.push(beaconLight)
        } else {
          redBreakdownLights.push(beaconLight)
        }
      })
    }

    function buildSmoke() {
      const smokeAtlas = doorclubTexture('doorclub_soft_smoke_garden_haze_sprite_atlas_2048.png')
      smokeAtlas.wrapS = THREE.ClampToEdgeWrapping
      smokeAtlas.wrapT = THREE.ClampToEdgeWrapping
      const smokeFrames: THREE.Texture[] = []
      const smokeAlphaFrames: THREE.Texture[] = []
      const cols = 3
      const rows = 6
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const frame = track(smokeAtlas.clone())
          frame.repeat.set(1 / cols, 1 / rows)
          frame.offset.set(col / cols, 1 - (row + 1) / rows)
          frame.needsUpdate = true
          smokeFrames.push(frame)

          const alphaFrame = track(smokeAtlas.clone())
          alphaFrame.colorSpace = THREE.NoColorSpace
          alphaFrame.repeat.set(1 / cols, 1 / rows)
          alphaFrame.offset.set(col / cols, 1 - (row + 1) / rows)
          alphaFrame.needsUpdate = true
          smokeAlphaFrames.push(alphaFrame)
        }
      }
      const material = track(new THREE.SpriteMaterial({
        map: smokeFrames[0],
        alphaMap: smokeAlphaFrames[0],
        color: 0xb8b0a2,
        transparent: true,
        opacity: 0,
        alphaTest: 0.012,
        depthWrite: false,
        blending: THREE.NormalBlending,
      }))
      const emitters = [
        { x: -6.9, z: -4.7, dirX: 0.83, dirZ: 0.56 },
        { x: 6.9, z: -4.6, dirX: -0.83, dirZ: 0.56 },
        { x: -5.8, z: 4.8, dirX: 0.77, dirZ: -0.64 },
        { x: 5.8, z: 4.7, dirX: -0.77, dirZ: -0.64 },
      ]
      emitters.forEach((emitter) => {
        box(0.62, 0.22, 0.42, emitter.x, 0.16, emitter.z, mat(0x11100d, 0x090704, 0.18))
        box(0.38, 0.08, 0.1, emitter.x, 0.32, emitter.z, basic(0x5a3518, 0.35))
      })
      for (let i = 0; i < 192; i++) {
        const emitter = emitters[i % emitters.length]
        const sprite = new THREE.Sprite(material.clone())
        const spriteMaterial = sprite.material as THREE.SpriteMaterial
        const frameIndex = i % smokeFrames.length
        spriteMaterial.map = smokeFrames[frameIndex]
        spriteMaterial.alphaMap = smokeAlphaFrames[frameIndex]
        spriteMaterial.needsUpdate = true
        const age = 99
        sprite.position.set(
          emitter.x + (Math.random() - 0.5) * 0.35,
          0.3 + Math.random() * 0.2,
          emitter.z + (Math.random() - 0.5) * 0.35,
        )
        sprite.visible = false
        sprite.scale.setScalar(1.4 + Math.random() * 1.2)
        sprite.userData.seed = Math.random() * TAU
        sprite.userData.baseX = emitter.x
        sprite.userData.baseZ = emitter.z
        sprite.userData.dirX = emitter.dirX
        sprite.userData.dirZ = emitter.dirZ
        sprite.userData.age = age
        sprite.userData.power = 0
        scene.add(sprite)
        smokeSprites.push(sprite)
        disposables.push(sprite.material)
      }
    }

    return () => {
      sceneDisposed = true
      cancelAnimationFrame(animId)
      window.cancelAnimationFrame(initialResizeFrame)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onTouchEnd)
      if ((window as any).__clubJoy) delete (window as any).__clubJoy
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.isMesh) {
          mesh.geometry?.dispose()
          const material = mesh.material
          if (Array.isArray(material)) material.forEach((m) => m.dispose())
          else material?.dispose()
        }
      })
      disposables.forEach((d) => d.dispose())
      renderer.dispose()
    }
  }, [
    admitted,
    avatarConfig?.bodyTextureUrl,
    avatarConfig?.bottomColor,
    avatarConfig?.faceTextureUrl,
    avatarConfig?.hairColor,
    avatarConfig?.modelUrl,
    avatarConfig?.shoesColor,
    avatarConfig?.skinTone,
    avatarConfig?.topColor,
    role,
  ])

  useEffect(() => {
    if (!admitted) return
    let cancelled = false

    gameClient.setCallbacks({
      onWelcome: (id, players, myX, myZ, role, queue, _cooldownUntil, gameplay, myFloorLevel) => {
        setMyPlayerId(id)
        if (myX !== undefined && myZ !== undefined) teleportFn.current(myX, myZ, myFloorLevel)
        players.forEach((p) => spawnFn.current(p))
        setPlayerCount(players.length + 1)
        if (role) usePlayerStore.getState().setRole(role as any)
        if (queue) applyQueue(queue)
        if (gameplay) applyGameplayState(gameplay)
      },
      onPlayerJoined: (p) => {
        spawnFn.current(p)
        setPlayerCount((count) => count + 1)
      },
      onPlayerMoved: (id, x, z, rotY, moving, musicDanceIntensity, floorLevel) => moveFn.current(id, x, z, rotY, moving, musicDanceIntensity, floorLevel),
      onSelfPosition: (x, z, rotY, moving, _musicDanceIntensity, floorLevel) => selfPositionFn.current(x, z, floorLevel, rotY, moving),
      onPlayerLeft: (id) => {
        removeFn.current(id)
        setPlayerCount((count) => Math.max(1, count - 1))
      },
      onQueueUpdate: (queue) => applyQueue(queue),
      onQueueJoined: () => {},
      onQueueLeft: () => {},
      onQueueDenied: () => {},
      onAdmitted: () => {},
      onDenied: () => {},
      onRoleChanged: (role) => usePlayerStore.getState().setRole(role as any),
      onAvatarUpdated: (id, faceUrl, bodyUrl, topColor, bottomColor, modelUrl) => {
        updateRemoteRef.current(id, faceUrl, bodyUrl, topColor, bottomColor, modelUrl)
      },
      onDisplayNameChanged: (id, displayName) => {
        if (id === gameClient.id) {
          usePlayerStore.getState().setDisplayName(displayName)
          updatePlayerNameRef.current(displayName)
        } else {
          updateRemoteNameRef.current(id, displayName)
        }
      },
      onDjNameChanged: (id, djName) => {
        if (id === gameClient.id) usePlayerStore.getState().setDjName(djName)
        updateDjBoothNameRef.current(djName)
      },
      onGameplayState: (state) => applyGameplayState(state),
      onGameplayEvent: (event) => handleGameplayEvent(event),
      onForcedOutside: (reason) => {
        sessionStorage.removeItem('doorclub-admitted')
        sessionStorage.removeItem(CLUB_POSITION_SESSION_KEY)
        sessionStorage.setItem('doorclub-outside-returned-from-club', '1')
        usePlayerStore.getState().setStatus('outside')
        setClubToast(reason === 'security' ? 'Security вывел тебя наружу' : 'Ты выведен наружу')
        navigate('/outside', { replace: true })
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
      const lastClubPosition = readStoredClubPosition()
      gameClient.connect(getGameServerUrl(), {
        room:           'club',
        userId:         store.userId ?? '',
        displayName:    store.displayName,
        topColor:       config?.topColor       ?? '#222244',
        bottomColor:    config?.bottomColor    ?? '#111133',
        hairColor:      config?.hairColor      ?? '#1a1008',
        skinTone:       config?.skinTone       ?? '#c8956c',
        faceTextureUrl: config?.faceTextureUrl ?? '',
        bodyTextureUrl: config?.bodyTextureUrl ?? '',
        modelUrl:       config?.modelUrl       ?? '',
        role:           store.role,
        djName:         store.djName || store.displayName || 'DJ',
        lastX:          lastClubPosition?.x,
        lastZ:          lastClubPosition?.z,
        lastFloorLevel: lastClubPosition?.floorLevel,
      }).catch(e => console.warn('WS club offline:', e.message))
    }

    connect()
    return () => {
      cancelled = true
      setMyPlayerId(null)
      gameClient.disconnect()
    }
  }, [admitted])

  const leaveClub = () => {
    sessionStorage.removeItem('doorclub-admitted')
    sessionStorage.removeItem(CLUB_POSITION_SESSION_KEY)
    sessionStorage.setItem('doorclub-outside-returned-from-club', '1')
    usePlayerStore.getState().setStatus('outside')
    navigate('/outside')
  }

  const chooseDance = (danceId: DanceId) => {
    if (danceMode && selectedDance === danceId) {
      setDanceMode(false)
      setDanceMenuOpen(false)
      return
    }
    setSelectedDance(danceId)
    setDanceMode(true)
    setDanceMenuOpen(false)
  }

  const applyQueue = (nextQueue: QueueEntry[]) => {
    setQueue(nextQueue)
    setSelectedQueueId((current) => (
      current && nextQueue.some((entry) => entry.id === current) ? current : null
    ))
  }

  const applyGameplayState = (state: GameplayState) => {
    if (typeof state.clubEnergy === 'number') setClubEnergy(state.clubEnergy)
    if (typeof state.clublesBalance === 'number') {
      usePlayerStore.getState().setClublesBalance(state.clublesBalance)
    }
    if (typeof state.lockscreenMusicUntil === 'number') {
      usePlayerStore.getState().setLockscreenMusicUntil(state.lockscreenMusicUntil)
    }
    if (Array.isArray(state.drinkMenu) && state.drinkMenu.length) setDrinkMenu(state.drinkMenu)
    if (Array.isArray(state.drinks)) setMyDrinks(state.drinks)
    if (Array.isArray(state.barOrders)) setBarOrders(state.barOrders)
    if (state.bartenderStats) setBartenderStats(state.bartenderStats)
    if (Array.isArray(state.managementPlayers)) setManagementPlayers(state.managementPlayers)
  }

  const handleGameplayEvent = (event: GameplayEvent) => {
    if (typeof event.clubEnergy === 'number') setClubEnergy(event.clubEnergy)
    if (typeof event.clublesBalance === 'number') {
      usePlayerStore.getState().setClublesBalance(event.clublesBalance)
    }
    if (typeof event.lockscreenMusicUntil === 'number') {
      usePlayerStore.getState().setLockscreenMusicUntil(event.lockscreenMusicUntil)
    }
    if (event.roleSlots) {
      // role slots arrive with most gameplay events; the compact HUD does not render them yet.
    }
    if (event.text) setClubToast(event.text)
    if (event.kind === 'drinkConsumed' && event.actorId === gameClient.id) {
      const effect = drinkMenu.find((drink) => drink.id === event.drinkId)?.effect ?? 'spark'
      const durationMs = Math.max(1000, Math.min(DRINK_EFFECT_DURATION_MS, Number(event.drinkEffectDurationMs) || DRINK_EFFECT_DURATION_MS))
      drinkEffectDurationRef.current = durationMs
      setDrinkEffect(effect)
      setDrinkEffectKey((key) => key + 1)
      playDrinkAudioEffect(effect, durationMs)
    }
  }

  const orderDrink = (drink: DrinkMenuItem, tip: number) => {
    gameClient.gameplayAction('orderDrink', { drinkId: drink.id, tip })
    setClubToast(`${drink.name}: заказ отправляется`)
  }

  const serveBarOrder = (order: BarOrder) => {
    gameClient.gameplayAction('serveDrink', { orderId: order.id })
  }

  const cancelBarOrder = (order: BarOrder) => {
    gameClient.gameplayAction('cancelBarOrder', { orderId: order.id })
  }

  const sipDrink = (drink: PlayerDrink, amount: number) => {
    gameClient.gameplayAction('drinkSip', { drinkInstanceId: drink.id, amount })
    setClubToast(`${drink.drinkName}: пьём ${Math.round(amount * 100)}%`)
  }

  const giftDrink = (drink: PlayerDrink, targetId: string) => {
    gameClient.gameplayAction('giftDrink', { drinkInstanceId: drink.id, targetId })
  }

  const addFaceLog = (message: string) => {
    setFaceLog((current) => [`${new Date().toLocaleTimeString('ru')}  ${message}`, ...current].slice(0, 24))
  }

  const approveQueueEntry = (entry: QueueEntry) => {
    gameClient.approve(entry.id)
    addFaceLog(`Впустил ${entry.displayName}`)
    setSelectedQueueId(null)
  }

  const denyQueueEntry = (entry: QueueEntry, reason: string) => {
    gameClient.deny(entry.id, reason)
    addFaceLog(`Отказал ${entry.displayName}: ${reason}`)
    setSelectedQueueId(null)
  }

  const runManagementAction = (action: string, payload: object = {}) => {
    gameClient.managementAction(action, payload)
  }

  const setManagedDrinkPrice = (drinkId: string, price: number) => {
    gameClient.managementAction('setDrinkPrice', { drinkId, price })
  }

  const selectedDanceOption = DANCE_OPTIONS.find((option) => option.id === selectedDance) ?? DANCE_OPTIONS[0]

  if (!admitted) return null

  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh', minHeight: '100svh', overflow: 'hidden', background: '#030309' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

      <div style={{ position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 10px)', left: 12, right: 12, display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none', zIndex: 160 }}>
        <div style={{
          minWidth: 0,
          flex: '1 1 auto',
          background: 'rgba(3,3,9,0.78)',
          border: '1px solid rgba(135,91,45,0.34)',
          borderRadius: 4,
          padding: '7px 12px',
          color: '#d8d0c2',
          fontFamily: 'monospace',
          fontSize: 10,
          letterSpacing: 2,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {CLUB_NAME} / {ZONE_LABELS[zone]}{zone === 'dj' ? ` / ${currentBpm === null ? '...' : currentBpm.toFixed(1)} BPM` : ''} / {displayName || 'GUEST'} / {clublesBalance} КЛБ / {playerCount} online
        </div>
        <button onClick={leaveClub} style={{ ...hudButton('#2a2a3a', '#8f95aa'), minWidth: 86, pointerEvents: 'auto' }}>НАРУЖУ</button>
      </div>

      <div style={{ position: 'absolute', right: 16, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 34px)', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch', zIndex: 150 }}>
        {danceMenuOpen && (
          <div style={danceMenuStyle}>
            {DANCE_OPTIONS.map((option) => {
              const active = danceMode && selectedDance === option.id
              return (
                <button
                  key={option.id}
                  onClick={() => chooseDance(option.id)}
                  style={hudButton(active ? '#9a551c' : '#171510', active ? '#070704' : '#d8d0c2')}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        )}
        <button onClick={() => setDanceMenuOpen((open) => !open)} style={hudButton(danceMode ? '#9a551c' : '#2a2a3a', danceMode ? '#070704' : '#8f95aa')}>
          {danceMode ? `ТАНЕЦ ${selectedDanceOption.shortLabel}` : 'ТАНЕЦ'}
        </button>
        <button
          onClick={() => {
            if (isBartender) setBartenderPanelOpen((open) => !open)
            else setBarCustomerOpen((open) => !open)
          }}
          style={hudButton(zone === 'bar' || barCustomerOpen || (isBartender && bartenderPanelOpen) ? '#ffb347' : '#2a2a3a', zone === 'bar' || barCustomerOpen || (isBartender && bartenderPanelOpen) ? '#07070c' : '#8f95aa')}
        >
          БАР
        </button>
        <button style={hudButton(zone === 'vip' ? '#426b43' : '#2a2a3a', zone === 'vip' ? '#070704' : '#8f95aa')}>VIP</button>
        {canUseManagementPanel && (
          <button
            onClick={() => setManagementPanelOpen((open) => !open)}
            style={hudButton(managementPanelOpen ? '#7cffc4' : '#2a2a3a', managementPanelOpen ? '#06100a' : '#8f95aa')}
          >
            OPS
          </button>
        )}
      </div>

      {canUseManagementPanel && managementPanelOpen && (
        <ManagementPanel
          role={role}
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

      {barCustomerOpen && !isBartender && (
        <BarCustomerPanel
          balance={clublesBalance}
          menu={drinkMenu}
          drinks={myDrinks}
          nearbyPlayers={nearbyPlayers}
          nearBar={zone === 'bar'}
          onOrder={orderDrink}
          onSip={sipDrink}
          onGift={giftDrink}
          onClose={() => setBarCustomerOpen(false)}
        />
      )}

      {isDj && (
        <>
          <div style={{ ...djPanelMountStyle, display: djPanelMinimized ? 'none' : 'block' }}>
            <DJBoothPanel embedded onMinimize={() => setDjPanelMinimized(true)} />
          </div>
          {djPanelMinimized && (
            <button
              type="button"
              onClick={() => setDjPanelMinimized(false)}
              style={djBadgeButtonStyle}
              aria-label="Open DJ panel"
            >
              DJ
            </button>
          )}
        </>
      )}

      {isFaceControl && (
        <>
          {facePanelOpen && (
            <FaceControlPanel
              queue={queue}
              selected={selectedQueueEntry}
              log={faceLog}
              onSelect={(entry) => setSelectedQueueId(entry.id)}
              onApprove={approveQueueEntry}
              onDeny={denyQueueEntry}
              onClose={() => setFacePanelOpen(false)}
            />
          )}
          {!facePanelOpen && (
            <button
              type="button"
              onClick={() => setFacePanelOpen(true)}
              style={{ ...djBadgeButtonStyle, top: 'calc(env(safe-area-inset-top, 0px) + 144px)', background: 'radial-gradient(circle at 35% 25%, rgba(124,255,196,0.94), rgba(8,8,18,0.94) 68%)', borderColor: 'rgba(124,255,196,0.58)', boxShadow: '0 0 28px rgba(124,255,196,0.28)', fontSize: 11 }}
              aria-label="Open facecontrol panel"
            >
              FACE
            </button>
          )}
        </>
      )}

      {isBartender && (
        <>
          {bartenderPanelOpen && (
            <BartenderPanel
              balance={clublesBalance}
              orders={barOrders}
              stats={bartenderStats}
              onServe={serveBarOrder}
              onCancel={cancelBarOrder}
              onClose={() => setBartenderPanelOpen(false)}
            />
          )}
          {!bartenderPanelOpen && (
            <button
              type="button"
              onClick={() => setBartenderPanelOpen(true)}
              style={{ ...djBadgeButtonStyle, top: 'calc(env(safe-area-inset-top, 0px) + 144px)', background: 'radial-gradient(circle at 35% 25%, rgba(255,179,71,0.96), rgba(8,8,18,0.94) 68%)', borderColor: 'rgba(255,179,71,0.62)', boxShadow: '0 0 28px rgba(255,179,71,0.28)', fontSize: 11 }}
              aria-label="Open bartender panel"
            >
              BAR
            </button>
          )}
        </>
      )}

      {clubToast && <div style={clubToastStyle}>{clubToast}</div>}
      {drinkEffect && <div style={{ ...drinkEffectStyle, ...drinkEffectTone(drinkEffect) }} />}

      <VoiceChat myPlayerId={myPlayerId} environment="club" />
      <AdminDebugOverlay />
      <Joystick onMove={(x, z) => { if ((window as any).__clubJoy) (window as any).__clubJoy(x, z) }} />
    </div>
  )
}

function hudButton(background: string, color: string): CSSProperties {
  return {
    minWidth: 76,
    minHeight: 32,
    padding: '8px 10px',
    borderRadius: 4,
    border: '1px solid rgba(255,255,255,0.14)',
    background,
    color,
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.7,
    cursor: 'pointer',
  }
}

function FaceControlPanel({
  queue,
  selected,
  log,
  onSelect,
  onApprove,
  onDeny,
  onClose,
}: {
  queue: QueueEntry[]
  selected: QueueEntry | null
  log: string[]
  onSelect: (entry: QueueEntry) => void
  onApprove: (entry: QueueEntry) => void
  onDeny: (entry: QueueEntry, reason: string) => void
  onClose: () => void
}) {
  return (
    <div style={facePanelStyle}>
      <div style={facePanelHeaderStyle}>
        <div style={{ color: '#7cffc4', letterSpacing: 2, fontSize: 12 }}>FACECONTROL</div>
        <button type="button" onClick={onClose} style={facePanelCloseStyle}>MIN</button>
      </div>

      <div style={facePanelBodyStyle}>
        <div style={faceQueueListStyle}>
          <div style={faceColumnTitleStyle}>QUEUE / {queue.length}</div>
          {queue.length === 0 && <div style={faceEmptyStyle}>пусто</div>}
          {queue.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onSelect(entry)}
              style={{
                ...faceQueueItemStyle,
                borderColor: selected?.id === entry.id ? '#7cffc4' : 'rgba(255,255,255,0.12)',
                background: selected?.id === entry.id ? 'rgba(124,255,196,0.12)' : 'rgba(255,255,255,0.035)',
              }}
            >
              <span style={{ ...faceAvatarDotStyle, background: entry.topColor }} />
              <span style={{ minWidth: 0 }}>
                <span style={faceQueueNameStyle}>{entry.displayName}</span>
                <span style={faceQueuePosStyle}>#{entry.pos}</span>
              </span>
            </button>
          ))}
        </div>

        <div style={faceDecisionStyle}>
          {!selected ? (
            <div style={faceEmptyStyle}>выбери игрока</div>
          ) : (
            <>
              <div style={{ color: '#e8e8f0', fontSize: 14, marginBottom: 4 }}>{selected.displayName}</div>
              <div style={{ color: '#5b6474', fontSize: 11, marginBottom: 14 }}>#{selected.pos} в очереди</div>
              <div style={faceAvatarPreviewStyle}>
                <AvatarMini entry={selected} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button type="button" onClick={() => onApprove(selected)} style={faceApproveStyle}>ВПУСТИТЬ</button>
                <button type="button" onClick={() => onDeny(selected, 'vibe_check')} style={faceDenyStyle}>ОТКАЗАТЬ</button>
              </div>
              <div style={faceReasonsStyle}>
                {FACE_CONTROL_REASONS.map((reason) => (
                  <button key={reason.code} type="button" onClick={() => onDeny(selected, reason.code)} style={faceReasonButtonStyle}>
                    {reason.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div style={faceLogStyle}>
          <div style={faceColumnTitleStyle}>LOG</div>
          {log.length === 0 && <div style={faceEmptyStyle}>нет действий</div>}
          {log.map((entry, index) => (
            <div key={`${entry}-${index}`} style={faceLogEntryStyle}>{entry}</div>
          ))}
        </div>
      </div>
    </div>
  )
}

const OWNER_ROLE_OPTIONS = ['guest', 'bouncer', 'guard', 'dj', 'bartender', 'vip']
const ADMIN_ROLE_OPTIONS = ['guest', 'bouncer', 'guard', 'dj', 'bartender', 'vip', 'owner', 'admin']

export function ManagementPanel({
  role,
  activeTab,
  players,
  queue,
  drinkMenu,
  clubEnergy,
  onTabChange,
  onApprove,
  onDeny,
  onAction,
  onSetDrinkPrice,
  onClose,
}: {
  role: string
  activeTab: ManagementTab
  players: ManagementPlayer[]
  queue: QueueEntry[]
  drinkMenu: DrinkMenuItem[]
  clubEnergy: number
  onTabChange: (tab: ManagementTab) => void
  onApprove: (entry: QueueEntry) => void
  onDeny: (entry: QueueEntry, reason: string) => void
  onAction: (action: string, payload?: object) => void
  onSetDrinkPrice: (drinkId: string, price: number) => void
  onClose: () => void
}) {
  const canSecurity = role === 'guard' || role === 'bouncer' || role === 'owner' || role === 'admin'
  const canOwner = role === 'owner' || role === 'admin'
  const canAdmin = role === 'admin'
  const tabs: Array<{ id: ManagementTab; label: string; enabled: boolean }> = [
    { id: 'security', label: 'SECURITY', enabled: canSecurity },
    { id: 'owner', label: 'OWNER', enabled: canOwner },
    { id: 'admin', label: 'ADMIN', enabled: canAdmin },
  ]
  const currentTab = tabs.some((tab) => tab.id === activeTab && tab.enabled)
    ? activeTab
    : tabs.find((tab) => tab.enabled)?.id ?? 'security'
  const [selectedPlayerId, setSelectedPlayerId] = useState('')
  const visiblePlayers = currentTab === 'security'
    ? players.filter((player) => player.room === 'club')
    : players
  const selectedPlayer = visiblePlayers.find((player) => player.id === selectedPlayerId) ?? visiblePlayers[0] ?? null
  const roleOptions = canAdmin ? ADMIN_ROLE_OPTIONS : OWNER_ROLE_OPTIONS
  const staffCount = players.filter((player) => ['bouncer', 'guard', 'dj', 'bartender'].includes(player.role)).length
  const insideCount = players.filter((player) => player.room === 'club').length
  const outsideCount = players.filter((player) => player.room === 'outside').length

  return (
    <div style={managementPanelStyle}>
      <div style={managementHeaderStyle}>
        <div>
          <div style={{ color: '#7cffc4', letterSpacing: 2, fontSize: 12 }}>DOOR//CLUB OPS</div>
          <div style={{ color: '#5b6474', fontSize: 10, marginTop: 4 }}>
            inside {insideCount} / outside {outsideCount} / staff {staffCount}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {tabs.filter((tab) => tab.enabled).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              style={managementTabButtonStyle(tab.id === currentTab)}
            >
              {tab.label}
            </button>
          ))}
          <button type="button" onClick={onClose} style={facePanelCloseStyle}>MIN</button>
        </div>
      </div>

      {currentTab === 'security' && (
        <div style={managementBodyStyle}>
          <div style={managementColumnStyle}>
            <div style={faceColumnTitleStyle}>QUEUE / {queue.length}</div>
            {queue.length === 0 && <div style={faceEmptyStyle}>пусто</div>}
            {queue.map((entry) => (
              <div key={entry.id} style={managementQueueItemStyle}>
                <span style={{ ...faceAvatarDotStyle, background: entry.topColor }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={faceQueueNameStyle}>{entry.displayName}</div>
                  <div style={faceQueuePosStyle}>#{entry.pos}</div>
                </div>
                <button type="button" onClick={() => onApprove(entry)} style={managementSmallGoodButtonStyle}>IN</button>
                <button type="button" onClick={() => onDeny(entry, 'vibe_check')} style={managementSmallBadButtonStyle}>NO</button>
              </div>
            ))}
          </div>

          <div style={managementColumnStyle}>
            <div style={faceColumnTitleStyle}>FLOOR / {visiblePlayers.length}</div>
            {visiblePlayers.map((player) => (
              <button
                key={player.id}
                type="button"
                onClick={() => setSelectedPlayerId(player.id)}
                style={managementPlayerRowStyle(selectedPlayer?.id === player.id)}
              >
                <span style={{ ...faceAvatarDotStyle, width: 22, height: 22, background: player.topColor }} />
                <span style={{ minWidth: 0 }}>
                  <span style={faceQueueNameStyle}>{player.displayName}</span>
                  <span style={faceQueuePosStyle}>{roleLabel(player.role)} / {player.floorLevel} / {player.x}, {player.z}</span>
                </span>
              </button>
            ))}
          </div>

          <div style={managementActionColumnStyle}>
            <SelectedPlayerCard player={selectedPlayer} />
            {selectedPlayer && (
              <>
                <button type="button" onClick={() => onAction('warnPlayer', { targetId: selectedPlayer.id })} style={managementActionButtonStyle}>
                  WARN
                </button>
                <button type="button" onClick={() => onAction('escortOutside', { targetId: selectedPlayer.id })} style={managementDangerButtonStyle}>
                  OUTSIDE
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {currentTab === 'owner' && (
        <div style={managementBodyStyle}>
          <div style={managementColumnStyle}>
            <div style={faceColumnTitleStyle}>CLUB</div>
            <div style={managementMetricStyle}>
              <span>ENERGY</span>
              <strong>{Math.round(clubEnergy * 100)}%</strong>
            </div>
            <div style={managementButtonGridStyle}>
              {[0.42, 0.7, 0.94].map((value) => (
                <button key={value} type="button" onClick={() => onAction('setClubEnergy', { value })} style={managementActionButtonStyle}>
                  {Math.round(value * 100)}%
                </button>
              ))}
            </div>
            <div style={{ ...faceColumnTitleStyle, marginTop: 16 }}>BAR PRICES</div>
            {drinkMenu.filter((drink) => !isLockscreenMusicService(drink)).map((drink) => (
              <div key={drink.id} style={managementPriceRowStyle}>
                <span>{drink.name}</span>
                <strong>{drink.price}</strong>
                <button type="button" onClick={() => onSetDrinkPrice(drink.id, drink.price - 10)} style={managementTinyButtonStyle}>-</button>
                <button type="button" onClick={() => onSetDrinkPrice(drink.id, drink.price + 10)} style={managementTinyButtonStyle}>+</button>
              </div>
            ))}
          </div>

          <div style={managementColumnStyle}>
            <div style={faceColumnTitleStyle}>PLAYERS / {players.length}</div>
            {players.map((player) => (
              <button
                key={player.id}
                type="button"
                onClick={() => setSelectedPlayerId(player.id)}
                style={managementPlayerRowStyle(selectedPlayer?.id === player.id)}
              >
                <span style={{ ...faceAvatarDotStyle, width: 22, height: 22, background: player.topColor }} />
                <span style={{ minWidth: 0 }}>
                  <span style={faceQueueNameStyle}>{player.displayName}</span>
                  <span style={faceQueuePosStyle}>{roleLabel(player.role)} / {player.room}</span>
                </span>
              </button>
            ))}
          </div>

          <div style={managementActionColumnStyle}>
            <SelectedPlayerCard player={selectedPlayer} />
            {selectedPlayer && (
              <>
                <div style={managementButtonGridStyle}>
                  {roleOptions.map((nextRole) => (
                    <button
                      key={nextRole}
                      type="button"
                      onClick={() => onAction('setPlayerRole', { targetId: selectedPlayer.id, role: nextRole })}
                      style={managementRoleButtonStyle(selectedPlayer.role === nextRole)}
                    >
                      {roleLabel(nextRole)}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => onAction('grantVip', { targetId: selectedPlayer.id })} style={managementActionButtonStyle}>
                  VIP ON
                </button>
                <button type="button" onClick={() => onAction('revokeVip', { targetId: selectedPlayer.id })} style={managementActionButtonStyle}>
                  VIP OFF
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {currentTab === 'admin' && (
        <div style={managementBodyStyle}>
          <div style={{ ...managementColumnStyle, gridColumn: 'span 2' }}>
            <div style={faceColumnTitleStyle}>ALL PLAYERS / {players.length}</div>
            <div style={managementAdminGridStyle}>
              {players.map((player) => (
                <button
                  key={player.id}
                  type="button"
                  onClick={() => setSelectedPlayerId(player.id)}
                  style={managementPlayerRowStyle(selectedPlayer?.id === player.id)}
                >
                  <span style={{ ...faceAvatarDotStyle, width: 22, height: 22, background: player.topColor }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={faceQueueNameStyle}>{player.displayName}</span>
                    <span style={faceQueuePosStyle}>{roleLabel(player.role)} / {player.room} / {player.clublesBalance} КЛБ</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div style={managementActionColumnStyle}>
            <SelectedPlayerCard player={selectedPlayer} />
            {selectedPlayer && (
              <>
                <div style={managementButtonGridStyle}>
                  {ADMIN_ROLE_OPTIONS.map((nextRole) => (
                    <button
                      key={nextRole}
                      type="button"
                      onClick={() => onAction('setPlayerRole', { targetId: selectedPlayer.id, role: nextRole })}
                      style={managementRoleButtonStyle(selectedPlayer.role === nextRole)}
                    >
                      {roleLabel(nextRole)}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => onAction('warnPlayer', { targetId: selectedPlayer.id })} style={managementActionButtonStyle}>
                  WARN
                </button>
                <button type="button" onClick={() => onAction('escortOutside', { targetId: selectedPlayer.id })} style={managementDangerButtonStyle}>
                  KICK OUT
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SelectedPlayerCard({ player }: { player: ManagementPlayer | null }) {
  if (!player) return <div style={faceEmptyStyle}>нет игрока</div>
  return (
    <div style={managementSelectedCardStyle}>
      <div style={{ ...faceAvatarDotStyle, width: 34, height: 34, background: player.topColor }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: '#e8e8f0', fontSize: 13, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis' }}>{player.displayName}</div>
        <div style={{ color: '#5b6474', fontSize: 10, marginTop: 4 }}>{roleLabel(player.role)} / {player.room}</div>
        <div style={{ color: '#5b6474', fontSize: 10, marginTop: 3 }}>{player.floorLevel} / {player.x}, {player.z}</div>
      </div>
    </div>
  )
}

function roleLabel(role: string) {
  if (role === 'bouncer') return 'FACE'
  if (role === 'guard') return 'SEC'
  if (role === 'bartender') return 'BAR'
  return role.toUpperCase()
}

function BarCustomerPanel({
  balance,
  menu,
  drinks,
  nearbyPlayers,
  nearBar,
  onOrder,
  onSip,
  onGift,
  onClose,
}: {
  balance: number
  menu: DrinkMenuItem[]
  drinks: PlayerDrink[]
  nearbyPlayers: NearbyPlayer[]
  nearBar: boolean
  onOrder: (drink: DrinkMenuItem, tip: number) => void
  onSip: (drink: PlayerDrink, amount: number) => void
  onGift: (drink: PlayerDrink, targetId: string) => void
  onClose: () => void
}) {
  const [tip, setTip] = useState(20)
  const [sipAmounts, setSipAmounts] = useState<Record<string, number>>({})
  const [giftTargets, setGiftTargets] = useState<Record<string, string>>({})

  return (
    <div style={barCustomerPanelStyle}>
      <div style={barPanelHeaderStyle}>
        <div>
          <div style={{ color: '#ffb347', letterSpacing: 2, fontSize: 12 }}>BAR / КЛУБЛИ</div>
          <div style={{ color: '#8f95aa', fontSize: 10, marginTop: 4 }}>{balance} КЛБ на счету</div>
        </div>
        <button type="button" onClick={onClose} style={facePanelCloseStyle}>MIN</button>
      </div>
      <div style={{ padding: 12 }}>
        {!nearBar && <div style={barWarningStyle}>Подойди к бару, чтобы сделать заказ</div>}
        <label style={barTipLabelStyle}>
          ЧАЕВЫЕ
          <input
            type="number"
            min={0}
            max={500}
            step={10}
            value={tip}
            onChange={(event) => setTip(Math.max(0, Math.min(500, Number(event.target.value) || 0)))}
            style={barTipInputStyle}
          />
        </label>
        <div style={barDrinkGridStyle}>
          {menu.map((drink) => {
            const total = drink.price + tip
            const disabled = !nearBar || total > balance
            return (
              <button
                key={drink.id}
                type="button"
                disabled={disabled}
                onClick={() => onOrder(drink, tip)}
                style={{
                  ...barDrinkButtonStyle,
                  opacity: disabled ? 0.44 : 1,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                <span style={barDrinkNameStyle}>{drink.name}</span>
                <span style={barDrinkMetaStyle}>
                  {drink.price} + {tip} КЛБ
                </span>
                <span style={barDrinkEffectStyle}>{drinkEffectLabel(drink.effect)}</span>
              </button>
            )
          })}
        </div>
        <div style={barInventoryStyle}>
          <div style={faceColumnTitleStyle}>МОИ НАПИТКИ / {drinks.length}</div>
          {drinks.length === 0 && <div style={faceEmptyStyle}>бармен ещё ничего не налил</div>}
          {drinks.map((drink) => {
            const maxPercent = Math.max(1, Math.round(drink.remaining * 100))
            const valuePercent = Math.min(maxPercent, Math.max(1, Math.round((sipAmounts[drink.id] ?? Math.min(0.35, drink.remaining)) * 100)))
            const targetId = giftTargets[drink.id] || nearbyPlayers[0]?.id || ''
            return (
              <div key={drink.id} style={barDrinkInventoryItemStyle}>
                <div style={barDrinkInventoryTopStyle}>
                  <span style={barDrinkNameStyle}>{drink.drinkName}</span>
                  <span style={barDrinkMetaStyle}>{maxPercent}%</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={maxPercent}
                  step={1}
                  value={valuePercent}
                  onChange={(event) => {
                    const next = Math.max(1, Math.min(maxPercent, Number(event.target.value) || 1))
                    setSipAmounts((current) => ({ ...current, [drink.id]: next / 100 }))
                  }}
                  style={barSipRangeStyle}
                />
                <div style={barDrinkInventoryActionsStyle}>
                  <button type="button" onClick={() => onSip(drink, valuePercent / 100)} style={barServeButtonStyle}>
                    ПИТЬ {valuePercent}%
                  </button>
                  <select
                    value={targetId}
                    onChange={(event) => setGiftTargets((current) => ({ ...current, [drink.id]: event.target.value }))}
                    disabled={nearbyPlayers.length === 0}
                    style={barGiftSelectStyle}
                  >
                    {nearbyPlayers.length === 0 ? (
                      <option value="">рядом никого</option>
                    ) : nearbyPlayers.map((player) => (
                      <option key={player.id} value={player.id}>{player.displayName}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!targetId}
                    onClick={() => targetId && onGift(drink, targetId)}
                    style={{ ...barGiftButtonStyle, opacity: targetId ? 1 : 0.45, cursor: targetId ? 'pointer' : 'not-allowed' }}
                  >
                    УГОСТИТЬ
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function BartenderPanel({
  balance,
  orders,
  stats,
  onServe,
  onCancel,
  onClose,
}: {
  balance: number
  orders: BarOrder[]
  stats: { sales: number; tips: number }
  onServe: (order: BarOrder) => void
  onCancel: (order: BarOrder) => void
  onClose: () => void
}) {
  return (
    <div style={bartenderPanelStyle}>
      <div style={barPanelHeaderStyle}>
        <div>
          <div style={{ color: '#ffb347', letterSpacing: 2, fontSize: 12 }}>BARTENDER SHIFT</div>
          <div style={{ color: '#8f95aa', fontSize: 10, marginTop: 4 }}>
            касса {stats.sales} / чаевые {stats.tips} / баланс {balance} КЛБ
          </div>
        </div>
        <button type="button" onClick={onClose} style={facePanelCloseStyle}>MIN</button>
      </div>

      <div style={bartenderBodyStyle}>
        <div style={faceColumnTitleStyle}>ЗАКАЗЫ / {orders.length}</div>
        {orders.length === 0 && <div style={faceEmptyStyle}>ожидаем гостей у бара</div>}
        {orders.map((order) => (
            <div key={order.id} style={barOrderItemStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={barOrderTitleStyle}>{order.drinkName}</div>
                <div style={barOrderMetaStyle}>
                  {order.customerName} / {order.price} КЛБ / tip {order.tip}
                </div>
              </div>
              <div style={barOrderActionsStyle}>
                <button type="button" onClick={() => onServe(order)} style={barServeButtonStyle}>НАЛИТЬ</button>
                <button type="button" onClick={() => onCancel(order)} style={barCancelButtonStyle}>X</button>
              </div>
            </div>
        ))}
      </div>
    </div>
  )
}

function isLockscreenMusicService(item: DrinkMenuItem) {
  return item.kind === 'service'
}

function drinkEffectLabel(effect: DrinkMenuItem['effect']) {
  if (effect === 'service') return 'услуга / 8 часов'
  if (effect === 'bass') return 'бас усиливается'
  if (effect === 'focus') return 'резкий фокус'
  if (effect === 'chill') return 'холодный шлейф'
  return 'неоновая вспышка'
}

function drinkEffectTone(effect: DrinkMenuItem['effect']): CSSProperties {
  if (effect === 'service') return { background: 'radial-gradient(circle, rgba(124,255,196,0.16), rgba(3,3,9,0) 70%)' }
  if (effect === 'bass') return { background: 'radial-gradient(circle, rgba(224,64,251,0.18), rgba(3,3,9,0) 68%)' }
  if (effect === 'focus') return { background: 'radial-gradient(circle, rgba(255,255,255,0.16), rgba(3,3,9,0) 58%)' }
  if (effect === 'chill') return { background: 'radial-gradient(circle, rgba(25,215,255,0.14), rgba(3,3,9,0) 70%)' }
  return { background: 'radial-gradient(circle, rgba(255,179,71,0.18), rgba(224,64,251,0.08), rgba(3,3,9,0) 70%)' }
}

function playDrinkAudioEffect(effect: DrinkMenuItem['effect'], durationMs = DRINK_EFFECT_DURATION_MS) {
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioContextCtor) return
  const ctx = new AudioContextCtor()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const now = ctx.currentTime
  const durationSec = Math.max(0.45, Math.min(DRINK_EFFECT_DURATION_MS, durationMs) / 1000)
  const freq = effect === 'bass' ? 72 : effect === 'focus' ? 620 : effect === 'chill' ? 260 : 440
  osc.type = effect === 'bass' ? 'sine' : 'triangle'
  osc.frequency.setValueAtTime(freq, now)
  osc.frequency.exponentialRampToValueAtTime(effect === 'bass' ? 48 : freq * 1.18, now + Math.min(1.2, durationSec * 0.25))
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.08, now + 0.035)
  gain.gain.exponentialRampToValueAtTime(0.016, now + 0.45)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(now)
  osc.stop(now + durationSec)
  window.setTimeout(() => ctx.close().catch(() => undefined), durationSec * 1000 + 250)
}

const danceMenuStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 6,
  borderRadius: 4,
  border: '1px solid rgba(242,65,255,0.25)',
  background: 'rgba(3,3,9,0.86)',
}

const barCustomerPanelStyle: CSSProperties = {
  position: 'absolute',
  right: 112,
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 34px)',
  width: 'min(360px, calc(100vw - 136px))',
  border: '1px solid rgba(255,179,71,0.36)',
  borderRadius: 8,
  background: 'rgba(8,8,18,0.94)',
  boxShadow: '0 18px 60px rgba(0,0,0,0.45), 0 0 32px rgba(255,179,71,0.12)',
  color: '#e8e8f0',
  fontFamily: 'monospace',
  overflow: 'hidden',
  pointerEvents: 'auto',
  zIndex: 238,
}

const bartenderPanelStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(env(safe-area-inset-top, 0px) + 72px)',
  left: 12,
  width: 'min(620px, calc(100vw - 24px))',
  maxHeight: 'calc(100dvh - 104px)',
  border: '1px solid rgba(255,179,71,0.38)',
  borderRadius: 8,
  background: 'rgba(8,8,18,0.94)',
  boxShadow: '0 18px 60px rgba(0,0,0,0.5), 0 0 32px rgba(255,179,71,0.14)',
  color: '#e8e8f0',
  fontFamily: 'monospace',
  overflow: 'hidden',
  pointerEvents: 'auto',
  zIndex: 243,
}

const barPanelHeaderStyle: CSSProperties = {
  minHeight: 54,
  padding: '0 14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
}

const bartenderBodyStyle: CSSProperties = {
  padding: 12,
  maxHeight: 420,
  overflowY: 'auto',
}

const barWarningStyle: CSSProperties = {
  marginBottom: 10,
  padding: '8px 10px',
  border: '1px solid rgba(255,179,71,0.28)',
  borderRadius: 4,
  color: '#ffcc80',
  fontSize: 10,
  lineHeight: 1.35,
}

const barTipLabelStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  color: '#8f95aa',
  fontSize: 10,
  letterSpacing: 1.4,
  marginBottom: 10,
}

const barTipInputStyle: CSSProperties = {
  minHeight: 34,
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.045)',
  color: '#e8e8f0',
  fontFamily: 'monospace',
  padding: '0 10px',
}

const barDrinkGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
}

const barDrinkButtonStyle: CSSProperties = {
  minHeight: 84,
  border: '1px solid rgba(255,179,71,0.28)',
  borderRadius: 6,
  background: 'rgba(255,179,71,0.08)',
  color: '#ffe1b0',
  fontFamily: 'monospace',
  textAlign: 'left',
  padding: 10,
}

const barDrinkNameStyle: CSSProperties = {
  display: 'block',
  color: '#fff2d6',
  fontSize: 12,
  fontWeight: 800,
  lineHeight: 1.22,
  overflowWrap: 'anywhere',
}

const barDrinkMetaStyle: CSSProperties = {
  display: 'block',
  color: '#ffb347',
  fontSize: 10,
  marginTop: 7,
}

const barDrinkEffectStyle: CSSProperties = {
  display: 'block',
  color: '#6d7280',
  fontSize: 9,
  marginTop: 6,
}

const barInventoryStyle: CSSProperties = {
  marginTop: 12,
  paddingTop: 12,
  borderTop: '1px solid rgba(255,255,255,0.08)',
}

const barDrinkInventoryItemStyle: CSSProperties = {
  marginTop: 8,
  padding: 10,
  border: '1px solid rgba(255,179,71,0.22)',
  borderRadius: 6,
  background: 'rgba(255,179,71,0.055)',
}

const barDrinkInventoryTopStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const barSipRangeStyle: CSSProperties = {
  width: '100%',
  margin: '10px 0',
  accentColor: '#ffb347',
}

const barDrinkInventoryActionsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  gap: 6,
  alignItems: 'center',
}

const barGiftSelectStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 34,
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.045)',
  color: '#e8e8f0',
  fontFamily: 'monospace',
  fontSize: 10,
  padding: '0 8px',
}

const barGiftButtonStyle: CSSProperties = {
  minHeight: 34,
  border: '1px solid rgba(255,179,71,0.28)',
  borderRadius: 4,
  background: 'rgba(255,179,71,0.12)',
  color: '#ffe1b0',
  fontFamily: 'monospace',
  fontSize: 10,
  fontWeight: 900,
}

const barOrderItemStyle: CSSProperties = {
  minHeight: 58,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  marginBottom: 8,
  padding: '9px 10px',
  border: '1px solid rgba(255,179,71,0.22)',
  borderRadius: 6,
  background: 'rgba(255,179,71,0.055)',
}

const barOrderTitleStyle: CSSProperties = {
  color: '#fff2d6',
  fontSize: 13,
  fontWeight: 800,
}

const barOrderMetaStyle: CSSProperties = {
  color: '#8f95aa',
  fontSize: 10,
  marginTop: 4,
}

const barOrderActionsStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  flex: '0 0 auto',
}

const barServeButtonStyle: CSSProperties = {
  minHeight: 34,
  border: 'none',
  borderRadius: 4,
  background: '#ffb347',
  color: '#120b05',
  fontFamily: 'monospace',
  fontSize: 10,
  fontWeight: 900,
  cursor: 'pointer',
}

const barCancelButtonStyle: CSSProperties = {
  width: 34,
  minHeight: 34,
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.06)',
  color: '#8f95aa',
  fontFamily: 'monospace',
  fontWeight: 900,
  cursor: 'pointer',
}

const clubToastStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 132px)',
  transform: 'translateX(-50%)',
  maxWidth: 'min(560px, calc(100vw - 32px))',
  padding: '9px 14px',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 6,
  background: 'rgba(8,8,18,0.86)',
  color: '#e8e8f0',
  fontFamily: 'monospace',
  fontSize: 11,
  textAlign: 'center',
  zIndex: 260,
  pointerEvents: 'none',
}

const drinkEffectStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 80,
  pointerEvents: 'none',
  mixBlendMode: 'screen',
  animation: 'none',
}

const facePanelStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(env(safe-area-inset-top, 0px) + 72px)',
  left: 12,
  width: 'min(880px, calc(100vw - 24px))',
  maxHeight: 'calc(100dvh - 104px)',
  border: '1px solid rgba(124,255,196,0.34)',
  borderRadius: 8,
  background: 'rgba(8,8,18,0.94)',
  boxShadow: '0 18px 60px rgba(0,0,0,0.5), 0 0 32px rgba(124,255,196,0.14)',
  color: '#e8e8f0',
  fontFamily: 'monospace',
  overflow: 'hidden',
  pointerEvents: 'auto',
  zIndex: 242,
}

const facePanelHeaderStyle: CSSProperties = {
  minHeight: 52,
  padding: '0 14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
}

const facePanelBodyStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '220px minmax(280px, 1fr) 190px',
  gap: 12,
  padding: 12,
}

const faceQueueListStyle: CSSProperties = {
  minHeight: 280,
  maxHeight: 420,
  overflowY: 'auto',
}

const faceDecisionStyle: CSSProperties = {
  minHeight: 280,
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.025)',
  padding: 14,
  overflowY: 'auto',
}

const faceAvatarPreviewStyle: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  marginBottom: 12,
}

const faceLogStyle: CSSProperties = {
  minHeight: 280,
  maxHeight: 420,
  overflowY: 'auto',
}

const faceColumnTitleStyle: CSSProperties = {
  color: '#5b6474',
  fontSize: 10,
  letterSpacing: 1.8,
  marginBottom: 8,
}

const faceQueueItemStyle: CSSProperties = {
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

const faceAvatarDotStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.18)',
  flex: '0 0 auto',
}

const faceQueueNameStyle: CSSProperties = {
  display: 'block',
  fontSize: 12,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
}

const faceQueuePosStyle: CSSProperties = {
  display: 'block',
  color: '#5b6474',
  fontSize: 10,
  marginTop: 2,
}

const faceEmptyStyle: CSSProperties = {
  color: '#384050',
  fontSize: 12,
  textAlign: 'center',
  padding: '34px 8px',
}

const faceApproveStyle: CSSProperties = {
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

const faceDenyStyle: CSSProperties = {
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

const faceReasonsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 7,
}

const faceReasonButtonStyle: CSSProperties = {
  minHeight: 32,
  border: '1px solid rgba(217,35,0,0.34)',
  borderRadius: 4,
  background: 'rgba(217,35,0,0.12)',
  color: '#ff9a82',
  fontFamily: 'monospace',
  fontSize: 10,
  cursor: 'pointer',
}

const faceLogEntryStyle: CSSProperties = {
  color: '#8f95aa',
  fontSize: 10,
  lineHeight: 1.45,
  marginBottom: 7,
  wordBreak: 'break-word',
}

const managementPanelStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(env(safe-area-inset-top, 0px) + 72px)',
  left: 12,
  width: 'min(980px, calc(100vw - 24px))',
  maxHeight: 'calc(100dvh - 104px)',
  border: '1px solid rgba(124,255,196,0.34)',
  borderRadius: 8,
  background: 'rgba(8,8,18,0.95)',
  boxShadow: '0 18px 60px rgba(0,0,0,0.52), 0 0 32px rgba(124,255,196,0.12)',
  color: '#e8e8f0',
  fontFamily: 'monospace',
  overflow: 'hidden',
  pointerEvents: 'auto',
  zIndex: 246,
}

const managementHeaderStyle: CSSProperties = {
  minHeight: 56,
  padding: '0 14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
}

function managementTabButtonStyle(active: boolean): CSSProperties {
  return {
    minHeight: 28,
    border: `1px solid ${active ? 'rgba(124,255,196,0.58)' : 'rgba(255,255,255,0.13)'}`,
    borderRadius: 4,
    background: active ? 'rgba(124,255,196,0.16)' : 'rgba(255,255,255,0.045)',
    color: active ? '#7cffc4' : '#8f95aa',
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: 800,
    cursor: 'pointer',
  }
}

const managementBodyStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '240px minmax(260px, 1fr) 250px',
  gap: 12,
  padding: 12,
  maxHeight: 'calc(100dvh - 172px)',
  overflowY: 'auto',
}

const managementColumnStyle: CSSProperties = {
  minHeight: 320,
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.025)',
  padding: 10,
  overflowY: 'auto',
}

const managementActionColumnStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minHeight: 320,
  border: '1px solid rgba(124,255,196,0.14)',
  borderRadius: 6,
  background: 'rgba(124,255,196,0.035)',
  padding: 10,
}

const managementQueueItemStyle: CSSProperties = {
  minHeight: 46,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 7,
  padding: '8px 9px',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.035)',
}

function managementPlayerRowStyle(active: boolean): CSSProperties {
  return {
    width: '100%',
    minHeight: 46,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 7,
    padding: '8px 9px',
    border: `1px solid ${active ? 'rgba(124,255,196,0.58)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: 6,
    background: active ? 'rgba(124,255,196,0.12)' : 'rgba(255,255,255,0.035)',
    color: '#e8e8f0',
    fontFamily: 'monospace',
    textAlign: 'left',
    cursor: 'pointer',
  }
}

const managementSmallGoodButtonStyle: CSSProperties = {
  width: 34,
  minHeight: 28,
  border: 'none',
  borderRadius: 4,
  background: '#00e676',
  color: '#06100a',
  fontFamily: 'monospace',
  fontSize: 10,
  fontWeight: 900,
  cursor: 'pointer',
}

const managementSmallBadButtonStyle: CSSProperties = {
  width: 34,
  minHeight: 28,
  border: 'none',
  borderRadius: 4,
  background: '#d92300',
  color: '#fff',
  fontFamily: 'monospace',
  fontSize: 10,
  fontWeight: 900,
  cursor: 'pointer',
}

const managementActionButtonStyle: CSSProperties = {
  minHeight: 36,
  border: '1px solid rgba(124,255,196,0.28)',
  borderRadius: 4,
  background: 'rgba(124,255,196,0.11)',
  color: '#a9ffe0',
  fontFamily: 'monospace',
  fontSize: 10,
  fontWeight: 900,
  cursor: 'pointer',
}

const managementDangerButtonStyle: CSSProperties = {
  ...managementActionButtonStyle,
  border: '1px solid rgba(217,35,0,0.38)',
  background: 'rgba(217,35,0,0.15)',
  color: '#ff9a82',
}

const managementMetricStyle: CSSProperties = {
  minHeight: 52,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '10px 12px',
  border: '1px solid rgba(124,255,196,0.16)',
  borderRadius: 6,
  background: 'rgba(124,255,196,0.055)',
  color: '#7cffc4',
  fontSize: 11,
}

const managementButtonGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 6,
}

const managementPriceRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 48px 28px 28px',
  alignItems: 'center',
  gap: 6,
  minHeight: 36,
  marginBottom: 6,
  color: '#d8d0c2',
  fontSize: 10,
}

const managementTinyButtonStyle: CSSProperties = {
  width: 28,
  minHeight: 28,
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.055)',
  color: '#d8f7ff',
  fontFamily: 'monospace',
  fontWeight: 900,
  cursor: 'pointer',
}

function managementRoleButtonStyle(active: boolean): CSSProperties {
  return {
    minHeight: 32,
    border: `1px solid ${active ? 'rgba(255,179,71,0.52)' : 'rgba(255,255,255,0.12)'}`,
    borderRadius: 4,
    background: active ? 'rgba(255,179,71,0.16)' : 'rgba(255,255,255,0.045)',
    color: active ? '#ffcc80' : '#8f95aa',
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: 900,
    cursor: 'pointer',
  }
}

const managementAdminGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 7,
}

const managementSelectedCardStyle: CSSProperties = {
  minHeight: 74,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: 10,
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  background: 'rgba(255,255,255,0.04)',
}

const facePanelCloseStyle: CSSProperties = {
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

const djPanelMountStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(env(safe-area-inset-top, 0px) + 72px)',
  left: 12,
  zIndex: 240,
  pointerEvents: 'auto',
}

const djBadgeButtonStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(env(safe-area-inset-top, 0px) + 76px)',
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
  zIndex: 245,
}

function Joystick({ onMove }: { onMove: (x: number, z: number) => void }) {
  const stickRef = useRef<HTMLDivElement>(null)
  const active = useRef(false)
  const origin = useRef({ x: 0, y: 0 })
  const max = 36

  const start = (x: number, y: number) => {
    active.current = true
    origin.current = { x, y }
  }
  const move = (x: number, y: number) => {
    if (!active.current || !stickRef.current) return
    const dx = x - origin.current.x
    const dy = y - origin.current.y
    const dist = Math.min(max, Math.sqrt(dx * dx + dy * dy))
    const angle = Math.atan2(dy, dx)
    stickRef.current.style.transform = `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px)`
    onMove(dx / max, dy / max)
  }
  const end = () => {
    active.current = false
    if (stickRef.current) stickRef.current.style.transform = 'translate(0, 0)'
    onMove(0, 0)
  }

  return (
    <div
      onTouchStart={(e) => start(e.touches[0].clientX, e.touches[0].clientY)}
      onTouchMove={(e) => { e.preventDefault(); move(e.touches[0].clientX, e.touches[0].clientY) }}
      onTouchEnd={end}
      style={{
        position: 'absolute',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 34px)',
        left: 22,
        width: 80,
        height: 80,
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.055)',
        border: '1px solid rgba(255,255,255,0.13)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        touchAction: 'none',
        zIndex: 130,
      }}
    >
      <div
        ref={stickRef}
        style={{
          width: 34,
          height: 34,
          borderRadius: '50%',
          background: 'rgba(124,255,196,0.42)',
          border: '1px solid #7cffc4',
          transition: 'transform 0.04s',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
