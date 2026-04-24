FROM python:3.13-slim AS base

LABEL org.opencontainers.image.title="NimbleBrain"
LABEL org.opencontainers.image.description="Self-hosted platform for MCP Apps and agent automations"
LABEL org.opencontainers.image.source="https://github.com/NimbleBrainInc/nimblebrain"
LABEL org.opencontainers.image.url="https://nimblebrain.ai"
LABEL org.opencontainers.image.vendor="NimbleBrain"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Bun runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip nodejs npm \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr bash \
    && rm -rf /var/lib/apt/lists/*

# mpak CLI — pin the version so `npm install -g` can't silently resolve to a
# broken transitive set, and so Docker's layer cache invalidates when we bump.
# Unpinned `install latest` combined with layer caching made it unclear which
# version actually landed in a built image. Bump the pin to upgrade.
RUN npm install -g @nimblebrain/mpak@0.4.1

# Non-root user (UID 1000 matches K8s securityContext)
RUN useradd -m -u 1000 nimblebrain
RUN mkdir -p /data && chown nimblebrain:nimblebrain /data

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY src/ src/

# Build bundle UIs (dist/ is gitignored, must build in container)
RUN for ui in src/bundles/*/ui; do \
      [ -f "$ui/package.json" ] && (cd "$ui" && bun install && bun run build && rm -rf node_modules); \
    done

RUN chown -R nimblebrain:nimblebrain /app

USER 1000

VOLUME /data

ARG BUILD_SHA=""
ENV NB_BUILD_SHA=$BUILD_SHA
ARG VERSION=""
ENV NB_VERSION=$VERSION
ENV NB_WORK_DIR=/data
ENV NB_HOST=0.0.0.0

EXPOSE 27247

HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -f http://localhost:27247/v1/health || exit 1

CMD ["bun", "run", "src/cli/index.ts", "serve"]
