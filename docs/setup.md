# Setup Guide — DOOR//CLUB

## Требования

- Node.js 20+
- pnpm 9+
- Аккаунты: Supabase, Fly.io, LiveKit Cloud, Cloudflare

---

## 1. Репозиторий

```bash
git clone <repo>
cd techno-club
corepack enable
pnpm install
cp .env.example .env
```

---

## 2. Supabase

### Локальная разработка

Для текущей стадии проекта сначала поднимай Supabase локально:

```bash
supabase start
supabase migration up
```

После `supabase start` CLI выведет локальные `API URL`, `anon key` и `service_role key`. Их нужно перенести в `.env`:

```env
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<anon key from supabase start>
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase start>
```

Если нужно полностью пересобрать локальную базу и заново применить все миграции:

```bash
supabase db reset
```

`db reset` удаляет локальные данные.

Если `.env` указывает на облачный Supabase, локальные миграции не помогут этому проекту. Для текущего `.env` нужно применить миграции к linked Supabase project:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

### Удаленный проект

```bash
# Установить Supabase CLI
npm install -g supabase

# Войти
supabase login

# Создать новый проект на https://supabase.com/dashboard
# Скопировать Project URL и anon key → в .env

# Применить миграции
supabase db push

# Применить seed (тестовые данные, опционально)
supabase db seed
```

В `.env`:
```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...  # только в серверных .env!
```

---

## 3. Colyseus Game Server (Fly.io)

```bash
cd apps/game-server

# Установить Fly CLI
brew install flyctl  # или: curl -L https://fly.io/install.sh | sh

# Войти
fly auth login

# Создать приложение
fly launch --name doorclub-gameserver --region fra

# Задать секреты
fly secrets set SUPABASE_URL=https://xxxx.supabase.co
fly secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Деплой
fly deploy
```

Для локальной разработки:
```bash
pnpm dev:server
# Запускается на ws://localhost:2567
```

---

## 4. LiveKit

### Вариант A: LiveKit Cloud (рекомендуется для альфа)

1. Зарегистрироваться на https://livekit.io
2. Создать проект
3. Скопировать API Key, API Secret, WebSocket URL

В `.env`:
```
LIVEKIT_API_KEY=API...
LIVEKIT_API_SECRET=secret...
VITE_LIVEKIT_URL=wss://doorclub.livekit.cloud
```

### Вариант B: Self-hosted на Fly.io (для беты)

```bash
# Создать livekit.yaml (см. docs/livekit-config.yaml)
fly launch --image livekit/livekit-server:latest --name doorclub-livekit
fly secrets set LIVEKIT_CONFIG="$(cat livekit.yaml)"
fly deploy
```

---

## 5. Hono API (Fly.io)

```bash
cd apps/api
fly launch --name doorclub-api --region fra
fly secrets set SUPABASE_URL=...
fly secrets set SUPABASE_SERVICE_ROLE_KEY=...
fly secrets set LIVEKIT_API_KEY=...
fly secrets set LIVEKIT_API_SECRET=...
fly deploy
```

---

## 6. Frontend (Cloudflare Pages)

```bash
# Или через Cloudflare dashboard → Connect to Git

# Настройки сборки:
# Build command: pnpm build:web
# Output directory: apps/web/dist
# Root directory: /
# Environment variables: добавить VITE_* переменные
```

Для тестов на реальном iPhone:
```bash
# Cloudflare Tunnel (dev)
cloudflared tunnel --url http://localhost:5173
# Получишь HTTPS URL → открыть на iPhone
```

---

## 7. Аватары

Ready Player Me не используется: сервис был остановлен 31 января 2026 года. Целевая схема генерации:

1. TRELLIS worker создаёт GLB из фото полного роста.
2. GLB сохраняется в Supabase Storage, ссылка пишется в `avatars.glb_url` и `config_json.modelUrl`.
3. Локальный процедурный генератор остаётся мгновенным fallback, если GPU worker недоступен или очередь занята.

Локальный fallback работает полностью в браузере:

