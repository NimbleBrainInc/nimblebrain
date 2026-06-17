// Runtime client configuration — LOCAL DEV placeholder (empty = everything off).
// `bun run dev` serves this file at /config.js. In a container Caddy serves
// /config.js dynamically from NB_* env instead (see web/Caddyfile), so this
// static copy is only used locally. Public client values only — never secrets.
window.__NB_CONFIG__ = {};
