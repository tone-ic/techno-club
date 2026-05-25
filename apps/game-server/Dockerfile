FROM node:20-alpine AS builder
WORKDIR /app

# Копируем монорепо целиком (нужны shared пакеты)
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY apps/game-server ./apps/game-server

RUN npm install -g pnpm && pnpm install --frozen-lockfile
RUN pnpm --filter game-server build

FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY --from=builder /app/apps/game-server/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/game-server/package.json ./package.json

EXPOSE 2567
CMD ["node", "dist/index.js"]
