import type * as Sentry from "@sentry/react";
import { getConfig } from "./config";

/**
 * Sentry client-error tracking for the web app.
 *
 * Configured at runtime from `window.__NB_CONFIG__` (see config.ts), so a tenant
 * can be turned on/off and given a monitoring profile via Helm without a rebuild.
 * No-op when disabled or unconfigured — the OSS/local default and any tenant with
 * Sentry off get a silent client with zero network calls (mirrors telemetry.ts).
 *
 * Trust boundary — mirrors the server OTel rule: we stamp only `tenant_id`,
 * `workspace_id`, and an opaque `user.id`, and never send PII or client content
 * (email, display name, prompts, tool args/results, file contents). Enforced by
 * `sendDefaultPii: false` plus the `beforeSend` / `beforeBreadcrumb` scrubs.
 */

// The Sentry SDK, supplied by the browser entry point (main.tsx → initSentry).
// This module is imported by api/client.ts, and the shared bridge protocol imports
// api/client, so it is reachable from non-browser consumers (the root unit suite
// exercises the bridge). Keeping @sentry/react a type-only import here — the value
// arrives by injection — means the browser SDK loads only where it runs, mirroring
// the server's out-of-kernel seam (instrument/sentry.ts). `sdk` is null until
// initialized, and stays null on every backend/test import, where each helper below
// no-ops. A truthy `sdk` is the "Sentry is live" signal.
let sdk: typeof import("@sentry/react") | null = null;
// One Sentry event per involuntary-logout *incident*, not per concurrent 401.
// The app fires parallel /v1 requests; a real logout resolves the single-flighted
// refresh as rejected for all of them, so each awaiting caller would otherwise
// call captureLogout. This guard makes singularity explicit rather than relying
// on Sentry's Dedupe integration. Reset on re-auth (setSentryUser).
let loggedOutCaptured = false;

/**
 * Test seam for the once-per-incident logout guard: returns `true` the first
 * time and `false` until {@link resetLogoutGuard} re-arms it. Exported so the
 * singularity can be unit-tested without initializing Sentry.
 */
export function consumeLogoutOnce(): boolean {
  if (loggedOutCaptured) return false;
  loggedOutCaptured = true;
  return true;
}

/** Re-arm the logout guard (called on re-auth). Exported for tests. */
export function resetLogoutGuard(): void {
  loggedOutCaptured = false;
}

export function initSentry(sentry: typeof import("@sentry/react")): void {
  if (sdk) return;
  const cfg = getConfig();
  const s = cfg.sentry;
  // Off unless a DSN is present and not explicitly disabled.
  if (!s?.dsn || s.enabled === false) return;
  sdk = sentry;

  sentry.init({
    dsn: s.dsn,
    environment: cfg.environment,
    release: cfg.release,
    sendDefaultPii: false,
    // Performance tracing only when a tenant opts in (sample rate > 0) — avoids
    // instrumenting fetch and appending sentry-trace/baggage headers for nothing.
    // No Session Replay either: replayIntegration records the DOM (prompts, tool
    // results, file contents) — the content the trust rule forbids (cf.
    // telemetry.ts disabling PostHog session recording).
    integrations: (s.tracesSampleRate ?? 0) > 0 ? [sentry.browserTracingIntegration()] : [],
    tracesSampleRate: s.tracesSampleRate ?? 0,
    // tracePropagationTargets is left at the SDK default (same-origin), which is
    // exactly our case — all API calls are same-origin /v1/* proxied to the
    // platform. Note browserTracingIntegration propagates Sentry's own
    // sentry-trace + baggage headers (not W3C traceparent), so this does not
    // auto-link into the kernel's OTLP traces; the platform ignores the headers.
    beforeSend,
    beforeBreadcrumb,
    // Strip query strings from transaction names so workspace/conversation ids
    // don't become span names. Inlined for the SDK's contextual typing.
    beforeSendTransaction: (event) => {
      if (event.transaction) {
        const q = event.transaction.indexOf("?");
        if (q >= 0) event.transaction = event.transaction.slice(0, q);
      }
      return event;
    },
  });

  // tenant_id is a deployment constant (NB_TENANT_ID via runtime config) — stamp
  // it once. workspace_id and user are per-session (set via the helpers below).
  if (cfg.tenantId) sentry.setTag("tenant_id", cfg.tenantId);
}

