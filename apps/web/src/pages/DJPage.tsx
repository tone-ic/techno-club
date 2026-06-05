import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AudioPresets,
  ConnectionState,
  createLocalAudioTrack,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client'
import { getLiveKitToken, LIVEKIT_DJ_ROOM } from '@/utils/livekit'
import { usePlayerStore } from '@/store/playerStore'
import { DJ_SCHEDULE_EVENT, MUSIC_SERVER_STATE_EVENT, gameClient, type DjScheduleItem, type MusicServerState } from '@/utils/wsClient'
import { claimCaptureAudioSession, preferCaptureAudioSession } from '@/utils/audioSession'

type DJBoothPanelProps = {
  embedded?: boolean
  onMinimize?: () => void
}

type DjMusicTrack = {
  src: string
  name: string
}

const MUSIC_MANIFEST_URL = '/music/manifest.json'

const DJ_AUDIO_PRESET_DESKTOP = {
  ...AudioPresets.musicHighQualityStereo,
  maxBitrate: 192_000,
}
const DJ_USER_AGENT = typeof navigator === 'undefined' ? '' : navigator.userAgent
const DJ_IS_IOS = /iPad|iPhone|iPod/i.test(DJ_USER_AGENT) ||
  (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const DJ_IS_MOBILE = DJ_IS_IOS || /Android|Mobile/i.test(DJ_USER_AGENT)
const DJ_AUDIO_PRESET = DJ_IS_MOBILE
  ? { ...AudioPresets.musicHighQuality, maxBitrate: DJ_IS_IOS ? 96_000 : 160_000 }
  : DJ_AUDIO_PRESET_DESKTOP
const DJ_CAPTURE_CONSTRAINTS: MediaTrackConstraints = DJ_IS_MOBILE
  ? {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    }
  : {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: 48000,
      sampleSize: 16,
    }

export function DJBoothPanel({ embedded = false, onMinimize }: DJBoothPanelProps = {}) {
  const roomRef = useRef<Room | null>(null)
  const trackRef = useRef<LocalAudioTrack | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const analyserCtxRef = useRef<AudioContext | null>(null)
  const audioSessionReleaseRef = useRef<(() => void) | null>(null)
  const rafRef = useRef<number | null>(null)
  const startingRef = useRef(false)
  const desiredBroadcastRef = useRef(false)
  const reconnectTimerRef = useRef<number | null>(null)

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle')
  const [connection, setConnection] = useState<ConnectionState>(ConnectionState.Disconnected)
  const [level, setLevel] = useState(0)
  const [listenerCount, setListenerCount] = useState(0)
  const [error, setError] = useState('')
  const [schedule, setSchedule] = useState<DjScheduleItem[]>([])
  const [now, setNow] = useState(Date.now())
  const [musicTracks, setMusicTracks] = useState<DjMusicTrack[]>([])
  const [musicState, setMusicState] = useState<MusicServerState | null>(null)
  const [djName, setDjName] = useState(() => {
    const store = usePlayerStore.getState()
    return store.djName || store.displayName || 'DJ'
  })

  const applyDjName = () => {
    const trimmed = djName.trim().slice(0, 24)
    if (!trimmed) return
    setDjName(trimmed)
    usePlayerStore.getState().setDjName(trimmed)
    window.dispatchEvent(new CustomEvent('dj-name-preview', { detail: { djName: trimmed } }))
    gameClient.setDjName(trimmed)
  }

  const loadDevices = useCallback(async () => {
    let permissionStream: MediaStream | null = null
    const releaseAudioSession = claimCaptureAudioSession()
    try {
      permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const list = await navigator.mediaDevices.enumerateDevices()
      const audioInputs = list.filter((device) => device.kind === 'audioinput')
      setDevices(audioInputs)
      setDeviceId((current) => current || audioInputs[0]?.deviceId || '')
    } catch (e: any) {
      setError(e?.message || 'Не удалось получить доступ к аудиоустройствам')
      setStatus('error')
    } finally {
      permissionStream?.getTracks().forEach((track) => track.stop())
      releaseAudioSession()
    }
  }, [])

  useEffect(() => {
    loadDevices()
    return () => {
      desiredBroadcastRef.current = false
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
      stopBroadcast({ notifyServer: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDevices])

  useEffect(() => {
    const onSchedule = (event: Event) => {
      const detail = (event as CustomEvent<{ schedule?: DjScheduleItem[]; serverNow?: number }>).detail
      setSchedule(Array.isArray(detail?.schedule) ? detail.schedule : [])
      if (typeof detail?.serverNow === 'number') setNow(detail.serverNow)
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    window.addEventListener(DJ_SCHEDULE_EVENT, onSchedule)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(DJ_SCHEDULE_EVENT, onSchedule)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadTracks = async () => {
      try {
        const response = await fetch(`${MUSIC_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' })
        if (!response.ok) return
        const manifest = await response.json() as { tracks?: Array<{ src?: string; name?: string }> }
        const tracks = (manifest.tracks ?? [])
          .map((track) => {
            const src = String(track.src || '')
            if (!src) return null
            return {
              src,
              name: String(track.name || trackNameFromSrc(src)),
            }
          })
          .filter((track): track is DjMusicTrack => Boolean(track))
        if (!cancelled) setMusicTracks(tracks)
      } catch {
        if (!cancelled) setMusicTracks([])
      }
    }
    void loadTracks()
    const timer = window.setInterval(loadTracks, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const onMusicState = (event: Event) => {
      const detail = (event as CustomEvent<{ musicState?: MusicServerState }>).detail
      if (detail?.musicState) setMusicState(detail.musicState)
    }
    window.addEventListener(MUSIC_SERVER_STATE_EVENT, onMusicState)
    return () => window.removeEventListener(MUSIC_SERVER_STATE_EVENT, onMusicState)
  }, [])

  useEffect(() => {
    const restartWhenVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (!desiredBroadcastRef.current || roomRef.current || startingRef.current) return
      scheduleBroadcastReconnect(0)
    }
    window.addEventListener('focus', restartWhenVisible)
    window.addEventListener('pageshow', restartWhenVisible)
    document.addEventListener('visibilitychange', restartWhenVisible)
    return () => {
      window.removeEventListener('focus', restartWhenVisible)
      window.removeEventListener('pageshow', restartWhenVisible)
      document.removeEventListener('visibilitychange', restartWhenVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startMeter = (mediaTrack: MediaStreamTrack) => {
    stopMeter()
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(new MediaStream([mediaTrack]))
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    analyserCtxRef.current = ctx
    analyserRef.current = analyser

    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const centered = (data[i] - 128) / 128
        sum += centered * centered
      }
      setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3.2))
      rafRef.current = requestAnimationFrame(tick)
    }
    tick()
  }

  const stopMeter = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    analyserCtxRef.current?.close().catch(() => {})
    analyserCtxRef.current = null
    analyserRef.current = null
    setLevel(0)
  }

  const scheduleBroadcastReconnect = (delayMs = 1_200) => {
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null
      if (!desiredBroadcastRef.current || roomRef.current || startingRef.current) return
      if (document.visibilityState !== 'visible') return
      void startBroadcast()
    }, delayMs)
  }

  const startBroadcast = async () => {
    if (startingRef.current || roomRef.current) return
    desiredBroadcastRef.current = true
    startingRef.current = true
    setError('')
    setStatus('connecting')
    let liveKitUrl = ''
    let pendingAudioSessionRelease: (() => void) | null = null

    try {
      if (!deviceId) await loadDevices()
      const { token, url } = await getLiveKitToken(LIVEKIT_DJ_ROOM, 'dj')
      liveKitUrl = url
      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
      })
      roomRef.current = room

      const updateListenerCount = () => setListenerCount(room.remoteParticipants.size)
      room.on(RoomEvent.ConnectionStateChanged, (state) => setConnection(state))
      room.on(RoomEvent.ParticipantConnected, updateListenerCount)
      room.on(RoomEvent.ParticipantDisconnected, updateListenerCount)
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current === room) roomRef.current = null
        trackRef.current = null
        startingRef.current = false
        setConnection(ConnectionState.Disconnected)
        setListenerCount(0)
        stopMeter()
        if (desiredBroadcastRef.current) {
          setStatus('connecting')
          scheduleBroadcastReconnect(document.visibilityState === 'visible' ? 1_200 : 0)
        } else {
          setStatus('idle')
        }
      })

      await room.connect(url, token, {
        autoSubscribe: false,
        maxRetries: 2,
        websocketTimeout: 20_000,
      })
      updateListenerCount()

      pendingAudioSessionRelease = claimCaptureAudioSession()
      const track = await createLocalAudioTrack({
        deviceId: deviceId ? { exact: deviceId } : undefined,
        ...DJ_CAPTURE_CONSTRAINTS,
      })
      preferCaptureAudioSession()
      trackRef.current = track
      audioSessionReleaseRef.current = pendingAudioSessionRelease
      pendingAudioSessionRelease = null

      await room.localParticipant.publishTrack(track, {
        name: 'dj_audio',
        source: Track.Source.Microphone,
        audioPreset: DJ_AUDIO_PRESET,
        dtx: false,
        red: !DJ_IS_IOS,
        forceStereo: !DJ_IS_MOBILE,
        stream: 'dj',
      })

      startMeter(track.mediaStreamTrack)
      gameClient.setDjStreamLive(true)
      setStatus('live')
    } catch (e: any) {
      pendingAudioSessionRelease?.()
      await stopBroadcast({ notifyServer: false })
      setStatus('error')
      const message = e?.message || 'Не удалось запустить DJ stream'
      setError(liveKitUrl
        ? `${message}. LiveKit URL: ${liveKitUrl}`
        : message)
    } finally {
      startingRef.current = false
    }
  }

  const stopBroadcast = async ({ notifyServer = true }: { notifyServer?: boolean } = {}) => {
    if (notifyServer) desiredBroadcastRef.current = false
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = null
    stopMeter()
    const track = trackRef.current
    const room = roomRef.current
    const releaseAudioSession = audioSessionReleaseRef.current
    trackRef.current = null
    roomRef.current = null
    audioSessionReleaseRef.current = null
    startingRef.current = false

    if (track && room) {
      await room.localParticipant.unpublishTrack(track, true).catch(() => undefined)
    }
    track?.stop()
    await room?.disconnect().catch(() => undefined)
    if (notifyServer) gameClient.setDjStreamLive(false)
    releaseAudioSession?.()
    setConnection(ConnectionState.Disconnected)
    setListenerCount(0)
    setStatus('idle')
  }

  const handleStopBroadcast = () => {
    desiredBroadcastRef.current = false
    void stopBroadcast({ notifyServer: true })
  }

  const live = status === 'live'
  const busy = status === 'connecting'
  const currentUserId = usePlayerStore.getState().userId
  const trackPlaybackActive = musicState?.source === 'track' && musicState.playing !== false
  const currentTrackIdx = musicState?.source === 'track' ? musicState.trackIdx : -1
  const selectedTrackValue = currentTrackIdx >= 0 && currentTrackIdx < musicTracks.length ? String(currentTrackIdx) : ''
  const currentTrackName = musicState?.source === 'dj'
    ? (musicState.djName || 'DJ LIVE')
    : (musicTracks[currentTrackIdx]?.name || musicState?.trackName || 'NO TRACK')
  const trackControlsDisabled = musicTracks.length === 0

  return (
    <div style={embedded ? embeddedRootStyle : pageRootStyle}>
      <header style={embedded ? embeddedHeaderStyle : pageHeaderStyle}>
        <div style={{ color: '#d8b06f', letterSpacing: 3, fontSize: 12 }}>DOOR//CLUB — DJ BOOTH</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 11, color: live ? '#00e676' : '#666' }}>
            {live ? `LIVE / ${listenerCount} LISTENING` : connection}
          </div>
          {embedded && onMinimize && (
            <button type="button" onClick={onMinimize} style={minimizeButtonStyle}>MIN</button>
          )}
        </div>
      </header>

      <main style={embedded ? embeddedMainStyle : pageMainStyle}>
        <section style={embedded ? embeddedPanelStyle : pagePanelStyle}>
          <label style={inputLabelStyle}>
            DJ NAME
            <div style={nameRowStyle}>
              <input
                value={djName}
                onChange={(event) => setDjName(event.target.value.slice(0, 24))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyDjName()
                }}
                maxLength={24}
                style={textInputStyle}
              />
              <button type="button" onClick={applyDjName} style={applyNameButtonStyle}>
                ПРИМЕНИТЬ
              </button>
            </div>
          </label>

          <DjScheduleList
            items={schedule}
            now={now}
            currentUserId={currentUserId}
            onClaim={() => {
              applyDjName()
              gameClient.claimDjScheduleSlot()
            }}
          />

          <section style={trackControlSectionStyle}>
            <div style={trackControlHeaderStyle}>
              <span>TRACK DECK</span>
              <span style={{ color: trackPlaybackActive ? '#00e676' : '#d8b06f' }}>
                {musicState?.source === 'dj' ? 'LIVE INPUT' : trackPlaybackActive ? 'PLAYING' : 'PAUSED'}
              </span>
            </div>
            <div style={currentTrackStyle}>{currentTrackName}</div>
            <div style={trackButtonRowStyle}>
              <button
                type="button"
                disabled={trackControlsDisabled}
                onClick={() => gameClient.djMusicControl('previous')}
                style={deckButtonStyle(trackControlsDisabled)}
              >
                PREV
              </button>
              <button
                type="button"
                disabled={trackControlsDisabled}
                onClick={() => gameClient.djMusicControl(trackPlaybackActive ? 'pause' : 'play')}
                style={deckPrimaryButtonStyle(trackControlsDisabled)}
              >
                {trackPlaybackActive ? 'PAUSE' : 'PLAY'}
              </button>
              <button
                type="button"
                disabled={trackControlsDisabled}
                onClick={() => gameClient.djMusicControl('next')}
                style={deckButtonStyle(trackControlsDisabled)}
              >
                NEXT
              </button>
            </div>
            <select
              value={selectedTrackValue}
              disabled={trackControlsDisabled}
              onChange={(event) => gameClient.djMusicControl('select', Number(event.target.value))}
              style={trackSelectStyle}
            >
              {musicTracks.length === 0 && <option value="">Нет загруженных треков</option>}
              {musicTracks.length > 0 && selectedTrackValue === '' && <option value="">Выбрать трек</option>}
              {musicTracks.map((track, idx) => (
                <option key={`${track.src}-${idx}`} value={idx}>
                  {idx + 1}. {track.name}
                </option>
              ))}
            </select>
          </section>

          <div style={{ fontSize: 11, color: '#666', letterSpacing: 2, marginBottom: 8 }}>AUDIO INPUT</div>
          <select
            value={deviceId}
            disabled={live || busy}
            onChange={(e) => setDeviceId(e.target.value)}
            style={{
              width: '100%',
              minHeight: 40,
              background: '#10101f',
              color: '#e8e8f0',
              border: '1px solid #2a2a3a',
              borderRadius: 4,
              fontFamily: 'monospace',
              padding: '0 10px',
              marginBottom: 12,
            }}
          >
            {devices.length === 0 && <option value="">Нет доступных audio input</option>}
            {devices.map((device, idx) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Audio input ${idx + 1}`}
              </option>
            ))}
          </select>

          <button
            onClick={loadDevices}
            disabled={live || busy}
            style={ghostButton}
          >
            ОБНОВИТЬ УСТРОЙСТВА
          </button>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 8,
            marginTop: 12,
          }}>
            <StatusCell label="ROOM" value={connection} active={connection === ConnectionState.Connected} />
            <StatusCell label="LIVE" value={live ? 'ON' : 'OFF'} active={live} />
            <StatusCell label="LISTEN" value={String(listenerCount)} active={listenerCount > 0} />
          </div>

          <div style={{
            height: 18,
            border: '1px solid #2a2a3a',
            background: '#06060d',
            borderRadius: 3,
            overflow: 'hidden',
            margin: '18px 0 14px',
          }}>
            <div style={{
              height: '100%',
              width: `${Math.round(level * 100)}%`,
              background: live ? 'linear-gradient(90deg,#00e676,#e040fb)' : '#222',
              transition: 'width 0.04s linear',
            }} />
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            {!live ? (
              <button
                onClick={startBroadcast}
                disabled={busy || devices.length === 0}
                style={primaryButton(busy || devices.length === 0)}
              >
                {busy ? 'ПОДКЛЮЧЕНИЕ...' : 'НАЧАТЬ ЭФИР'}
              </button>
            ) : (
              <button onClick={handleStopBroadcast} style={stopButton}>
                ОСТАНОВИТЬ ЭФИР
              </button>
            )}
          </div>

          {error && (
            <div style={{
              marginTop: 14,
              color: '#ff6666',
              fontSize: 12,
              lineHeight: 1.5,
            }}>
              {error}
            </div>
          )}

          <div style={{
            marginTop: 18,
            color: '#555',
            fontSize: 11,
            lineHeight: 1.7,
          }}>
            Выбирай выход аудиокарты/виртуальный loopback как audio input. В браузере это обычно
            BlackHole, VB-CABLE, Loopback, OBS Virtual Audio или вход твоей звуковой карты.
          </div>
        </section>
      </main>
    </div>
  )
}

export default function DJPage() {
  return <DJBoothPanel />
}

function DjScheduleList({
  items,
  now,
  currentUserId,
  onClaim,
}: {
  items: DjScheduleItem[]
  now: number
  currentUserId: string | null
  onClaim: () => void
}) {
  return (
    <section style={scheduleSectionStyle}>
      <div style={scheduleHeaderStyle}>
        <span>DJ СМЕНА</span>
        <span>{items.length ? `${items.length} SLOT` : 'EMPTY'}</span>
      </div>
      <div style={scheduleRowsStyle}>
        {items.length === 0 && (
          <div style={emptyScheduleStyle}>DJ появится здесь после входа в клуб с ролью DJ.</div>
        )}
        {items.map((item) => {
          const self = currentUserId === item.userId
          const timing = djTimingLabel(item, now)
          const active = item.status === 'performing'
          return (
            <button
              key={item.userId}
              type="button"
              onClick={self ? onClaim : undefined}
              disabled={!self}
              style={scheduleRowStyle(self, active)}
            >
              <span style={scheduleNameStyle}>
                {item.djName || item.displayName}
                <span style={scheduleSubNameStyle}>{item.displayName}</span>
              </span>
              <span style={scheduleTimeStyle}>{formatClock(item.slotStartAt)}-{formatClock(item.slotEndAt)}</span>
              <span style={{ ...scheduleStatusStyle, color: item.online ? '#00e676' : '#777' }}>
                {item.online ? 'ONLINE' : 'OFFLINE'}
              </span>
              <span style={scheduleCountdownStyle}>{timing}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function StatusCell({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div style={{
      border: '1px solid #2a2a3a',
      borderRadius: 4,
      background: '#080812',
      padding: '8px 9px',
      minWidth: 0,
    }}>
      <div style={{
        color: '#555',
        fontSize: 9,
        letterSpacing: 1.5,
        marginBottom: 4,
        whiteSpace: 'nowrap',
      }}>
        {label}
      </div>
      <div style={{
        color: active ? '#00e676' : '#777',
        fontSize: 11,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {value}
      </div>
    </div>
  )
}

function djTimingLabel(item: DjScheduleItem, now: number) {
  if (now < item.slotStartAt) return `через ${formatDuration(item.slotStartAt - now)}`
  if (now < item.slotEndAt) return `осталось ${formatDuration(item.slotEndAt - now)}`
  return 'сет завершён'
}

function formatClock(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '--:--'
  return new Date(value).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function trackNameFromSrc(src: string) {
  const fileName = decodeURIComponent(src.split('/').pop() || src)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  return fileName || 'Track'
}

const scheduleSectionStyle = {
  border: '1px solid #242016',
  borderRadius: 4,
  background: '#0b0b10',
  margin: '0 0 14px',
  overflow: 'hidden',
} as const

const scheduleHeaderStyle = {
  minHeight: 34,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '0 10px',
  color: '#d8b06f',
  fontSize: 10,
  letterSpacing: 1.6,
  borderBottom: '1px solid #242016',
} as const

const scheduleRowsStyle = {
  display: 'grid',
  gap: 0,
} as const

const emptyScheduleStyle = {
  padding: '12px 10px',
  color: '#666',
  fontSize: 11,
  lineHeight: 1.45,
} as const

function scheduleRowStyle(self: boolean, active: boolean) {
  return {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.25fr) auto auto minmax(84px, auto)',
    gap: 8,
    alignItems: 'center',
    minHeight: 46,
    padding: '7px 10px',
    border: 'none',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    background: active ? 'rgba(216,176,111,0.18)' : self ? 'rgba(25,215,255,0.09)' : 'transparent',
    color: '#e8e8f0',
    fontFamily: 'monospace',
    textAlign: 'left',
    cursor: self ? 'pointer' : 'default',
  } as const
}

const scheduleNameStyle = {
  minWidth: 0,
  display: 'grid',
  gap: 2,
  color: '#f1eadf',
  fontSize: 11,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const scheduleSubNameStyle = {
  color: '#676056',
  fontSize: 9,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const scheduleTimeStyle = {
  color: '#9d9588',
  fontSize: 10,
  whiteSpace: 'nowrap',
} as const

const scheduleStatusStyle = {
  fontSize: 9,
  whiteSpace: 'nowrap',
} as const

const scheduleCountdownStyle = {
  color: '#d8d0c2',
  fontSize: 10,
  whiteSpace: 'nowrap',
  textAlign: 'right',
} as const

const trackControlSectionStyle = {
  border: '1px solid #1a2d29',
  borderRadius: 4,
  background: '#071111',
  padding: 10,
  margin: '0 0 14px',
} as const

const trackControlHeaderStyle = {
  minHeight: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  color: '#19d7ff',
  fontSize: 10,
  letterSpacing: 1.6,
} as const

const currentTrackStyle = {
  minHeight: 34,
  display: 'flex',
  alignItems: 'center',
  color: '#f1eadf',
  fontSize: 12,
  lineHeight: 1.25,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const trackButtonRowStyle = {
  display: 'grid',
  gridTemplateColumns: '1fr 1.25fr 1fr',
  gap: 8,
  marginBottom: 8,
} as const

function deckButtonStyle(disabled: boolean) {
  return {
    minHeight: 36,
    border: '1px solid #24413c',
    borderRadius: 4,
    background: disabled ? '#10151a' : '#0c2220',
    color: disabled ? '#555' : '#a7f5e7',
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: 800,
    cursor: disabled ? 'not-allowed' : 'pointer',
  } as const
}

function deckPrimaryButtonStyle(disabled: boolean) {
  return {
    ...deckButtonStyle(disabled),
    border: '1px solid rgba(0,230,118,0.52)',
    background: disabled ? '#10151a' : 'rgba(0,230,118,0.14)',
    color: disabled ? '#555' : '#d6ffe6',
  } as const
}

const trackSelectStyle = {
  width: '100%',
  minHeight: 38,
  background: '#10101f',
  color: '#e8e8f0',
  border: '1px solid #24413c',
  borderRadius: 4,
  fontFamily: 'monospace',
  fontSize: 11,
  padding: '0 10px',
} as const

const ghostButton = {
  width: '100%',
  minHeight: 36,
  background: 'transparent',
  color: '#888',
  border: '1px solid #2a2a3a',
  borderRadius: 4,
  fontFamily: 'monospace',
  fontSize: 11,
  cursor: 'pointer',
} as const

const inputLabelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  color: '#666',
  fontSize: 10,
  letterSpacing: 2,
  marginBottom: 12,
} as const

const textInputStyle = {
  width: '100%',
  minHeight: 40,
  background: '#10101f',
  color: '#e8e8f0',
  border: '1px solid #2a2a3a',
  borderRadius: 4,
  fontFamily: 'monospace',
  padding: '0 10px',
  outline: 'none',
} as const

const nameRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 8,
} as const

const applyNameButtonStyle = {
  minHeight: 40,
  padding: '0 12px',
  border: '1px solid rgba(25,215,255,0.42)',
  borderRadius: 4,
  background: 'rgba(25,215,255,0.12)',
  color: '#d8f7ff',
  fontFamily: 'monospace',
  fontSize: 10,
  fontWeight: 800,
  cursor: 'pointer',
} as const

const pageRootStyle = {
  minHeight: '100vh',
  background: '#080812',
  color: '#e8e8f0',
  fontFamily: 'monospace',
  display: 'flex',
  flexDirection: 'column',
} as const

const embeddedRootStyle = {
  width: 'min(520px, calc(100vw - 24px))',
  maxHeight: 'calc(100dvh - 104px)',
  background: 'rgba(8,8,18,0.94)',
  color: '#e8e8f0',
  fontFamily: 'monospace',
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid rgba(224,64,251,0.36)',
  borderRadius: 8,
  boxShadow: '0 18px 60px rgba(0,0,0,0.5), 0 0 32px rgba(224,64,251,0.18)',
  overflow: 'hidden',
  pointerEvents: 'auto',
} as const

const pageHeaderStyle = {
  height: 58,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 18px',
  borderBottom: '1px solid #1a1a2e',
} as const

const embeddedHeaderStyle = {
  ...pageHeaderStyle,
  minHeight: 52,
  height: 52,
} as const

const pageMainStyle = {
  flex: 1,
  display: 'grid',
  placeItems: 'center',
  padding: 24,
} as const

const embeddedMainStyle = {
  flex: 1,
  padding: 14,
  overflowY: 'auto',
} as const

const pagePanelStyle = {
  width: 'min(520px, 100%)',
  border: '1px solid #1a1a2e',
  borderRadius: 8,
  background: 'rgba(13,13,26,0.76)',
  padding: 18,
} as const

const embeddedPanelStyle = {
  width: '100%',
  border: 'none',
  borderRadius: 0,
  background: 'transparent',
  padding: 0,
} as const

const minimizeButtonStyle = {
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
} as const

function primaryButton(disabled: boolean) {
  return {
    flex: 1,
    minHeight: 46,
    background: disabled ? '#20202a' : '#00e676',
    color: disabled ? '#666' : '#06100a',
    border: 'none',
    borderRadius: 4,
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
  } as const
}

const stopButton = {
  flex: 1,
  minHeight: 46,
  background: '#d92300',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  fontFamily: 'monospace',
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 1,
  cursor: 'pointer',
} as const
