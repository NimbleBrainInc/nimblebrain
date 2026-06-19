/**
 * Pure, side-effect-free helpers for the runtime's Sentry preload
 * (`instrument/sentry.ts`). Kept separate so the enable decision and the PII
 * scrub can be unit-tested without importing the SDK or running the preload.
 *
 * This module lives OUTSIDE `src/` on purpose: the kernel is vendor-neutral
 * OpenTelemetry and `check-no-sentry-in-kernel` forbids any `@sentry/*` import
 * under `src/`. Sentry is additive, opt-in deployment glue (mirrors how
 * `@sentry/react` lives only in `web/`). See `instrument/sentry.ts`.
 */
import type { ErrorEvent } from "@sentry/bun";

/** Resolved, validated backend Sentry settings. */
export interface ResolvedSentryConfig {
  dsn: string;
  environment: string | undefined;
  release: string | undefined;
  tracesSampleRate: number;
}

/**
 * Decide whether (and how) to start Sentry from the process environment.
 *
 * Returns `null` — a silent no-op — unless `SENTRY_DSN` is set. That is the
 * OSS / local-dev / test default and every tenant with Sentry disabled: the
 * chart only emits `SENTRY_*` env when `runtime.config.sentry.enabled` is true,
 * so an absent DSN is the off switch and the SDK is never even imported.
 *
 * `release` falls back to the image's build identity (`NB_VERSION`, then
 * `NB_BUILD_SHA`) so events group by deploy without extra config.
 * `tracesSampleRate` defaults to 0 (errors only) and ignores invalid/negative
 * input — performance tracing stays owned by the kernel's OTLP→Tempo pipeline.
 */
export function resolveSentryConfig(
  env: Record<string, string | undefined>,
): ResolvedSentryConfig | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;

  const environment = env.SENTRY_ENVIRONMENT?.trim() || undefined;
  const release =
    env.SENTRY_RELEASE?.trim() || env.NB_VERSION?.trim() || env.NB_BUILD_SHA?.trim() || undefined;

  const parsed = Number(env.SENTRY_TRACES_SAMPLE_RATE);
  const tracesSampleRate = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;

  return { dsn, environment, release, tracesSampleRate };
}

/**
 * Drop PII from an event before it leaves the process. Mirrors the web client's
 * trust boundary (`web/src/sentry.ts`) and the kernel's OTel rule: we keep only
 * the opaque `user.id` and stamp `tenant_id` / `workspace_id` as tags
 * elsewhere — never request headers/cookies (auth tokens), request bodies, or
 * query strings (which can carry prompts, ids, and other content).
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    event.request.cookies = undefined;
    event.request.headers = undefined;
    event.request.data = undefined;
    event.request.query_string = undefined;
  }
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : {};
  }
  return event;
}
