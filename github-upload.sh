#!/bin/bash
# github-upload.sh — Загрузить проект на GitHub
# Запускать из корня репозитория: bash github-upload.sh

echo ""
echo "=== Загрузка DOOR//CLUB на GitHub ==="
echo ""

# 1. Инициализировать git если ещё не сделано
if [ ! -d ".git" ]; then
  git init
  echo "✅ Git репозиторий инициализирован"
fi

# 2. Первый коммит
git add .
git commit -m "feat: initial DOOR//CLUB project structure

- pnpm monorepo: web, game-server, api, shared
- React PWA с Vite + PlayCanvas (заглушки страниц)
- Colyseus game server: OutsideRoom, ClubRoom
- Hono API: LiveKit tokens, avatar cleanup
- Supabase migrations: полная схема БД
- Shared types, constants, events
- Docs: ai-agent-context, architecture, product-rules, setup, ADR"

echo ""
echo "=== Следующие шаги ==="
echo ""
echo "1. Создай репозиторий на GitHub:"
echo "   https://github.com/new"
echo "   Название: techno-club (или doorclub)"
echo "   Visibility: Private (рекомендуется на этапе разработки)"
echo ""
echo "2. Подключи remote и запушь:"
echo ""
echo "   git remote add origin https://github.com/ВАШ_ЮЗЕРНЕЙМ/techno-club.git"
echo "   git branch -M main"
echo "   git push -u origin main"
echo ""
echo "3. (Опционально) Настрой GitHub Actions для автодеплоя:"
echo "   Cloudflare Pages → Connect to Git → выбрать репозиторий"
echo ""
echo "=== Готово ==="
