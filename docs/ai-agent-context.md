# AI Agent Context — DOOR//CLUB

> **Читай этот файл первым при любой работе с проектом.**
> Он содержит полный контекст: что строим, как устроено, какие решения приняты и почему.

---

## Что это за проект

DOOR//CLUB — браузерный социальный симулятор ночного клуба.
- **Формат**: PWA (мобильный веб-сайт), адаптирован под iPhone Safari.
- **Стиль графики**: PS2 low-poly эстетика — намеренно, для производительности и приватности.
- **Суть**: пользователи создают аватары из двух фото, стоят в очереди, проходят фейсконтроль, тусуются внутри, слушают живого DJ.

---

## Правила, которые НЕЛЬЗЯ нарушать

1. Оригинальные фото (лицо, тело) **никогда** не видят другие пользователи.
2. Оригинальные фото **удаляются с сервера** через ≤ 5 минут после генерации аватара.
3. Фейсконтроль видит **только аватар** — не реальное лицо, не тело, не email.
4. Все игровые решения принимает **сервер (Colyseus)** — клиент только предлагает намерение.
5. LiveKit-токены выдаются **только через API** после проверки Supabase JWT.
6. `service_role` ключ Supabase — **только на сервере**, никогда в браузере.
7. Приложение **18+**, требуется подтверждение при регистрации.
8. Фейсконтроль может отказать только с **reason code** из заданного списка.
9. **Максимум 3 отказа** от одного фейсконтроля подряд → авто-эскалация администратору.

---

## Архитектура — четыре слоя

```
┌─────────────────────────────────────────────────────────┐
│  PWA / Browser Client (apps/web)                        │
│  React + PlayCanvas 3D + LiveKit + Colyseus client      │
│  Хостинг: Cloudflare Pages                              │
└────────────┬──────────────┬───────────────┬─────────────┘
             │              │               │
             ▼              ▼               ▼
┌─────────────────┐ ┌──────────────┐ ┌────────────────────┐
│ Supabase        │ │ Colyseus     │ │ LiveKit            │
│ Auth, DB,       │ │ Game Server  │ │ Voice + DJ Audio   │
│ Storage, RLS    │ │ Fly.io       │ │ Cloud / Fly.io     │
└─────────────────┘ └──────────────┘ └────────────────────┘
                            │
                    ┌───────┴────────┐
                    │ Hono API       │
                    │ (apps/api)     │
                    │ Fly.io         │
                    └────────────────┘
```

**Supabase** — хранит: пользователи, профили, аватар-конфиги, роли, очередь, логи модерации, баны.
**Colyseus** — хранит: реальное состояние комнат (позиции, очередь, роли), авторитарен.
**LiveKit** — передаёт: голос игроков (proximity), DJ-аудио (глобально).
**Hono API** — выдаёт LiveKit-токены, запускает Edge Functions для cleanup фото.

---

## Структура файлов

```
apps/web/src/
├── scenes/
│   ├── outside/          ← Улица перед клубом
│   │   ├── OutsideScene.ts   ← PlayCanvas сцена
│   │   └── OutsideUI.tsx     ← HUD для улицы
│   └── club/             ← Интерьер клуба
│       ├── ClubScene.ts
│       └── ClubUI.tsx
├── avatar/
│   ├── AvatarBuilder.ts      ← Сборка аватара из config
│   ├── trellisPipeline.ts    ← TRELLIS worker client (optional)
│   ├── MediaPipePipeline.ts  ← Валидация фото
│   └── PS2Shaders.ts         ← Vertex wobble, dithering
├── audio/
│   ├── AudioEngine.ts        ← Web Audio context, ambient
│   ├── ProximityEngine.ts    ← Расчёт громкости по дистанции
│   └── DJStream.ts           ← DJ трансляция
├── store/
│   ├── playerStore.ts        ← Zustand: локальный игрок
│   ├── roomStore.ts          ← Zustand: состояние комнаты
│   └── audioStore.ts         ← Zustand: аудио состояние
├── hooks/
│   ├── useColyseus.ts        ← Подключение к game server
│   ├── useLiveKit.ts         ← Голос и DJ
│   ├── useCamera.ts          ← getUserMedia + fallback
│   └── useProximity.ts       ← Proximity voice обновления
├── ui/
│   ├── HUD.tsx               ← Основной HUD (кнопки, таймер)
│   ├── Queue.tsx             ← UI очереди
│   ├── AppearanceEditor.tsx  ← Редактор аватара
│   ├── BouncerPanel.tsx      ← Панель фейсконтроля
│   └── ModerationPanel.tsx   ← Панель охраны/мода
├── types/
│   └── index.ts              ← Все TypeScript типы
└── utils/
    ├── photoUtils.ts         ← EXIF strip, сжатие, Canvas
    └── navmesh.ts            ← Tap-to-move pathfinding

apps/game-server/src/
├── rooms/
│   ├── OutsideRoom.ts        ← Улица: позиции, очередь
│   └── ClubRoom.ts           ← Клуб: позиции, DJ, VIP
├── schemas/
│   ├── Player.ts             ← Colyseus Schema: игрок
│   └── RoomState.ts          ← Colyseus Schema: комната
└── handlers/
    ├── queueHandlers.ts      ← joinQueue, leaveQueue
    ├── admissionHandlers.ts  ← approveEntry, denyEntry
    └── moderationHandlers.ts ← mute, kick, ban

apps/api/src/
├── routes/
│   ├── livekit.ts            ← POST /livekit/token
│   └── avatar.ts             ← DELETE /avatar/originals
└── middleware/
    └── auth.ts               ← Проверка Supabase JWT

packages/shared/src/
├── types.ts                  ← Общие типы (Player, Room, Avatar...)
├── constants.ts              ← Игровые константы
└── events.ts                 ← Colyseus event names
```

