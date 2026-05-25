import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { GAME_SERVER_STATUS_EVENT, getGameServerStatus, type GameServerStatus } from '@/utils/wsClient'

export default function AdminDebugOverlay() {
  const role = usePlayerStore((state) => state.role)
  const clublesBalance = usePlayerStore((state) => state.clublesBalance)
  const [status, setStatus] = useState<GameServerStatus>(() => getGameServerStatus())

  useEffect(() => {
    const onStatus = (event: Event) => {
      setStatus((event as CustomEvent<GameServerStatus>).detail)
    }
    window.addEventListener(GAME_SERVER_STATUS_EVENT, onStatus)
    return () => window.removeEventListener(GAME_SERVER_STATUS_EVENT, onStatus)
  }, [])

  if (role !== 'admin') return null

  const entitlements = status.activeEntitlements?.length
    ? status.activeEntitlements.join(', ')
    : 'none'
  const trackIdx = typeof status.musicTrackIdx === 'number' ? status.musicTrackIdx + 1 : 0
  const trackCount = status.musicTrackCount ?? 0

  return (
    <div style={overlayStyle}>
      <DebugRow label="WS" value={status.connected ? 'connected' : 'offline'} tone={status.connected ? '#7cffc4' : '#ff7a7a'} />
      <DebugRow label="room" value={status.currentRoom ?? 'unknown'} />
      <DebugRow label="role" value={status.role ?? role} />
      <DebugRow label="music" value={`${trackIdx}/${trackCount}`} />
      <DebugRow label="clubles" value={String(status.clublesBalance ?? clublesBalance)} />
      <DebugRow label="entitlements" value={entitlements} />
      <DebugRow label="protocol" value={status.protocolVersion ?? 'unknown'} />
    </div>
  )
}

function DebugRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={{ ...valueStyle, color: tone ?? '#d8d0c2' }}>{value}</span>
    </div>
  )
}

const overlayStyle: CSSProperties = {
  position: 'absolute',
  left: 12,
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
  zIndex: 520,
  width: 'min(320px, calc(100vw - 24px))',
  padding: '8px 10px',
  borderRadius: 4,
  border: '1px solid rgba(124,255,196,0.28)',
  background: 'rgba(3, 7, 8, 0.82)',
  boxShadow: '0 12px 28px rgba(0,0,0,0.34)',
  color: '#d8d0c2',
  fontFamily: 'monospace',
  fontSize: 10,
  lineHeight: 1.45,
  pointerEvents: 'none',
}

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '92px minmax(0, 1fr)',
  gap: 8,
  alignItems: 'baseline',
}

const labelStyle: CSSProperties = {
  color: '#7b8f88',
  textTransform: 'uppercase',
}

const valueStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
