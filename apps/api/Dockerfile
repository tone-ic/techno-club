FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN npm install -g pnpm && pnpm install --frozen-lockfile
RUN pnpm --filter api build

FROM node:20-alpine AS runner
WORKDIR /app

COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json ./package.json

EXPOSE 3001
CMD ["node", "dist/index.js"]
