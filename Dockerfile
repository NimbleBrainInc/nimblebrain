FROM python:3.13-slim AS base

# Bun runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip nodejs npm \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr bash \
    && rm -rf /var/lib/apt/lists/*

# mpak CLI
RUN npm install -g @nimblebrain/mpak

# Non-root user (UID 1000 matches K8s securityContext)
RUN useradd -m -u 1000 nimblebrain
RUN mkdir -p /data && chown nimblebrain:nimblebrain /data

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY src/ src/
RUN chown -R nimblebrain:nimblebrain /app

USER 1000

VOLUME /data

ARG BUILD_SHA=""
ENV NB_BUILD_SHA=$BUILD_SHA
ENV NB_WORK_DIR=/data
ENV NB_HOST=0.0.0.0

EXPOSE 27247

HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -f http://localhost:27247/v1/health || exit 1

CMD ["bun", "run", "src/cli/index.ts", "serve"]
