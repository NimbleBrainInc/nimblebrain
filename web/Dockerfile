# check=skip=SecretsUsedInArgOrEnv
# VITE_TURNSTILE_SITE_KEY is a public client-side key, not a secret.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN npm install
COPY . .
ARG VITE_TURNSTILE_SITE_KEY=""
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY
RUN npm run build

FROM caddy:2-alpine
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
