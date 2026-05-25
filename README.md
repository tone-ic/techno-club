# DOOR//CLUB

> Виртуальный техно-клуб в браузере. PS2-эстетика, живой DJ, фейсконтроль, proximity voice.

---

## Быстрый старт

```bash
# 1. Установить зависимости
pnpm install

# 2. Скопировать env
cp .env.example .env
# Заполнить переменные (см. docs/setup.md)

# 3. Запустить всё
pnpm dev
```

Открой `http://localhost:5173` — это PWA клиент.
Colyseus Game Server стартует на `ws://localhost:2567`.
API (Hono) стартует на `http://localhost:3001`.

---

## Монорепозиторий

```
techno-club/
├── apps/
│   ├── web/              ← React PWA (Vite + PlayCanvas)
│   ├── game-server/      ← Colyseus multiplayer server
│   └── api/              ← Hono REST API (LiveKit tokens, avatar cleanup)
├── packages/
│   └── shared/           ← Общие типы, константы, утилиты
├── supabase/
│   ├── migrations/       ← SQL миграции (применять через Supabase CLI)
│   └── seed.sql          ← Тестовые данные
└── docs/
    ├── ai-agent-context.md  ← ЭТО ЧИТАТЬ ПЕРВЫМ при работе с проектом
    ├── architecture.md
    ├── product-rules.md
    ├── setup.md
    └── adr/              ← Architecture Decision Records
```

---

## Документация

| Файл | Содержание |
|------|------------|
| `docs/ai-agent-context.md` | **Главный файл для AI-агента** — полный контекст проекта |
| `docs/architecture.md` | Схема компонентов, потоки данных |
| `docs/product-rules.md` | Неизменяемые правила продукта |
| `docs/setup.md` | Пошаговая настройка всех сервисов |
| `docs/trellis.md` | Целевая схема TRELLIS image-to-3D avatar pipeline |
| `docs/adr/` | Решения по технологиям с обоснованием |

---

## Технологии

| Слой | Инструмент |
|------|------------|
| Frontend | React 18 + TypeScript + Vite |
| 3D | PlayCanvas (open-source) |
| Мультиплеер | Colyseus на Fly.io |
| Auth + DB | Supabase Free |
| Голос + DJ | LiveKit Cloud |
| Хостинг | Cloudflare Pages |
| Аватар (MVP) | TRELLIS worker (опционально) + локальный fallback |

---

## Команды

```bash
pnpm dev              # Запустить всё параллельно
pnpm dev:web          # Только PWA клиент
pnpm dev:server       # Только Colyseus
pnpm dev:api          # Только API
pnpm build            # Собрать всё
pnpm lint             # ESLint по всему монорепо
pnpm typecheck        # TypeScript проверка
```

---

## Версия документа

Последнее обновление: v2.0 — см. `docs/ai-agent-context.md` для полной картины.
