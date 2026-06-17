/**
 * Runtime client configuration.
 *
 * The web bundle is static, so it cannot read pod env from JS. Instead Caddy
 * serves `/config.js` dynamically from `NB_*` env (see web/Caddyfile), setting
 * `window.__NB_CONFIG__` before the app bundle runs. One image is therefore
 * configured per tenant via Helm env, with no per-tenant builds and no writable
 * filesystem.
 *
 * Caddy renders every value as a JSON *string* (so a malformed env value can't
 * produce a syntax error that breaks the whole file); `getConfig()` coerces
 * booleans/numbers, so a bad value degrades that one feature to "off" rather
 * than silently disabling everything.
 *
 * The committed placeholder `public/config.js` (empty object) is what `bun run
 * dev` serves locally; in a container Caddy's handler supersedes it. For local
 * dev `getConfig()` falls back to Vite env when a field is absent — in a built
 * image `window.__NB_CONFIG__` always wins because CI builds with no `VITE_*`.
 *
 * This is the single source the web client reads for Sentry, Turnstile, and
 * PostHog config. All values here are public client keys — never secrets.
 */

/** Resolved config the app reads, with booleans/numbers coerced. */
export interface NbRuntimeConfig {
  /** Deployment tenant id (from NB_TENANT_ID); the Sentry `tenant_id` tag. */
  tenantId?: string;
  /** Deployment environment label (from NB_SENTRY_ENV), e.g. "production". */
  environment?: string;
  /** Build SHA, optional. */
  release?: string;
  sentry?: {
    dsn?: string;
    enabled?: boolean;
    tracesSampleRate?: number;
  };
  turnstile?: { siteKey?: string; enabled?: boolean };
  posthog?: { key?: string; enabled?: boolean };
}

/**
 * Raw injected shape: Caddy renders every value as a JSON string, and the dev
 * placeholder may omit fields. Booleans/numbers arrive as strings and are
 * coerced by `getConfig()`.
 */
interface RawConfig {
  tenantId?: string;
  environment?: string;
  release?: string;
  sentry?: { dsn?: string; enabled?: string | boolean; tracesSampleRate?: string | number };
  turnstile?: { siteKey?: string; enabled?: string | boolean };
  posthog?: { key?: string; enabled?: string | boolean };
}

declare global {
  interface Window {
    __NB_CONFIG__?: RawConfig;
  }
}

/** Coerce a string/boolean flag; `undefined` stays undefined (dev default). */
function asBool(v: string | boolean | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === true || v === "true";
}

/** Coerce a string/number to a finite number, falling back on garbage/empty. */
function asNum(v: string | number | undefined, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolved runtime config: `window.__NB_CONFIG__` over Vite-env dev fallbacks. */
export function getConfig(): NbRuntimeConfig {
  const w: RawConfig = (typeof window !== "undefined" && window.__NB_CONFIG__) || {};
  return {
    tenantId: w.tenantId || undefined,
    environment: w.environment || import.meta.env.MODE,
    release: w.release || undefined,
    sentry: {
      dsn: w.sentry?.dsn || import.meta.env.VITE_SENTRY_DSN,
      enabled: asBool(w.sentry?.enabled),
      tracesSampleRate: asNum(
        w.sentry?.tracesSampleRate ?? import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE,
        0,
      ),
    },
    turnstile: {
      siteKey: w.turnstile?.siteKey || import.meta.env.VITE_TURNSTILE_SITE_KEY,
      enabled: asBool(w.turnstile?.enabled),
    },
    posthog: {
      key: w.posthog?.key || import.meta.env.VITE_POSTHOG_KEY,
      enabled: asBool(w.posthog?.enabled),
    },
  };
}