---

## Типы данных — ключевые интерфейсы

```typescript
// Роли пользователя
type UserRole = 'guest' | 'bouncer' | 'guard' | 'dj' | 'bartender' | 'light' | 'admin'

// Статус в клубе
type PlayerStatus = 'outside' | 'queuing' | 'denied' | 'inside' | 'vip'

// Конфиг аватара (хранится в Supabase)
interface AvatarConfig {
  bodyId: string           // 'body_01'..'body_05'
  headId: string           // 'head_01'..'head_05'
  skinTone: string         // hex
  hairStyle: string        // 'short_01'..'short_10'
  hairColor: string        // hex
  topStyle: string         // 'hoodie' | 'tshirt' | 'jacket'...
  topColor: string         // hex
  bottomStyle: string      // 'cargo' | 'jeans' | 'skirt'...
  bottomColor: string      // hex
  shoesStyle: string
  shoesColor: string       // hex
  accessory: string | null // 'chain_01' | 'glasses_01'...
  mood: 'stoic' | 'chill' | 'hyper' | 'tired' | 'confident'
  faceTextureUrl: string | null
  modelUrl: string | null   // optional TRELLIS/generated GLB
  rpmGlbUrl: string | null  // legacy external GLB, do not create new RPM avatars
}

// Игровое состояние игрока (в Colyseus)
interface PlayerState {
  userId: string
  displayName: string
  avatarConfig: AvatarConfig
  x: number
  z: number
  rotY: number
  status: PlayerStatus
  role: UserRole
  cooldownUntil: number | null  // unix timestamp
  isMuted: boolean
  isTalking: boolean
}

// Reason codes для отказа фейсконтроля
type DenyReason =
  | 'dress_code'       // не тот дресс-код
  | 'overcrowded'      // клуб заполнен
  | 'behavior'         // жалобы/агрессия
  | 'closed_event'     // закрытое мероприятие
  | 'vibe_check'       // игровой отказ (лимит: 1 раз в 30 мин)
```

---

## Константы проекта

```typescript
// packages/shared/src/constants.ts
COOLDOWN_MINUTES = 10            // таймер после отказа
MAX_PLAYERS_PER_ROOM = 50        // максимум в одной комнате
PROXIMITY_VOICE_RADIUS = 8       // единицы PlayCanvas
RECONNECT_WINDOW_SECONDS = 300   // 5 минут для реконнекта
MAX_BOUNCER_DENIALS_IN_ROW = 3   // после этого → эскалация
PHOTO_CLEANUP_MINUTES = 5        // удалить оригиналы фото
DJ_TRACK_VOLUME = 0.75           // громкость DJ в клубе
STREET_CLUB_VOLUME = 0.20        // приглушённый бас на улице
VIBE_CHECK_COOLDOWN_MINUTES = 30 // лимит на "vibe_check" отказ
```

---

## Colyseus Events — полный список

```typescript
// CLIENT → SERVER
'joinQueue'         // встать в очередь
'leaveQueue'        // выйти из очереди
'move'              // { x, z, rotY } намерение движения
'emote'             // { emoteId } показать эмоцию
'changeAppearance'  // { avatarConfig } обновить аватар (cooldown period)
'enterClub'         // войти в клуб (после approve)
'reportPlayer'      // { targetId, reason }
'requestMute'       // мод: { targetId }
'requestKick'       // мод: { targetId }

// SERVER → CLIENT (через state sync + messages)
'queueUpdate'       // { position, total }
'admissionResult'   // { result: 'approved'|'denied', reason?, cooldownUntil? }
'playerJoined'      // новый игрок появился
'playerLeft'        // игрок ушёл
'moderationAction'  // { action, targetId } — для UI feedback
'escalation'        // фейсконтроль: твоё действие отправлено на ревью
```

