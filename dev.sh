#!/bin/bash
# dev.sh — Локальный запуск DOOR//CLUB для разработки
# Запускать из корня репозитория: bash dev.sh

set -e

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "  ██████╗  ██████╗  ██████╗ ██████╗      ██████╗██╗     ██╗   ██╗██████╗ "
echo "  ██╔══██╗██╔═══██╗██╔═══██╗██╔══██╗    ██╔════╝██║     ██║   ██║██╔══██╗"
echo "  ██║  ██║██║   ██║██║   ██║██████╔╝    ██║     ██║     ██║   ██║██████╔╝"
echo "  ██║  ██║██║   ██║██║   ██║██╔══██╗    ██║     ██║     ██║   ██║██╔══██╗"
echo "  ██████╔╝╚██████╔╝╚██████╔╝██║  ██║    ╚██████╗███████╗╚██████╔╝██████╔╝"
echo "  ╚═════╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝     ╚═════╝╚══════╝ ╚═════╝ ╚═════╝ "
echo -e "${NC}"

# Проверить .env
if [ ! -f .env ]; then
  echo -e "${RED}❌ .env не найден. Скопируй и заполни:${NC}"
  echo "   cp .env.example .env"
  exit 1
fi

# Проверить node
if ! command -v node &> /dev/null; then
  echo -e "${RED}❌ Node.js не установлен. Нужна версия 20+${NC}"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo -e "${RED}❌ Node.js слишком старый: $(node -v). Нужна v20+${NC}"
  exit 1
fi

# Проверить pnpm
if ! command -v pnpm &> /dev/null; then
  echo -e "${YELLOW}⚠ pnpm не найден. Устанавливаю...${NC}"
  npm install -g pnpm
fi

# Установить зависимости
echo -e "${GREEN}📦 Установка зависимостей...${NC}"
pnpm install

echo -e "${GREEN}🚀 Запуск серверов...${NC}"
echo ""
echo -e "  ${CYAN}Web (PWA):${NC}       http://localhost:5173"
echo -e "  ${CYAN}Game Server:${NC}     ws://localhost:2567"
echo -e "  ${CYAN}API:${NC}             http://localhost:3001"
echo ""
echo -e "  ${YELLOW}Для теста на iPhone:${NC}"
echo -e "  cloudflared tunnel --url http://localhost:5173"
echo ""
echo -e "  ${YELLOW}Остановить:${NC} Ctrl+C"
echo ""

# Запуск
pnpm dev
