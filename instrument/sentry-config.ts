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
import type { Breadcrumb, ErrorEvent } from "@sentry/bun";

/** Resolved, validated backend Sentry settings. */
export interface ResolvedSentryConfig {
  dsn: string;
  environment: string | undefined;
  release: string | undefined;
  tracesSampleRate: number;
}

/**
 * The explicit on/off switch — mirrors the web client's `enabled` flag.
 *
 * True only when `NB_SENTRY_ENABLED` is `"true"` (case-insensitive, trimmed).
 * Enablement is NEVER inferred from DSN presence: an operator turns Sentry on
 * deliberately, and a stray/blank DSN can't silently flip it either way. Absent
 * ⇒ off — the OSS / local-dev / test default (and any tenant with the chart's
 * `runtime.config.sentry.enabled: false`), so the SDK is never even imported.
 *
 * These are `NB_SENTRY_*` (our knobs, matching the web client), NOT Sentry's
 * standard `SENTRY_*`: the preload reads and applies them explicitly, so they
 * belong in our namespace — and using them means an ambient `SENTRY_DSN` (e.g.
 * a dev's shell export for another project) can't auto-init the SDK behind us.
 */
export function sentryEnabled(env: Record<string, string | undefined>): boolean {
  return env.NB_SENTRY_ENABLED?.trim().toLowerCase() === "true";
}

/**
 * Parse and validate the Sentry settings from the environment. Returns `null`
 * only when no `NB_SENTRY_DSN` is configured — the *enable* decision is separate
 * and explicit (see {@link sentryEnabled}); this just shapes the endpoint
 * config once the operator has opted in.
 *
 * `release` is the runtime's existing build identity (`NB_VERSION`, then
 * `NB_BUILD_SHA` — the same values `/v1/health` reports), so events group by
 * deploy with no extra var. `tracesSampleRate` defaults to 0 (errors only) and
 * ignores anything outside the documented 0–1 range — performance tracing stays
 * owned by the kernel's OTLP→Tempo pipeline.
 */
export function resolveSentryConfig(
  env: Record<string, string | undefined>,
): ResolvedSentryConfig | null {
  const dsn = env.NB_SENTRY_DSN?.trim();
  if (!dsn) return null;

  const environment = env.NB_SENTRY_ENV?.trim() || undefined;
  const release = env.NB_VERSION?.trim() || env.NB_BUILD_SHA?.trim() || undefined;

  const parsed = Number(env.NB_SENTRY_TRACES_SAMPLE_RATE);
  const tracesSampleRate = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;

  return { dsn, environment, release, tracesSampleRate };
}

/**
 * Drop PII from an event before it leaves the process — mirrors the web
 * client's scrub (`web/src/sentry.ts`). Keep only the opaque `user.id` if Sentry
 * ever populates one; never request headers/cookies (auth tokens), bodies, or
 * query strings (which can carry prompts, ids, and other content). The only
 * identity tag on backend events is the boot-time `tenant_id`, set in the
 * preload — per-request workspace/user identity is not attached (the kernel
 * can't import Sentry). Mutates the event in place, per the `beforeSend`
 * contract.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    event.request.cookies = undefined;
    event.request.headers = undefined;
    event.request.data = undefined;
    event.request.query_string = undefined;
    // Also strip a query string embedded in the URL itself — an integration may
    // populate request.url as path+query, and query_string above only covers the
    // separate field. Keeps scrubEvent symmetric with scrubBreadcrumb.
    const url = event.request.url;
    if (typeof url === "string") {
      const q = url.indexOf("?");
      if (q >= 0) event.request.url = url.slice(0, q);
    }
  }
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : {};
  }
  return event;
}

/**
 * Scrub the breadcrumb trail attached to events — the other PII channel, and
 * the more dangerous one on the backend. `@sentry/bun`'s default integrations
 * (`consoleIntegration`, `httpIntegration`, `nativeNodeFetchIntegration`) turn
 * every `console.*` line and every outbound request into a breadcrumb, and the
 * runtime's outbound traffic is LLM / MCP / OAuth calls. Mirrors the web
 * client's `beforeBreadcrumb` (`web/src/sentry.ts`):
 *
 * - Drop `console`-category crumbs entirely — dependency logs (the AI SDK, MCP
 *   libs, …) aren't bound by `check:no-raw-console` and can carry prompts / PII.
 * - Strip query strings from any crumb URL — they can carry tokens, ids, and
 *   prompts. The path is left intact (endpoint, not content; within the same
 *   trust boundary as the tagged ids).
 *
 * Mutates the crumb in place when trimming the URL, per the `beforeBreadcrumb`
 * contract.
 */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category === "console") return null;
  const url = crumb.data?.url;
  if (typeof url === "string") {
    const q = url.indexOf("?");
    if (q >= 0 && crumb.data) crumb.data.url = url.slice(0, q);
  }
  return crumb;
}