---

## Supabase — таблицы и RLS

```sql
-- profiles: базовый профиль
-- RLS: SELECT доступен для всех авторизованных
--      INSERT/UPDATE только свой profile (auth.uid() = user_id)

-- avatars: конфиг аватара
-- RLS: SELECT только свой + публичные поля для других (без face_texture_url)
--      face_texture_url — скрыт от других через RLS

-- admission_attempts: история фейсконтроля
-- RLS: SELECT только свой history или bouncer/admin
--      INSERT только сервер (через service_role)

-- roles: роли с TTL
-- RLS: SELECT свои + admin видит всё
--      INSERT/UPDATE только admin через service_role
```

---

## PlayCanvas — соглашения

- Единицы: 1 unit = 1 метр условно
- Ось Y направлена вверх
- Аватары: capsule collider, radius 0.3, height 1.8
- Navmesh: плоскость Y=0, obstacles — box colliders
- Сцены грузятся через PlayCanvas Scenes API, не через HTML
- Шейдеры хранятся в `apps/web/src/scenes/shaders/`
- GLB модели хранятся в `apps/web/public/models/`
- Текстуры хранятся в `apps/web/public/textures/`

---

## Аудио — соглашения

- AudioContext создаётся один раз в `AudioEngine.ts`, разблокируется при первом тапе
- DJ-трек: LiveKit RemoteAudioTrack → Web Audio destination
- Proximity voice: каждый RemoteAudioTrack имеет свой GainNode
- Ambient: отдельный AudioBufferSourceNode с loop:true
- Уличный приглушённый клуб: DJ-трек → BiquadFilterNode (lowpass, 200Hz) → GainNode(0.2)

---

## iPhone / Safari — известные проблемы

| Проблема | Решение |
|----------|---------|
| AudioContext заблокирован до жеста | `audioCtx.resume()` в обработчике touchstart |
| getUserMedia может не работать в Telegram WebView | Показать кнопку "Открыть в Safari" |
| Нагрев при 3D + WebRTC | Auto quality preset, FPS cap 30, LOD |
| Autoplay видео/аудио | Требует атрибут `muted` или жест пользователя |
| input[type=file] capture на iOS | Работает, использовать как fallback |
| WebGL context limit | Один PlayCanvas Application, не несколько canvas |

---

## Переменные окружения

```bash
# apps/web (публичные, начинаются с VITE_)
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_COLYSEUS_URL=ws://localhost:2567
VITE_LIVEKIT_URL=wss://your-livekit.livekit.cloud
VITE_API_URL=http://localhost:3001

# apps/game-server (серверные)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=        # НИКОГДА в браузер
GAME_SERVER_PORT=2567

# apps/api (серверные)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=        # НИКОГДА в браузер
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
TRELLIS_WORKER_URL=               # optional private image-to-3D worker
API_PORT=3001
```

---

## Деплой — где что живёт

| Компонент | Платформа | Команда деплоя |
|-----------|-----------|----------------|
| `apps/web` | Cloudflare Pages | Auto-deploy из main |
| `apps/game-server` | Fly.io | `fly deploy` из apps/game-server |
| `apps/api` | Fly.io | `fly deploy` из apps/api |
| LiveKit | LiveKit Cloud / Fly.io | self-host docker |
| Supabase | Supabase Cloud | `supabase db push` |

---

## Текущий статус разработки

- [ ] Неделя 1: PWA skeleton, Supabase auth, camera flow
- [ ] Неделя 2: Avatar builder, PlayCanvas scene
- [ ] Неделя 3: Colyseus multiplayer
- [ ] Неделя 4: Queue, bouncer, cooldown
- [ ] Неделя 5: Club scene
- [ ] Неделя 6: LiveKit voice + DJ
- [ ] Неделя 7: Moderation, reconnect, iPhone optimization
- [ ] Неделя 8: Closed alpha, Telegram wrapper

Обновляй этот чеклист по мере завершения задач.

---

## Как работать с этим репозиторием (для AI-агента)

1. **Всегда читай этот файл первым** при старте новой задачи.
2. **Проверяй типы** в `packages/shared/src/types.ts` перед созданием новых.
3. **Не дублируй константы** — все игровые числа в `packages/shared/src/constants.ts`.
4. **Не добавляй игровую логику в клиент** — только через Colyseus message.
5. **Не храни** `service_role` key нигде кроме серверных `.env`.
6. **ADR**: если принимаешь архитектурное решение — добавь файл в `docs/adr/`.
7. **Типизация**: все Colyseus schemas используют `@colyseus/schema`, не plain objects.
8. **Imports**: используй path aliases (`@/` → `apps/web/src/`, `@shared/` → `packages/shared/src/`).
