import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import {
  LocalAudioTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client'
import { usePlayerStore } from '@/store/playerStore'
import { getLiveKitToken, LIVEKIT_DJ_ROOM } from '@/utils/livekit'
import { claimCaptureAudioSession, preferCaptureAudioSession, preferPlaybackAudioSession } from '@/utils/audioSession'

type VoiceStatus = 'idle' | 'connecting' | 'ready' | 'talking' | 'error'
type VoiceEnvironment = 'club' | 'outside'
type VoiceMode = 'ptt' | 'auto'
type Position2 = { x: number; z: number; y?: number; floorLevel?: string }
type VoiceRemote = {
  playerId: string
  track: RemoteAudioTrack
  element: HTMLAudioElement | null
  lastVolume: number
  source: MediaStreamAudioSourceNode | null
  analyser: AnalyserNode | null
  analyserData: Uint8Array<ArrayBuffer> | null
  gain: GainNode | null
  level: number
}
type LocalVoiceCapture = {
  sourceStream: MediaStream
  audioContext: AudioContext
  analyser: AnalyserNode
  analyserData: Uint8Array<ArrayBuffer>
  track: LocalAudioTrack
  releaseAudioSession: () => void
}

const VOICE_TRACK_NAME = 'voice'
const VOICE_CAPTURE_AUDIO_STATE_EVENT = 'voice-capture-audio-state'
export const PROXIMITY_VOICE_POSITIONS_EVENT = 'proximity-voice-positions'
export const VOICE_TALKING_EVENT = 'voice-talking'
export const VOICE_LEVELS_EVENT = 'voice-levels'
const MIC_CAPTURE_CONSTRAINTS: MediaTrackConstraints & { voiceIsolation?: boolean } = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: true,
  channelCount: 1,
}
const VAD_OPEN_RMS = 0.012
const VAD_CLOSE_RMS = 0.0065
const VAD_CLOSE_DELAY_MS = 820
const VOICE_ENVIRONMENT_SETTINGS: Record<VoiceEnvironment, {
  fullDistance: number
  maxDistance: number
  ceiling: number
}> = {
  club: {
    fullDistance: 0.75,
    maxDistance: 3.8,
    ceiling: 0.28,
  },
  outside: {
    fullDistance: 1.15,
    maxDistance: 6.8,
    ceiling: 0.62,
  },
}
const VOICE_VOLUME_EPSILON = 0.008
const VOICE_LEVEL_TALKING_THRESHOLD = 0.028
const MIC_NOTICE_STORAGE_KEY = 'voice:headphone-notice-seen'

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function voiceVolumeForDistance(distance: number, environment: VoiceEnvironment) {
  const settings = VOICE_ENVIRONMENT_SETTINGS[environment]
  if (!Number.isFinite(distance) || distance >= settings.maxDistance) return 0
  if (distance <= settings.fullDistance) return settings.ceiling

  const t = 1 - (distance - settings.fullDistance) / (settings.maxDistance - settings.fullDistance)
  return Math.pow(clamp(t, 0, 1), 1.85) * settings.ceiling
}

function verticalVoiceGap(self: Position2, remote: Position2) {
  if (typeof self.y === 'number' && typeof remote.y === 'number') {
    return remote.y - self.y
  }
  if (self.floorLevel && remote.floorLevel && self.floorLevel !== remote.floorLevel) {
    return 3.4
  }
  return 0
}

function voiceDistance(self: Position2, remote: Position2) {
  const dx = remote.x - self.x
  const dz = remote.z - self.z
  const dy = verticalVoiceGap(self, remote)
  return Math.hypot(dx, dy, dz)
}

function readVoicePosition(value: any): Position2 {
  return {
    x: value.x,
    z: value.z,
    y: typeof value.y === 'number' && Number.isFinite(value.y) ? value.y : undefined,
    floorLevel: typeof value.floorLevel === 'string' ? value.floorLevel : undefined,
  }
}

function playerIdFromIdentity(identity: unknown) {
  if (typeof identity !== 'string') return ''
  return identity.match(/-voice-([a-zA-Z0-9_]+)$/)?.[1] ?? ''
}

function isVoicePublication(publication: any) {
  return publication?.trackName === VOICE_TRACK_NAME
}

function getSavedIncomingVoicesEnabled() {
  try {
    return localStorage.getItem('voice:incoming-enabled') !== '0'
  } catch {
    return true
  }
}