1. Один кадр полного роста → нормализация кадра и извлечение цветов одежды.
2. Лицо автоматически вырезается из этого же кадра → нормализация портрета и генерация face texture.
3. `AvatarConfig` + сжатые texture data URLs сохраняются в Supabase `avatars.config_json`.
4. 3D-превью и персонаж в мире собираются процедурно на клиенте.

Для локального fallback отдельные ключи или аккаунты не нужны. Для TRELLIS нужен отдельный GPU worker или self-hosted Space; публичное демо Hugging Face можно использовать только для ручных экспериментов, не как production-зависимость.

### TRELLIS локально

В dev-режиме TRELLIS тоже должен быть локальным сервисом рядом с API:

```env
TRELLIS_WORKER_PROVIDER=
TRELLIS_WORKER_URL=http://127.0.0.1:7860
TRELLIS_WORKER_TOKEN=
SUPABASE_AVATAR_MODELS_BUCKET=avatar-models
```

Worker должен отвечать на `POST /generate` по контракту из `docs/trellis.md`.

Реальный image-to-3D локально имеет смысл запускать только на машине с NVIDIA GPU и достаточной VRAM. Если GPU нет, оставь `TRELLIS_WORKER_URL=` пустым: API попробует публичный Hugging Face Pixal3D Space. Для намеренного отключения GLB-генерации поставь `TRELLIS_WORKER_PROVIDER=disabled`.

### Blender autorig локально

Бесплатный autorig включается отдельным опциональным шагом после TRELLIS/зеркалирования GLB. Для него нужен установленный Blender на машине, где запущен `apps/api`.

```env
BLENDER_AUTORIG_ENABLED=1
BLENDER_PATH=blender
BLENDER_AUTORIG_TIMEOUT_MS=180000
```

Если `blender --version` не работает из терминала API, укажи полный путь в `BLENDER_PATH`, например `C:\Program Files\Blender Foundation\Blender 4.2\blender.exe`. Когда Blender выключен или autorig падает, API сохраняет исходный TRELLIS GLB и возвращает `autorig.status: "disabled"` или `"failed"`.

### Blender autorig на Fly.io

API Docker image устанавливает системный Blender и запускает autorig через `/usr/bin/blender`. Для production держи API VM не меньше `2048mb`: Blender часто падает или уходит в timeout на маленьких `256mb` инстансах. После изменения `apps/api/fly.toml` нужен новый деплой API:

```bash
fly deploy -c apps/api/fly.toml
```

### Pixal3D через Hugging Face Space для dev

Если локального GPU нет, можно временно использовать публичный Pixal3D-Server как dev-провайдер. API выбирает опубликованный `gradio.live` инстанс с минимальной очередью и сохраняет готовый GLB в Supabase:

```env
TRELLIS_WORKER_PROVIDER=huggingface
TRELLIS_WORKER_URL=
TRELLIS_WORKER_TOKEN=
HF_PIXAL3D_SPACE_ID=TencentARC/Pixal3D-Server
HF_PIXAL3D_INSTANCE_URLS=
SUPABASE_AVATAR_MODELS_BUCKET=avatar-models
```

GLB генерация использует `/preprocess`, `/generate_3d` и `/extract_glb_api`: resolution 1024, SS Guidance 10, SS Sampling 50, Shape Guidance 9, decimation target 1000000, texture size 2048, timeout 300 секунд на стадию.

---

## 8. Локальный запуск всего

```bash
# Terminal 1: Supabase local
supabase start
supabase migration up

# Terminal 2: Frontend
pnpm dev:web

# Terminal 3: Game Server
pnpm dev:server

# Terminal 4: API
pnpm dev:api

# Terminal 5 (опционально): TRELLIS worker
# слушает http://127.0.0.1:7860/generate
```

---

## Проверка что всё работает

- [ ] `http://localhost:5173` открывается
- [ ] Авторизация через email работает
- [ ] Camera flow: 2 фото делаются на iPhone (через Cloudflare Tunnel URL)
- [ ] Аватар создаётся
- [ ] 2 браузера видят друг друга на улице
- [ ] Push-to-talk работает