/** Drop PII from the event envelope before it leaves the browser. Exported for tests. */
export function beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.request) {
    event.request.cookies = undefined;
    event.request.headers = undefined;
  }
  // Keep only the opaque id; never email / username / ip.
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : {};
  }
  return event;
}

/** Drop leak-prone default breadcrumbs (console output, URL query strings). Exported for tests. */
export function beforeBreadcrumb(crumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  // App logs can carry prompts / PII — never breadcrumb them.
  if (crumb.category === "console") return null;
  // Strip query strings from fetch/xhr/nav URLs. (Opaque ids in the URL *path*
  // — e.g. /w/<wsId> — are within the trust boundary: they're tagged anyway and
  // aren't the content the rule forbids, so we don't rewrite path segments.)
  const url = crumb.data?.url;
  if (typeof url === "string") {
    const q = url.indexOf("?");
    if (q >= 0 && crumb.data) crumb.data.url = url.slice(0, q);
  }
  return crumb;
}

/** Set the per-session opaque user id (never email/displayName). */
export function setSentryUser(userId: string | null | undefined): void {
  if (!sdk) return;
  // A new authenticated session starts a fresh logout incident.
  if (userId) resetLogoutGuard();
  sdk.setUser(userId ? { id: userId } : null);
}

/** Keep the `workspace_id` tag in sync with the focused workspace. */
export function setSentryWorkspace(workspaceId: string | null | undefined): void {
  if (!sdk) return;
  sdk.setTag("workspace_id", workspaceId ?? undefined);
}

/** Clear per-session identity on logout (tenant_id stays — it's deployment-wide). */
export function clearSentryContext(): void {
  if (!sdk) return;
  sdk.setUser(null);
  sdk.setTag("workspace_id", undefined);
}

/** Record a refresh-outcome breadcrumb (see fetch-with-refresh.ts). */
export function addAuthBreadcrumb(message: string): void {
  if (!sdk) return;
  sdk.addBreadcrumb({ category: "auth", message, level: "info" });
}

/**
 * Which involuntary-logout reasons warrant a captured Sentry event.
 *
 * `refresh_rejected` is the EXPECTED end-of-session signal: the refresh endpoint
 * gave a definitive 401 because the refresh token was absent, expired, or
 * revoked — i.e. every returning user whose session lapsed, every environment
 * reopened after a while. It is not an error condition; capturing it per
 * incident buries the project in normal re-logins (and pages on every routine
 * deploy of an env that was left open). It stays a breadcrumb — emitted by the
 * refresh-outcome hook (`refresh:rejected`) — so it still decorates the trail of
 * a *real* error that fires later.
 *
 * `retry_401` is the genuine anomaly worth an event: the refresh SUCCEEDED, we
 * minted a fresh access token, and the very next request rejected it anyway —
 * "a token we just issued is already invalid", which points at an actual bug.
 *
 * Exported as a test seam (cf. consumeLogoutOnce) so the policy is unit-testable
 * without initializing the Sentry client.
 */
export function isReportableLogout(reason: string): boolean {
  return reason !== "refresh_rejected";
}

/**
 * Emit ONE event per *reportable* involuntary-logout incident (see
 * {@link isReportableLogout}), carrying the preceding auth breadcrumb trail —
 * turns a "random logout" into a reconstructable sequence. Idempotent across the
 * concurrent 401s that resolve one rejected refresh; reset by setSentryUser on
 * re-auth. Not called on manual user logout. The once-guard is consumed ONLY on
 * the reportable path, so a suppressed `refresh_rejected` never disarms a later
 * genuine `retry_401` in the same session.
 */
export function captureLogout(reason: string): void {
  if (!sdk || !isReportableLogout(reason) || !consumeLogoutOnce()) return;
  sdk.captureMessage(`involuntary logout: ${reason}`, "warning");
}
