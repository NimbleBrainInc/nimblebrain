# Install with bun against the frozen bun.lock — NOT `npm install`. npm cannot
# read bun.lock, so it re-resolves every dependency to the newest in-range
# version on each build, leaving us exposed to upstream publish races (e.g. a
# transitive dep pinned to a version not yet live on the registry). Bun honors
# the lockfile and builds deterministically, matching the platform Dockerfile.
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# No build-time client keys. Sentry / PostHog config is served at runtime from
# NB_* env by Caddy (see /config.js in the Caddyfile) so one image works across
# every tenant and environment. The bundle ships clean.
RUN bun run build

FROM caddy:2-alpine

LABEL org.opencontainers.image.title="NimbleBrain Web"
LABEL org.opencontainers.image.description="Web UI for the NimbleBrain self-hosted platform (Caddy + React SPA)"
LABEL org.opencontainers.image.source="https://github.com/NimbleBrainInc/nimblebrain"
LABEL org.opencontainers.image.url="https://nimblebrain.ai"
LABEL org.opencontainers.image.vendor="NimbleBrain"
LABEL org.opencontainers.image.licenses="Apache-2.0"

COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile

# Strip file capabilities so Caddy runs under PSS restricted (drop: ALL).
# We only bind port 8080, so cap_net_bind_service is not needed.
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy && apk del libcap

# Caddy needs writable dirs for runtime state.
# In K8s these are emptyDir mounts; in Docker we pre-create them.
RUN mkdir -p /data /config && chown 1000:1000 /data /config /srv

# Run as non-root (UID 1000 matches K8s securityContext)
USER 1000

EXPOSE 8080
