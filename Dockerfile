# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# @sorb/juice — the Sorb bridge server (CLI command: `sorb`).
#
# Multi-stage:
#   1. builder  — install ALL deps + run esbuild (`node build.mjs`) to emit dist/
#   2. runtime  — slim node:20, prod deps only, runs `node dist/cli.js`
#
# Build = esbuild via build.mjs (packages:'external'); NO tsup/webpack/typescript.
# redis/pg are OPTIONAL (added by the Tech Lead later) and only loaded at
# runtime via dynamic import when REDIS_URL / DATABASE_URL are set, so the
# image works for free local users with zero extra deps installed.
# ---------------------------------------------------------------------------

# ---- Stage 1: builder ------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

# Enable pnpm via corepack (Node 20 + pnpm per workspace rules).
RUN corepack enable

# Install dependencies first (cached layer). Copy only manifests so the deps
# layer is reused when only source changes. The pnpm-lock.yaml lives at the
# workspace root in the polyrepo, but each package builds standalone here, so
# we install from the package manifest. Use a wildcard so an absent lockfile
# doesn't break the build.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod=false --no-frozen-lockfile

# Copy the rest of the source and build with esbuild.
COPY . .
RUN node build.mjs

# Prune dev dependencies so the runtime stage copies a lean node_modules.
RUN pnpm prune --prod

# ---- Stage 2: runtime ------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
ENV PORT=7777
WORKDIR /app

# Run as the built-in unprivileged `node` user (non-root).
# Copy artifacts with that ownership.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

USER node

EXPOSE 7777

# Liveness/readiness: hit /ready, which validates any configured backends.
# Uses Node's built-in fetch (Node 20) so no extra tooling (curl/wget) needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7777)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli.js"]
