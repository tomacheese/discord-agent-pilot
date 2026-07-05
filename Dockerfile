# syntax=docker/dockerfile:1

# ===== Stage 1: builder =====
FROM node:24-alpine AS builder

# better-sqlite3 のネイティブビルドに必要なツール
# hadolint ignore=DL3018
RUN apk add --no-cache python3 make g++ tmux

WORKDIR /app

RUN corepack enable && corepack prepare pnpm --activate

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

# ===== Stage 2: prod-deps =====
FROM builder AS prod-deps
RUN pnpm prune --prod

# ===== Stage 3: runner =====
FROM node:24-alpine AS runner

ENV NODE_ENV=production

WORKDIR /app

# tmux クライアントバイナリのみをインストールする(サーバー/セッションはコンテナ内で起動しない)
# hadolint ignore=DL3018
RUN apk add --no-cache tmux

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json

CMD ["node_modules/.bin/tsx", "src/index.ts"]
