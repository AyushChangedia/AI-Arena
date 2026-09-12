# ─────────────────────────────────────────────────────────────────────────────
# AI Agent Arena — container image.
#
# This is the deployment the shipped drivers were designed for. On one
# long-lived process the file-backed store and the in-process event bus are
# correct as written: /data persists across restarts, and the match engine and
# the SSE stream that watches it are guaranteed to be in the same process.
#
# Serverless splits those apart, which is why the ArenaStore and EventBus
# interfaces exist — but nothing needs them here.
# ─────────────────────────────────────────────────────────────────────────────

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Matches, agents and ratings live here. Mount a volume at /data to keep them.
ENV ARENA_DATA_DIR=/data

RUN addgroup -g 1001 -S arena && adduser -u 1001 -S arena -G arena

# The standalone bundle carries only the server and the modules it actually
# imports; static assets and the vendored fonts are copied alongside it.
COPY --from=builder --chown=arena:arena /app/.next/standalone ./
COPY --from=builder --chown=arena:arena /app/.next/static ./.next/static

RUN mkdir -p /data && chown -R arena:arena /data
VOLUME /data

USER arena
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
