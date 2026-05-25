# DJ Audio Stream через LiveKit

Цель: DJ выбирает audio input своей звуковой карты или virtual loopback, браузер публикует этот звук в LiveKit, все игроки слышат один общий live-поток.

## Локальный dev

1. Установить LiveKit Server.

Официальный dev-режим LiveKit запускается так:

```bash
livekit-server --dev
```

В dev mode используются ключи:

```env
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_URL=ws://localhost:7880
VITE_LIVEKIT_URL=ws://localhost:7880
VITE_API_URL=http://localhost:3001
```

Если тестируешь с телефона в той же сети, LiveKit надо запускать с bind на сеть:

```bash
livekit-server --dev --bind 0.0.0.0
```

А в env поставить адрес компьютера, например:

```env
LIVEKIT_URL=ws://192.168.0.181:7880
VITE_LIVEKIT_URL=ws://192.168.0.181:7880
```

2. Запустить сервисы проекта:

```bash
pnpm dev
```

Или отдельными терминалами:

```bash
pnpm dev:api
pnpm dev:server
pnpm dev:web
```

Если уже запущены только `pnpm dev:web` и `pnpm dev:server`, кнопка `НАЧАТЬ ЭФИР`
упадёт с ошибкой подключения к API. В этом случае просто запусти третий процесс:

```bash
pnpm dev:api
```

3. Открыть DJ console:

```text
http://localhost:5173/dj
```

4. Выбрать audio input.

Если DJ играет через внешнюю аудиокарту, выбирай вход этой карты. Если нужно отправить master output из Traktor/Rekordbox/Ableton/OBS, нужен loopback-источник:

- Windows: VB-CABLE, VoiceMeeter, OBS Virtual Audio.
- macOS: BlackHole, Loopback.
- Hardware: аудиокарта с loopback/input routing.

5. Нажать `НАЧАТЬ ЭФИР`.

Игроки на `/outside` и `/club` автоматически подписываются на `dj_audio`. MP3 fallback приглушается, когда live DJ stream активен.

## Быстрая диагностика

- `Failed to fetch` / ошибка подключения к API: не запущен `pnpm dev:api` или API занял неправильный порт.
- `LIVEKIT_API_KEY / LIVEKIT_API_SECRET не настроены`: в `.env` остались плейсхолдеры. Для локального `livekit-server --dev` используй `devkey` и `secret`; для LiveKit Cloud - вставь реальные ключи из проекта.
- Ошибка подключения к LiveKit после получения токена: проверь, что `LIVEKIT_URL` и `VITE_LIVEKIT_URL` указывают на тот же LiveKit-сервер, для которого выпущены ключи.

## Production

Для production лучше использовать LiveKit Cloud или self-hosted LiveKit с HTTPS/WSS, TURN и нормальными ключами. Dev key `devkey/secret` нельзя использовать в публичном окружении.
