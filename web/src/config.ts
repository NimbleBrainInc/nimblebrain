/**
 * Runtime client configuration.
 *
 * The web bundle is static, so it cannot read pod env from JS. Instead Caddy
 * serves `/config.js` dynamically from `NB_*` env (see web/Caddyfile), setting
 * `window.__NB_CONFIG__` before the app bundle runs. One image is therefore
 * configured per tenant via Helm env, with no per-tenant builds and no writable
 * filesystem.
 *
 * The committed placeholder `public/config.js` (empty object) is what `bun run
 * dev` serves locally; in a container Caddy's handler supersedes it.
 * For local-dev convenience `getConfig()` falls back to Vite env when a field is
 * absent — in a built image `window.__NB_CONFIG__` always wins because CI builds
 * with no `VITE_*` values.
 *
 * This is the single source the web client reads for Sentry, Turnstile, and
 * PostHog config. All values here are public client keys — never secrets.
 */
export interface NbRuntimeConfig {
  /** Deployment tenant id (from NB_TENANT_ID); the Sentry `tenant_id` tag. */
  tenantId?: string;
  /** Deployment environment label (from NB_SENTRY_ENV), e.g. "production". */
  environment?: string;
  /** Build SHA, optional. */
  release?: string;
  /** Platform API base URL (for distributed-trace propagation). */
  platformUrl?: string;
  sentry?: {
    dsn?: string;
    enabled?: boolean;
    tracesSampleRate?: number;
  };
  turnstile?: { siteKey?: string; enabled?: boolean };
  posthog?: { key?: string; enabled?: boolean };
}

declare global {
  interface Window {
    __NB_CONFIG__?: NbRuntimeConfig;
  }
}

/** Resolved runtime config: `window.__NB_CONFIG__` over Vite-env dev fallbacks. */
export function getConfig(): NbRuntimeConfig {
  const w = (typeof window !== "undefined" && window.__NB_CONFIG__) || {};
  return {
    tenantId: w.tenantId,
    environment: w.environment ?? import.meta.env.MODE,
    release: w.release,
    platformUrl: w.platformUrl ?? import.meta.env.VITE_API_BASE,
    sentry: {
      dsn: w.sentry?.dsn ?? import.meta.env.VITE_SENTRY_DSN,
      enabled: w.sentry?.enabled,
      tracesSampleRate:
        w.sentry?.tracesSampleRate ?? Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0),
    },
    turnstile: {
      siteKey: w.turnstile?.siteKey ?? import.meta.env.VITE_TURNSTILE_SITE_KEY,
      enabled: w.turnstile?.enabled,
    },
    posthog: {
      key: w.posthog?.key ?? import.meta.env.VITE_POSTHOG_KEY,
      enabled: w.posthog?.enabled,
    },
  };
}
