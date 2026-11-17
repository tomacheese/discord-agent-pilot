# syntax=docker/dockerfile:1

# ===== Stage 1: builder =====
FROM node:26-alpine AS builder

# Native build tools required by better-sqlite3
# hadolint ignore=DL3018
RUN apk add --no-cache python3 make g++

WORKDIR /app

RUN corepack enable && corepack prepare pnpm --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

# ===== Stage 2: prod-deps =====
FROM builder AS prod-deps
RUN pnpm prune --prod

# ===== Stage 3: runner =====
FROM node:26-alpine AS runner

ENV NODE_ENV=production

WORKDIR /app

# Install only the tmux client binary (the server/sessions are not started in the container)
# hadolint ignore=DL3018
RUN apk add --no-cache tmux

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json

CMD ["node_modules/.bin/tsx", "src/index.ts"]
