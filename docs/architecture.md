# Architecture — DOOR//CLUB

## Диаграмма потоков данных

```
iPhone / Browser
      │
      │  HTTPS (Cloudflare Pages)
      ▼
┌─────────────────────────────────────────┐
│           apps/web (React PWA)          │
│                                         │
│  PlayCanvas 3D ◄──── scene state ────┐  │
│  React UI      ◄──── zustand store ──┤  │
│                                      │  │
│  useColyseus ──────────────────────► │  │
│  useLiveKit  ──────────────────────► │  │
│  useCamera   (getUserMedia)          │  │
└──────────┬──────────────┬────────────┘  
           │              │
    WebSocket          WebRTC
    (Colyseus)        (LiveKit)
           │              │
           ▼              ▼
┌──────────────┐  ┌────────────────────┐
│   Colyseus   │  │      LiveKit       │
│ Game Server  │  │  (Cloud / Fly.io)  │
│   Fly.io     │  │                    │
│              │  │  - Voice tracks    │
│ OutsideRoom  │  │  - DJ audio track  │
│ ClubRoom     │  │  - proximity vol   │
└──────┬───────┘  └────────────────────┘
       │ HTTP (service_role)
       ▼
┌─────────────────────┐    ┌────────────────┐
│      Supabase       │◄───│   apps/api     │
│                     │    │  (Hono, Fly.io)│
│ - Auth (JWT)        │    │                │
│ - Postgres (RLS)    │    │ POST /livekit/ │
│ - Storage (GLB,tex) │    │      token     │
│ - Edge Functions    │    │ DELETE /avatar/│
└─────────────────────┘    │        photos  │
                           └────────────────┘
```

## Поток: новый игрок

```
1. Открывает сайт → Supabase Auth (email / Google)
2. Camera flow → 2 фото → нормализация и EXIF strip на клиенте
3. Avatar generation:
   - если TRELLIS worker доступен: fullbody photo → GLB → Supabase Storage → `config_json.modelUrl`
   - если worker недоступен: локальный процедурный `AvatarConfig`
4. Оригинальные фото → Supabase Storage/private temp или worker scratch → TTL ≤ 5 min
5. Edge Function / Cron → DELETE originals
6. Connect to Colyseus OutsideRoom
7. Connect to LiveKit room (token from /api/livekit/token)
8. Появляется на улице
```

## Поток: очередь и фейсконтроль

```
Гость                    Colyseus Server              Фейсконтроль
  │                            │                            │
  ├── message('joinQueue') ───►│                            │
  │                            │── broadcast queue update ──►│
  │                            │                            │
  │                            │◄── message('approveEntry')─┤
  │                            │    { guestId, bouncerId }  │
  │                            │                            │
  │◄── message('admissionResult', { result: 'approved' }) ──┤
  │    + admission_token в state                            │
  │                            │                            │
  ├── message('enterClub') ───►│                            │
  │                            │ verify admission_token     │
  │                            │ JOIN ClubRoom              │
  │◄── ClubRoom state sync ────┤                            │
```

## Поток: отказ и cooldown

```
Colyseus Server
  │
  ├── denyEntry({ guestId, reason, bouncerId })
  │
  ├── UPDATE admission_attempts: cooldown_until = now + 10min
  │
  ├── Проверить bouncer_stats: если denials_in_row >= 3
  │     → escalation event → admin notified
  │
  └── broadcast to guest: { result: 'denied', cooldownUntil }
        Guest UI показывает таймер 10:00 → 00:00
```

## Proximity Voice

```typescript
// В apps/web/src/hooks/useProximity.ts
// Каждый frame (или каждые 200ms):
for (const [userId, track] of remoteTracks) {
  const other = roomState.players.get(userId)
  if (!other) continue
  const dist = Math.sqrt(
    (localPlayer.x - other.x) ** 2 +
    (localPlayer.z - other.z) ** 2
  )
  let vol = Math.max(0, 1 - dist / PROXIMITY_VOICE_RADIUS)
  if (nearSpeakerStack(localPlayer)) vol *= 0.3
  track.setVolume(vol)
}
```

## DJ Audio

```
DJ Browser (desktop)
  │
  ├── Web Audio API: AudioContext
  │   └── MediaStreamDestination
  │
  ├── LiveKit: publishTrack(stream, { name: 'dj-audio', source: Track.Source.ScreenShare })
  │
LiveKit Server
  │
  ├── Все участники ClubRoom подписаны на 'dj-audio' track
  │
  ├── RemoteAudioTrack.setVolume(DJ_TRACK_VOLUME) // 0.75
  │
  └── На улице: filtered copy через BiquadFilter (lowpass 200Hz) × 0.2
```

## Состояние (Zustand stores)

```typescript
// playerStore: только локальный игрок
{ userId, displayName, avatarConfig, status, role, cooldownUntil }

// roomStore: состояние комнаты из Colyseus
{ players: Map<string, PlayerState>, queuePosition, roomId, roomType }

// audioStore: аудио состояние
{ audioContextReady, djTrackActive, isMuted, isTalking, ambientVolume }
```

---

_См. `docs/ai-agent-context.md` для полного контекста._
