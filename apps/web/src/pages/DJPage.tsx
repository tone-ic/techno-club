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
import { DJ_SCHEDULE_EVENT, gameClient, type DjScheduleItem } from '@/utils/wsClient'

type DJBoothPanelProps = {
  embedded?: boolean
  onMinimize?: () => void
}

const DJ_AUDIO_PRESET_320 = {
  ...AudioPresets.musicHighQualityStereo,
  maxBitrate: 320_000,
}

export function DJBoothPanel({ embedded = false, onMinimize }: DJBoothPanelProps = {}) {
  const roomRef = useRef<Room | null>(null)
  const trackRef = useRef<LocalAudioTrack | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const analyserCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const startingRef = useRef(false)

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle')
  const [connection, setConnection] = useState<ConnectionState>(ConnectionState.Disconnected)
  const [level, setLevel] = useState(0)
  const [listenerCount, setListenerCount] = useState(0)
  const [error, setError] = useState('')
  const [schedule, setSchedule] = useState<DjScheduleItem[]>([])
  const [now, setNow] = useState(Date.now())
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
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const list = await navigator.mediaDevices.enumerateDevices()
      const audioInputs = list.filter((device) => device.kind === 'audioinput')
      setDevices(audioInputs)
      setDeviceId((current) => current || audioInputs[0]?.deviceId || '')
    } catch (e: any) {
      setError(e?.message || 'Не удалось получить доступ к аудиоустройствам')
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    loadDevices()
    return () => {
      stopBroadcast()
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

  const startBroadcast = async () => {
    if (startingRef.current || roomRef.current) return
    startingRef.current = true
    setError('')
    setStatus('connecting')
    let liveKitUrl = ''

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
        setStatus('idle')
        stopMeter()
      })

      await room.connect(url, token, {
        autoSubscribe: false,
        maxRetries: 2,
        websocketTimeout: 20_000,
      })
      updateListenerCount()

      const track = await createLocalAudioTrack({
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
        sampleSize: 16,
      })
      trackRef.current = track

      await room.localParticipant.publishTrack(track, {
        name: 'dj_audio',
        source: Track.Source.Microphone,
        audioPreset: DJ_AUDIO_PRESET_320,
        dtx: false,
        red: true,
        forceStereo: true,
        stream: 'dj',
      })

      startMeter(track.mediaStreamTrack)
      setStatus('live')
    } catch (e: any) {
      await stopBroadcast()
      setStatus('error')
      const message = e?.message || 'Не удалось запустить DJ stream'
      setError(liveKitUrl
        ? `${message}. LiveKit URL: ${liveKitUrl}`
        : message)
    } finally {
      startingRef.current = false
    }
  }

  const stopBroadcast = async () => {
    stopMeter()
    const track = trackRef.current
    const room = roomRef.current
    trackRef.current = null
    roomRef.current = null
    startingRef.current = false

    if (track && room) {
      await room.localParticipant.unpublishTrack(track, true).catch(() => undefined)
    }
    track?.stop()
    await room?.disconnect().catch(() => undefined)
    setConnection(ConnectionState.Disconnected)
    setListenerCount(0)
    setStatus('idle')
  }

  const live = status === 'live'
  const busy = status === 'connecting'
  const currentUserId = usePlayerStore.getState().userId

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
              <button onClick={stopBroadcast} style={stopButton}>
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
