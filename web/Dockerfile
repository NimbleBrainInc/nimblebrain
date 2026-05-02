# check=skip=SecretsUsedInArgOrEnv
# VITE_TURNSTILE_SITE_KEY is a public client-side key, not a secret.
#
# Build context: REPO ROOT (not web/). The web tsconfig path alias
# `@platform/schemas/*` resolves to `../src/tools/platform/schemas/*`,
# which is outside web/ but inside the repo. The build needs both the
# web/ tree AND the parent schemas tree, so the context spans both.
# Per-Dockerfile dockerignore at `web/Dockerfile.dockerignore` (BuildKit
# auto-detects it) controls what crosses the wire from the wider context.
#
# Invocation:
#   docker build -f web/Dockerfile .                 (from repo root)
#   docker build -f products/.../code/web/Dockerfile products/.../code   (from elsewhere)
FROM oven/bun:1-alpine AS build

# Server deps installed at /app — provides `@sinclair/typebox` (and any
# other shared runtime dep the cross-tree schema modules import) at
# `/app/node_modules`. Node module resolution from
# `/app/src/tools/platform/schemas/*.ts` walks up and finds them, the
# same way it does in local dev. This mirrors the server image's setup;
# no per-package copying or hoisting hacks.
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# Web's own deps under /app/web (separate package.json). devDeps included
# — Vite + TypeScript + @types/* are dev-only but required for the build.
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY web/ ./
# Cross-tree schemas — placed where the tsconfig path alias
# `@platform/schemas/*` (= `../src/tools/platform/schemas/*`) expects.
COPY src/tools/platform/schemas/ /app/src/tools/platform/schemas/

ARG VITE_TURNSTILE_SITE_KEY=""
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY
RUN bun run build

FROM caddy:2-alpine

LABEL org.opencontainers.image.title="NimbleBrain Web"
LABEL org.opencontainers.image.description="Web UI for the NimbleBrain self-hosted platform (Caddy + React SPA)"
LABEL org.opencontainers.image.source="https://github.com/NimbleBrainInc/nimblebrain"
LABEL org.opencontainers.image.url="https://nimblebrain.ai"
LABEL org.opencontainers.image.vendor="NimbleBrain"
LABEL org.opencontainers.image.licenses="Apache-2.0"

COPY --from=build /app/web/dist /srv
COPY web/Caddyfile /etc/caddy/Caddyfile

# Strip file capabilities so Caddy runs under PSS restricted (drop: ALL).
# We only bind port 8080, so cap_net_bind_service is not needed.
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy && apk del libcap

# Caddy needs writable dirs for runtime state.
# In K8s these are emptyDir mounts; in Docker we pre-create them.
RUN mkdir -p /data /config && chown 1000:1000 /data /config /srv

# Run as non-root (UID 1000 matches K8s securityContext)
USER 1000

EXPOSE 8080