function getMicNoticeSeen() {
  try {
    return localStorage.getItem(MIC_NOTICE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function setMicNoticeSeen() {
  try {
    localStorage.setItem(MIC_NOTICE_STORAGE_KEY, '1')
  } catch {}
}

function attachRemoteElement(remote: VoiceRemote) {
  if (remote.element) return remote.element

  const element = remote.track.attach() as HTMLAudioElement
  element.autoplay = true
  element.volume = 0
  element.muted = true
  element.style.display = 'none'
  document.body.appendChild(element)
  remote.element = element
  return element
}

function detachRemoteElement(remote: VoiceRemote) {
  remote.track.setVolume(0)
  remote.lastVolume = 0
  remote.level = 0

  const element = remote.element
  if (!element) return

  element.pause()
  element.volume = 0
  element.muted = true
  remote.track.detach(element)
  element.remove()
  remote.element = null
}

function applyRemoteVolume(remote: VoiceRemote, volume: number) {
  const nextVolume = clamp(volume, 0, 1)
  const shouldMute = nextVolume <= VOICE_VOLUME_EPSILON
  const webAudioGain = remote.gain

  if (shouldMute) {
    if (webAudioGain) {
      const now = webAudioGain.context.currentTime
      webAudioGain.gain.cancelScheduledValues(now)
      webAudioGain.gain.setTargetAtTime(0, now, 0.04)
    }
    if (remote.element) {
      remote.element.volume = 0
      remote.element.muted = true
    }
    remote.track.setVolume(0)
    remote.lastVolume = 0
    return
  }

  if (webAudioGain) {
    const now = webAudioGain.context.currentTime
    webAudioGain.gain.cancelScheduledValues(now)
    webAudioGain.gain.setTargetAtTime(nextVolume, now, 0.06)
    remote.track.setVolume(0)
    if (remote.element) {
      remote.element.volume = 0
      remote.element.muted = true
    }
  } else {
    const element = attachRemoteElement(remote)
    remote.track.setVolume(nextVolume)
    element.volume = nextVolume
    element.muted = false
    element.play().catch(() => undefined)
  }
  remote.lastVolume = nextVolume
}

function dispatchVoiceTalking(talking: boolean) {
  window.dispatchEvent(new CustomEvent(VOICE_TALKING_EVENT, {
    detail: { talking, updatedAt: Date.now() },
  }))
}

function dispatchVoiceLevels(selfLevel: number, selfTalking: boolean, remotes: VoiceRemote[]) {
  window.dispatchEvent(new CustomEvent(VOICE_LEVELS_EVENT, {
    detail: {
      self: {
        level: clamp(selfLevel, 0, 1),
        talking: selfTalking,
      },
      players: remotes.map((remote) => ({
        id: remote.playerId,
        level: clamp(remote.level, 0, 1),
        talking: remote.level > VOICE_LEVEL_TALKING_THRESHOLD,
      })),
      updatedAt: Date.now(),
    },
  }))
}

function assertMicrophoneAvailable() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('MIC нужен HTTPS: открой через https/tunnel')
  }
}

function voiceErrorMessage(error: any, fallback: string) {
  const message = String(error?.message || error || fallback)
  if (message.includes('signal connection') || message.includes('Load failed') || message.includes('server was not reachable')) {
    return 'LiveKit signal недоступен: нужен HTTPS/WSS или LAN LiveKit'
  }
  return message
}

function dispatchVoiceCaptureAudioState(active: boolean) {
  if (active) preferCaptureAudioSession()
  else preferPlaybackAudioSession()
  window.dispatchEvent(new CustomEvent(VOICE_CAPTURE_AUDIO_STATE_EVENT, {
    detail: { active, updatedAt: Date.now() },
  }))
}

async function createLocalVoiceCapture(): Promise<LocalVoiceCapture> {
  assertMicrophoneAvailable()
  const releaseAudioSession = claimCaptureAudioSession()
  let sourceStream: MediaStream | null = null
  let audioContext: AudioContext | null = null

  try {
    sourceStream = await navigator.mediaDevices.getUserMedia({
      audio: MIC_CAPTURE_CONSTRAINTS,
      video: false,
    })
    preferCaptureAudioSession()

    const mediaTrack = sourceStream.getAudioTracks()[0]
    if (!mediaTrack) {
      sourceStream.getTracks().forEach((track) => track.stop())
      throw new Error('Браузер не вернул аудиотрек микрофона')
    }

    audioContext = new AudioContext()
    const source = audioContext.createMediaStreamSource(sourceStream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.45

    source.connect(analyser)

    const track = new LocalAudioTrack(mediaTrack.clone(), MIC_CAPTURE_CONSTRAINTS, true, audioContext)
    await track.mute().catch(() => undefined)
    dispatchVoiceCaptureAudioState(true)

    return {
      sourceStream,
      audioContext,
      analyser,
      analyserData: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
      track,
      releaseAudioSession,
    }
  } catch (error) {
    sourceStream?.getTracks().forEach((track) => track.stop())
    await audioContext?.close().catch(() => undefined)
    releaseAudioSession()
    throw error
  }
}

function readRms(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>) {
  analyser.getByteTimeDomainData(data)
  let sum = 0
  for (let i = 0; i < data.length; i += 1) {
    const centered = (data[i] - 128) / 128
    sum += centered * centered
  }
  return Math.sqrt(sum / data.length)
}

export default function VoiceChat({
  myPlayerId,
  environment,
}: {
  myPlayerId: string | null
  environment: VoiceEnvironment
}) {
  const roomRef = useRef<Room | null>(null)
  const connectPromiseRef = useRef<Promise<Room> | null>(null)
  const localTrackRef = useRef<LocalAudioTrack | null>(null)
  const localCaptureRef = useRef<LocalVoiceCapture | null>(null)
  const remotesRef = useRef(new Map<string, VoiceRemote>())
  const remoteAudioContextRef = useRef<AudioContext | null>(null)
  const pressedRef = useRef(false)
  const voiceModeRef = useRef<VoiceMode>('ptt')
  const talkingRef = useRef(false)
  const vadFrameRef = useRef<number | null>(null)
  const lastVoiceAtRef = useRef(0)
  const vadLevelRef = useRef(0)
  const environmentRef = useRef(environment)
  const savedIncomingVoicesEnabledRef = useRef(getSavedIncomingVoicesEnabled())
  const incomingVoicesEnabledRef = useRef(savedIncomingVoicesEnabledRef.current)
  const incomingAudioUnlockRequestedRef = useRef(false)
  const positionsRef = useRef<{ self: Position2; players: Map<string, Position2> }>({
    self: { x: 0, z: 0 },
    players: new Map(),
  })
  const playerIdRef = useRef(myPlayerId)
  const mountedRef = useRef(true)
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [nearbyVoices, setNearbyVoices] = useState(0)
  const [error, setError] = useState('')
  const [incomingVoicesEnabled, setIncomingVoicesEnabled] = useState(savedIncomingVoicesEnabledRef.current)
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('ptt')
  const [pendingMicAction, setPendingMicAction] = useState<VoiceMode | null>(null)
  const [micNoticeSeen, setMicNoticeSeenState] = useState(getMicNoticeSeen)

  useEffect(() => {
    playerIdRef.current = myPlayerId
  }, [myPlayerId])

  const setOutgoingTalking = (talking: boolean) => {
    if (talkingRef.current === talking) return
    talkingRef.current = talking
    usePlayerStore.getState().setTalking(talking)
    dispatchVoiceTalking(talking)
  }

  const ensureRemoteAudioContext = () => {
    let ctx = remoteAudioContextRef.current
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext({ sampleRate: 48000 })
      remoteAudioContextRef.current = ctx
    }
    return ctx
  }

  const attachRemoteAnalyser = (remote: VoiceRemote) => {
    if (remote.analyser) return
    const mediaTrack = remote.track.mediaStreamTrack
    if (!mediaTrack) return

    try {
      const ctx = ensureRemoteAudioContext()
      const source = ctx.createMediaStreamSource(new MediaStream([mediaTrack]))
      const analyser = ctx.createAnalyser()
      const gain = ctx.createGain()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.5
      gain.gain.value = 0
      source.connect(analyser)
      source.connect(gain)
      gain.connect(ctx.destination)
      remote.source = source
      remote.analyser = analyser
      remote.analyserData = new Uint8Array(new ArrayBuffer(analyser.fftSize))
      remote.gain = gain
      ctx.resume().catch(() => undefined)
    } catch (error) {
      console.warn('[VoiceChat] remote voice analyser unavailable:', error)
    }
  }

  const detachRemoteAnalyser = (remote: VoiceRemote) => {
    remote.source?.disconnect()
    remote.gain?.disconnect()
    remote.source = null
    remote.analyser = null
    remote.analyserData = null
    remote.gain = null
    remote.level = 0
  }

  const readLocalVoiceLevel = () => {
    const capture = localCaptureRef.current
    if (!capture) return 0
    const measured = readRms(capture.analyser, capture.analyserData)
    vadLevelRef.current = Math.max(measured, vadLevelRef.current * 0.72)
    return talkingRef.current ? vadLevelRef.current : 0
  }

  const updateVoiceLevels = () => {
    const remotes = Array.from(remotesRef.current.values())
    remotes.forEach((remote) => {
      if (!remote.analyser || !remote.analyserData || remote.lastVolume <= VOICE_VOLUME_EPSILON) {
        remote.level *= 0.72
        if (remote.level < 0.002) remote.level = 0
        return
      }

      const rawLevel = readRms(remote.analyser, remote.analyserData)
      const heardLevel = rawLevel * clamp(remote.lastVolume / VOICE_ENVIRONMENT_SETTINGS[environmentRef.current].ceiling, 0, 1)
      remote.level = Math.max(heardLevel, remote.level * 0.74)
    })
    dispatchVoiceLevels(readLocalVoiceLevel(), talkingRef.current, remotes)
  }

  const updateRemoteVolumes = () => {
    const { self, players } = positionsRef.current
    let audible = 0

    remotesRef.current.forEach((remote) => {
      const pos = players.get(remote.playerId)
      const volume = incomingVoicesEnabledRef.current && pos
        ? voiceVolumeForDistance(voiceDistance(self, pos), environmentRef.current)
        : 0

      if (!incomingVoicesEnabledRef.current) {
        if (remote.element) detachRemoteElement(remote)
        if (remote.lastVolume > 0) applyRemoteVolume(remote, 0)
        return
      }

      const elementOutOfSync = remote.gain
        ? false
        : !remote.element ||
          Math.abs(remote.element.volume - volume) > VOICE_VOLUME_EPSILON ||
          remote.element.muted !== (volume <= VOICE_VOLUME_EPSILON) ||
          (volume > VOICE_VOLUME_EPSILON && remote.element.paused)

      if (Math.abs(volume - remote.lastVolume) > VOICE_VOLUME_EPSILON || elementOutOfSync) {
        applyRemoteVolume(remote, volume)
      }
      if (volume > 0.025) audible += 1
    })

    updateVoiceLevels()
    setNearbyVoices((current) => current === audible ? current : audible)
  }

  useEffect(() => {
    environmentRef.current = environment
    updateRemoteVolumes()
  }, [environment])

  useEffect(() => {
    incomingVoicesEnabledRef.current = incomingVoicesEnabled
    try {
      localStorage.setItem('voice:incoming-enabled', incomingVoicesEnabled ? '1' : '0')
    } catch {}
    updateRemoteVolumes()
  }, [incomingVoicesEnabled])

  const detachRemote = (playerId: string) => {
    const remote = remotesRef.current.get(playerId)
    if (!remote) return

    detachRemoteElement(remote)
    detachRemoteAnalyser(remote)
    remotesRef.current.delete(playerId)
    updateRemoteVolumes()
  }

  const attachRemote = (playerId: string, track: RemoteAudioTrack) => {
    if (!playerId || playerId === playerIdRef.current) return
    detachRemote(playerId)

    const remote: VoiceRemote = {
      playerId,
      track,
      element: null,
      lastVolume: 0,
      source: null,
      analyser: null,
      analyserData: null,
      gain: null,
      level: 0,
    }
    remotesRef.current.set(playerId, remote)
    attachRemoteAnalyser(remote)
    if (!incomingVoicesEnabledRef.current) detachRemoteElement(remote)
    track.start()
    updateRemoteVolumes()
  }

  const detachAllRemotes = () => {
    Array.from(remotesRef.current.keys()).forEach(detachRemote)
  }

  async function startIncomingAudioElements(room = roomRef.current) {
    if (!room || !incomingVoicesEnabledRef.current) return

    await room.startAudio().catch(() => undefined)
    await remoteAudioContextRef.current?.resume().catch(() => undefined)
    updateRemoteVolumes()
  }

  const ensureRoom = async () => {
    if (roomRef.current) return roomRef.current
    if (connectPromiseRef.current) return connectPromiseRef.current

    const playerId = playerIdRef.current
    if (!playerId) throw new Error('Игрок еще подключается к клубу')

    setError('')
    setStatus((current) => current === 'talking' ? current : 'connecting')

    const promise = (async () => {
      const { token, url } = await getLiveKitToken(LIVEKIT_DJ_ROOM, 'voice', `voice-${playerId}`)
      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
      })

      const handleSubscribed = (track: any, publication: any, participant: any) => {
        if (!isVoicePublication(publication)) return
        if (track instanceof RemoteAudioTrack) attachRemote(playerIdFromIdentity(participant.identity), track)
      }
      const handleUnsubscribed = (_track: any, publication: any, participant: any) => {
        if (!isVoicePublication(publication)) return
        detachRemote(playerIdFromIdentity(participant.identity))
      }
      const handleDisconnected = () => {
        detachAllRemotes()
        void releaseLocalVoiceCapture(room)
        setOutgoingTalking(false)
        roomRef.current = null
        if (mountedRef.current) setStatus('idle')
      }

      room.on(RoomEvent.TrackSubscribed, handleSubscribed)
      room.on(RoomEvent.TrackUnsubscribed, handleUnsubscribed)
      room.on(RoomEvent.Disconnected, handleDisconnected)

      await room.connect(url, token, {
        autoSubscribe: true,
        maxRetries: 2,
        websocketTimeout: 20_000,
      })

      room.remoteParticipants.forEach((participant: any) => {
        participant.trackPublications?.forEach((publication: any) => {
          if (isVoicePublication(publication) && publication.track instanceof RemoteAudioTrack) {
            attachRemote(playerIdFromIdentity(participant.identity), publication.track)
          }
        })
      })

      roomRef.current = room
      if (incomingAudioUnlockRequestedRef.current) {
        startIncomingAudioElements(room)
      }
      if (mountedRef.current) setStatus('ready')
      return room
    })()

    connectPromiseRef.current = promise
    try {
      return await promise
    } finally {
      connectPromiseRef.current = null
    }
  }

  const requestIncomingAudioUnlock = (connectIfNeeded = false) => {
    incomingAudioUnlockRequestedRef.current = true
    if (!playerIdRef.current || !incomingVoicesEnabledRef.current) return

    startIncomingAudioElements()
    if (connectIfNeeded && !roomRef.current) {
      ensureRoom()
        .then((room) => startIncomingAudioElements(room))
        .catch(() => undefined)
    }
  }

  const setIncomingPlaybackEnabled = (enabled: boolean) => {
    incomingVoicesEnabledRef.current = enabled
    setIncomingVoicesEnabled(enabled)
    try {
      localStorage.setItem('voice:incoming-enabled', enabled ? '1' : '0')
    } catch {}
    if (!enabled) {
      remotesRef.current.forEach(detachRemoteElement)
      updateVoiceLevels()
      setNearbyVoices(0)
      return
    }
    updateRemoteVolumes()
    requestIncomingAudioUnlock(true)
  }

  const toggleIncomingPlayback = () => {
    setIncomingPlaybackEnabled(!incomingVoicesEnabledRef.current)
  }

  const ensureLocalVoiceTrack = async (room: Room) => {
    const track = localTrackRef.current
    if (track) return track

    const capture = await createLocalVoiceCapture()
    localCaptureRef.current = capture
    localTrackRef.current = capture.track

    await room.localParticipant.publishTrack(capture.track, {
      name: VOICE_TRACK_NAME,
      source: Track.Source.Microphone,
      dtx: false,
      red: false,
      forceStereo: false,
      stopMicTrackOnMute: false,
      stream: 'voice',
    })

    return capture.track
  }

  const releaseLocalVoiceCapture = async (room = roomRef.current) => {
    const track = localTrackRef.current
    const capture = localCaptureRef.current
    localTrackRef.current = null
    localCaptureRef.current = null
    vadLevelRef.current = 0

    if (track && room) {
      await room.localParticipant.unpublishTrack(track, true).catch(() => undefined)
    }
    track?.stop()
    capture?.sourceStream.getTracks().forEach((sourceTrack) => sourceTrack.stop())
    await capture?.audioContext.close().catch(() => undefined)
    capture?.releaseAudioSession()
    dispatchVoiceCaptureAudioState(false)
    dispatchVoiceLevels(0, false, Array.from(remotesRef.current.values()))
  }

  const prepareMicrophone = async () => {
    if (!myPlayerId) return

    try {
      assertMicrophoneAvailable()
      preferPlaybackAudioSession()
      const room = await ensureRoom()
      incomingAudioUnlockRequestedRef.current = true
      await startIncomingAudioElements(room)
      setOutgoingTalking(false)
      if (mountedRef.current) {
        setError('')
        setStatus('ready')
      }
    } catch (e: any) {
      if (mountedRef.current) {
        setError(voiceErrorMessage(e, 'Не удалось включить микрофон'))
        setStatus('error')
      }
    }
  }

  const stopTalking = async () => {
    const track = localTrackRef.current
    if (!track) {
      setOutgoingTalking(false)
      setStatus((current) => current === 'talking' ? 'ready' : current)
      if (voiceModeRef.current !== 'auto') await releaseLocalVoiceCapture()
      return
    }

    await track.mute().catch(() => undefined)
    setOutgoingTalking(false)
    if (mountedRef.current) setStatus(roomRef.current ? 'ready' : 'idle')
    if (voiceModeRef.current !== 'auto') await releaseLocalVoiceCapture()
  }

  const startTalking = async () => {
    if (!myPlayerId) return

    try {
      assertMicrophoneAvailable()
      const room = await ensureRoom()
      incomingAudioUnlockRequestedRef.current = true
      await startIncomingAudioElements(room)

      const track = await ensureLocalVoiceTrack(room)
      await localCaptureRef.current?.audioContext.resume().catch(() => undefined)
      await track.unmute()

      if (!pressedRef.current) {
        await track.mute().catch(() => undefined)
        setOutgoingTalking(false)
        if (mountedRef.current) setStatus(roomRef.current ? 'ready' : 'idle')
        if (voiceModeRef.current !== 'auto') await releaseLocalVoiceCapture(room)
        return
      }

      if (mountedRef.current) {
        setError('')
        setOutgoingTalking(true)
        setStatus('talking')
      }
    } catch (e: any) {
      if (mountedRef.current) {
        setError(voiceErrorMessage(e, 'Не удалось включить микрофон'))
        setStatus('error')
      }
      setOutgoingTalking(false)
      if (voiceModeRef.current !== 'auto') await releaseLocalVoiceCapture()
    }
  }

  const startVadLoop = () => {
    if (vadFrameRef.current !== null) return

    const tick = () => {
      vadFrameRef.current = null
      if (!mountedRef.current || voiceModeRef.current !== 'auto') return

      const capture = localCaptureRef.current
      const track = localTrackRef.current
      if (!capture || !track) {
        vadFrameRef.current = window.requestAnimationFrame(tick)
        return
      }

      const level = readRms(capture.analyser, capture.analyserData)
      vadLevelRef.current = Math.max(level, vadLevelRef.current * 0.72)
      const now = performance.now()

      if (vadLevelRef.current >= VAD_OPEN_RMS) {
        lastVoiceAtRef.current = now
        if (!talkingRef.current) {
          track.unmute()
            .then(() => {
              if (!mountedRef.current || voiceModeRef.current !== 'auto') return
              setOutgoingTalking(true)
              setStatus('talking')
            })
            .catch(() => undefined)
        }
      } else if (talkingRef.current && vadLevelRef.current <= VAD_CLOSE_RMS && now - lastVoiceAtRef.current > VAD_CLOSE_DELAY_MS) {
        track.mute()
          .then(() => {
            if (!mountedRef.current || voiceModeRef.current !== 'auto') return
            setOutgoingTalking(false)
            setStatus(roomRef.current ? 'ready' : 'idle')
          })
          .catch(() => undefined)
      }

      vadFrameRef.current = window.requestAnimationFrame(tick)
    }

    vadFrameRef.current = window.requestAnimationFrame(tick)
  }

  const stopVadLoop = () => {
    if (vadFrameRef.current === null) return
    window.cancelAnimationFrame(vadFrameRef.current)
    vadFrameRef.current = null
  }

  const startAutoVoice = async () => {
    if (!myPlayerId) return
    voiceModeRef.current = 'auto'
    setVoiceMode('auto')
    pressedRef.current = false

    try {
      assertMicrophoneAvailable()
      const room = await ensureRoom()
      incomingAudioUnlockRequestedRef.current = true
      await startIncomingAudioElements(room)
      const track = await ensureLocalVoiceTrack(room)
      await localCaptureRef.current?.audioContext.resume().catch(() => undefined)
      await track.mute().catch(() => undefined)
      setOutgoingTalking(false)
      if (mountedRef.current) {
        setError('')
        setStatus('ready')
      }
      startVadLoop()
    } catch (e: any) {
      voiceModeRef.current = 'ptt'
      setVoiceMode('ptt')
      setOutgoingTalking(false)
      await releaseLocalVoiceCapture()
      if (mountedRef.current) {
        setError(voiceErrorMessage(e, 'Не удалось включить авто-микрофон'))
        setStatus('error')
      }
    }
  }

  const stopAutoVoice = async () => {
    voiceModeRef.current = 'ptt'
    setVoiceMode('ptt')
    stopVadLoop()
    await stopTalking()
  }

  const toggleAutoVoice = () => {
    if (voiceModeRef.current === 'auto') {
      stopAutoVoice()
    } else {
      if (!micNoticeSeen) {
        setPendingMicAction('auto')
        return
      }
      startAutoVoice()
    }
  }

  const confirmMicNotice = () => {
    const action = pendingMicAction
    setMicNoticeSeen()
    setMicNoticeSeenState(true)
    setPendingMicAction(null)

    if (action === 'auto') {
      startAutoVoice()
      return
    }

    pressedRef.current = false
    prepareMicrophone()
  }

  const disconnect = async () => {
    const room = roomRef.current
    roomRef.current = null
    stopVadLoop()
    detachAllRemotes()
    await releaseLocalVoiceCapture(room)
    remoteAudioContextRef.current?.close().catch(() => undefined)
    remoteAudioContextRef.current = null
    setOutgoingTalking(false)
    dispatchVoiceLevels(0, false, [])
    await room?.disconnect().catch(() => undefined)
  }

  useEffect(() => {
    mountedRef.current = true
    if (!myPlayerId) {
      setError('')
      setStatus('idle')
    }

    return () => {
      disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPlayerId])

  useEffect(() => {
    const unlock = () => requestIncomingAudioUnlock()
    window.addEventListener('pointerdown', unlock, true)
    window.addEventListener('mousedown', unlock, true)
    window.addEventListener('touchstart', unlock, { capture: true, passive: true })
    window.addEventListener('keydown', unlock, true)
    return () => {
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('mousedown', unlock, true)
      window.removeEventListener('touchstart', unlock, true)
      window.removeEventListener('keydown', unlock, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onPositions = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {}
      const self = detail.self
      if (!self || typeof self.x !== 'number' || typeof self.z !== 'number') return

      const nextPlayers = new Map<string, Position2>()
      for (const player of detail.players ?? []) {
        if (typeof player?.id !== 'string') continue
        if (typeof player.x !== 'number' || typeof player.z !== 'number') continue
        nextPlayers.set(player.id, readVoicePosition(player))
      }

      positionsRef.current = { self: readVoicePosition(self), players: nextPlayers }
      updateRemoteVolumes()
    }

    window.addEventListener(PROXIMITY_VOICE_POSITIONS_EVENT, onPositions)
    const timer = window.setInterval(updateRemoteVolumes, 180)
    return () => {
      window.removeEventListener(PROXIMITY_VOICE_POSITIONS_EVENT, onPositions)
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    return () => {
      mountedRef.current = false
      disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (voiceModeRef.current === 'auto') return
    if (!micNoticeSeen) {
      pressedRef.current = false
      setPendingMicAction('ptt')
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    pressedRef.current = true
    startTalking()
  }

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (voiceModeRef.current === 'auto') return
    pressedRef.current = false
    stopTalking()
  }

  const active = status === 'talking'
  const busy = status === 'connecting'
  const ready = status === 'ready' || status === 'talking'
  const autoActive = voiceMode === 'auto'
  const label = active ? 'ON' : busy ? '...' : 'MIC'
  const subLabel = error ? 'MIC OFF' : active ? 'MIC LIVE' : autoActive ? 'AUTO LISTEN' : nearbyVoices > 0 ? `${nearbyVoices} РЯДОМ` : ready ? 'VOICE' : 'OFF'

  return (
    <div style={panelStyle}>
      <div style={controlsRowStyle}>
        <button
          type="button"
          disabled={!myPlayerId || busy || autoActive}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={(event) => {
            if (pressedRef.current) handlePointerUp(event)
          }}
          onContextMenu={(event) => event.preventDefault()}
          style={voiceButtonStyle(active, busy, !myPlayerId || autoActive)}
          aria-label="Голосовая связь"
        >
          <span style={dotStyle(active, ready, Boolean(error))} />
          <span>{label}</span>
        </button>
        <button
          type="button"
          disabled={!myPlayerId || busy}
          onClick={toggleAutoVoice}
          style={autoButtonStyle(autoActive, active, busy, !myPlayerId)}
          aria-label={autoActive ? 'Выключить авто-микрофон' : 'Включить авто-микрофон'}
          title={autoActive ? 'Выключить авто-микрофон' : 'Включить авто-микрофон'}
        >
          AUTO
        </button>
        <button
          type="button"
          onClick={toggleIncomingPlayback}
          style={muteButtonStyle(incomingVoicesEnabled)}
          aria-label={incomingVoicesEnabled ? 'Выключить голоса игроков' : 'Включить голоса игроков'}
          title={incomingVoicesEnabled ? 'Выключить голоса игроков' : 'Включить голоса игроков'}
        >
          {incomingVoicesEnabled ? 'IN' : 'OFF'}
        </button>
      </div>
      <div style={statusStyle(!incomingVoicesEnabled ? '#ffb84d' : error ? '#ff6b6b' : active ? '#00e676' : nearbyVoices > 0 ? '#7cffc4' : '#777')}>
        {incomingVoicesEnabled ? subLabel : 'VOICES OFF'}
      </div>
      {error && <div style={errorDetailsStyle}>{error}</div>}
      {pendingMicAction && (
        <div style={micNoticeBackdropStyle}>
          <div style={micNoticeStyle}>
            <div style={micNoticeTitleStyle}>Перед первым микрофоном</div>
            <div style={micNoticeTextStyle}>
              Настоятельно рекомендуем использовать наушники: так музыка не попадет обратно в микрофон, а голоса игроков будут чище.
            </div>
            <button type="button" style={micNoticePrimaryStyle} onClick={confirmMicNotice}>
              Включить микрофон
            </button>
            <button type="button" style={micNoticeGhostStyle} onClick={() => setPendingMicAction(null)}>
              Не сейчас
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const controlsRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 4,
}

const panelStyle: CSSProperties = {
  position: 'fixed',
  left: 10,
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 126px)',
  zIndex: 260,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 4,
  pointerEvents: 'auto',
  fontFamily: 'monospace',
  width: 64,
  maxWidth: 'calc(100vw - 20px)',
}

const micNoticeBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 500,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  background: 'rgba(3,3,9,0.58)',
  pointerEvents: 'auto',
}

const micNoticeStyle: CSSProperties = {
  width: 'min(340px, calc(100vw - 40px))',
  borderRadius: 6,
  border: '1px solid rgba(224,64,251,0.38)',
  background: 'rgba(13,13,26,0.96)',
  padding: 16,
  boxShadow: '0 18px 44px rgba(0,0,0,0.45)',
}

const micNoticeTitleStyle: CSSProperties = {
  color: '#e040fb',
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 1.6,
  marginBottom: 10,
  textTransform: 'uppercase',
}

const micNoticeTextStyle: CSSProperties = {
  color: '#d8f7ff',
  fontSize: 12,
  lineHeight: 1.55,
  marginBottom: 14,
}

const micNoticePrimaryStyle: CSSProperties = {
  width: '100%',
  minHeight: 42,
  borderRadius: 4,
  background: '#e040fb',
  color: '#07070c',
  fontFamily: 'monospace',
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 1,
  cursor: 'pointer',
}

const micNoticeGhostStyle: CSSProperties = {
  width: '100%',
  minHeight: 38,
  marginTop: 8,
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'transparent',
  color: '#8f95aa',
  fontFamily: 'monospace',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1,
  cursor: 'pointer',
}

function voiceButtonStyle(active: boolean, busy: boolean, disabled: boolean): CSSProperties {
  return {
    width: 64,
    minHeight: 32,
    borderRadius: 4,
    border: active ? '1px solid #00e676' : '1px solid rgba(255,255,255,0.16)',
    background: active ? '#00e676' : busy ? '#20202a' : 'rgba(13,13,26,0.86)',
    color: active ? '#06100a' : busy || disabled ? '#666' : '#d8f7ff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: 0.7,
    cursor: disabled || busy ? 'not-allowed' : 'pointer',
    touchAction: 'none',
    userSelect: 'none',
  }
}

function muteButtonStyle(enabled: boolean): CSSProperties {
  return {
    width: 64,
    minHeight: 30,
    borderRadius: 4,
    border: enabled ? '1px solid rgba(124,255,196,0.34)' : '1px solid rgba(255,184,77,0.55)',
    background: enabled ? 'rgba(13,13,26,0.86)' : 'rgba(60,36,5,0.88)',
    color: enabled ? '#7cffc4' : '#ffb84d',
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: 0.8,
    cursor: 'pointer',
    touchAction: 'manipulation',
    userSelect: 'none',
  }
}

function autoButtonStyle(enabled: boolean, talking: boolean, busy: boolean, disabled: boolean): CSSProperties {
  return {
    width: 64,
    minHeight: 30,
    borderRadius: 4,
    border: enabled ? '1px solid rgba(0,230,118,0.64)' : '1px solid rgba(255,255,255,0.16)',
    background: talking ? '#00e676' : enabled ? 'rgba(0,74,44,0.86)' : busy ? '#20202a' : 'rgba(13,13,26,0.86)',
    color: talking ? '#06100a' : enabled ? '#7cffc4' : busy || disabled ? '#666' : '#d8f7ff',
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: 900,
    letterSpacing: 0.8,
    cursor: disabled || busy ? 'not-allowed' : 'pointer',
    touchAction: 'manipulation',
    userSelect: 'none',
  }
}

function dotStyle(active: boolean, ready: boolean, hasError: boolean): CSSProperties {
  const color = hasError ? '#ff6b6b' : active ? '#06100a' : ready ? '#00e676' : '#777'
  return {
    width: 7,
    height: 7,
    flex: '0 0 auto',
    borderRadius: '50%',
    background: color,
    boxShadow: active || ready ? `0 0 9px ${color}` : 'none',
  }
}

function statusStyle(color: string): CSSProperties {
  return {
    width: '100%',
    minHeight: 16,
    color,
    background: 'rgba(3,3,9,0.72)',
    border: '1px solid rgba(255,255,255,0.09)',
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: 0.8,
    whiteSpace: 'nowrap',
  }
}

const errorDetailsStyle: CSSProperties = {
  width: 154,
  maxWidth: 'calc(100vw - 20px)',
  color: '#ff8b8b',
  background: 'rgba(40,0,0,0.72)',
  border: '1px solid rgba(255,68,68,0.28)',
  borderRadius: 4,
  padding: '5px 6px',
  fontSize: 9,
  lineHeight: 1.25,
}
