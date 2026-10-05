# syntax=docker/dockerfile:1
# The pinned frontend provides `COPY --parents`, used below for the UI build layer.
FROM python:3.13-slim@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS base

LABEL org.opencontainers.image.title="NimbleBrain"
LABEL org.opencontainers.image.description="Self-hosted platform for MCP Apps and agent tasks"
LABEL org.opencontainers.image.source="https://github.com/NimbleBrainInc/nimblebrain"
LABEL org.opencontainers.image.url="https://nimblebrain.ai"
LABEL org.opencontainers.image.vendor="NimbleBrain"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Bun runtime, plus the toolchain the in-image platform app UIs build with.
# `git` and `curl` are used by the install steps below and by the health check.
# Exact versions, so a rebuild pulls the toolchain CI tested rather than whatever is
# newest. BUN_VERSION must equal ci.yml's (test/unit/build-pins.test.ts checks it);
# Renovate bumps every copy together.
# renovate: datasource=github-releases depName=oven-sh/bun extractVersion=^bun-v(?<version>.+)$
ARG BUN_VERSION=1.4.2
# renovate: datasource=node-version depName=node
ARG NODE_VERSION=24.21.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip git ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends "nodejs=${NODE_VERSION}-1nodesource1" \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr bash -s "bun-v${BUN_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

# Non-root user (UID 1000 matches K8s securityContext)
RUN useradd -m -u 1000 nimblebrain
RUN mkdir -p /data && chown nimblebrain:nimblebrain /data

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# Build every platform app UI (`src/platform/*/ui`) — each is its own
# single-file Vite app and must build in the container because dist/ is
# gitignored. Only the UI directories are copied for this step, ahead of the
# rest of src/: each UI builds from its own directory alone, so a change
# elsewhere in src/ reuses this layer instead of reinstalling and rebuilding
# every UI. `--parents` keeps each matched directory at its path. UI deps are
# installed fresh here and removed after build; the source tree's nested
# node_modules are excluded by .dockerignore (**/node_modules) so they never
# enter the build context.
#
# Built in parallel (each app does its own install + build) rather than
# serially — they're independent. PIDs are collected and waited on individually
# so any single app's failure fails the whole RUN (a bare `wait` would mask
# a nonzero exit). Each subshell tags its own failure with the app's UI path so
# the culprit is greppable even though parallel output is interleaved.
COPY --chown=1000:1000 --parents src/platform/*/ui/ ./
RUN set -e; \
    pids=""; \
    for ui in src/platform/*/ui; do \
      [ -f "$ui/package.json" ] || continue; \
      ( cd "$ui" && bun install --frozen-lockfile && bun run build && rm -rf node_modules \
        || { echo "ERROR: platform app UI build failed: $ui" >&2; exit 1; } ) & \
      pids="$pids $!"; \
    done; \
    for p in $pids; do wait "$p"; done

COPY --chown=1000:1000 src/ src/
COPY --chown=1000:1000 scripts/ scripts/
# Out-of-kernel Sentry preload + its bunfig wiring. bunfig.toml must sit at the
# WORKDIR (the runtime's cwd) so Bun applies `preload` to `bun run src/cli/...`.
# Inert unless NB_SENTRY_ENABLED=true; the kernel under src/ stays Sentry-free.
COPY --chown=1000:1000 bunfig.toml ./
COPY --chown=1000:1000 instrument/ instrument/

USER 1000

VOLUME /data

# NB_BUILD_SHA is BAKED — a genuine build fact (which commit produced these
# bytes), and correct even after the image is promoted-by-retag to a release tag.
# NB_VERSION is deliberately NOT baked: it's injected at deploy time via the
# NB_VERSION env, so the same image can be retagged :<sha> -> :vX.Y.Z and shipped
# byte-for-byte with no rebuild (see release.yml). When NB_VERSION is unset (local
# `docker run` / compose) the runtime falls back to package.json.
ARG BUILD_SHA=""
ENV NB_BUILD_SHA=$BUILD_SHA
ENV NB_WORK_DIR=/data
ENV NB_HOST=0.0.0.0

EXPOSE 27247

HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -f http://localhost:27247/v1/health || exit 1

CMD ["bun", "run", "src/cli/index.ts", "serve"]
