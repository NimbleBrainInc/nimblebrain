import * as Sentry from "@sentry/react";
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

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const cfg = getConfig();
  const s = cfg.sentry;
  // Off unless a DSN is present and not explicitly disabled.
  if (!s?.dsn || s.enabled === false) return;
  initialized = true;

  Sentry.init({
    dsn: s.dsn,
    environment: cfg.environment,
    release: cfg.release,
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration()],
    // No Session Replay: replayIntegration records the DOM (prompts, tool
    // results, file contents) — the exact content the trust rule forbids. Same
    // intent as telemetry.ts disabling PostHog session recording.
    tracesSampleRate: s.tracesSampleRate ?? 0,
    // Extend the trace into the platform's OTel layer over W3C traceparent.
    tracePropagationTargets: [cfg.platformUrl || /^\//],
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
  if (cfg.tenantId) Sentry.setTag("tenant_id", cfg.tenantId);
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
  // A workspace or conversation id must not ride along in a fetch/xhr/nav URL.
  const url = crumb.data?.url;
  if (typeof url === "string") {
    const q = url.indexOf("?");
    if (q >= 0 && crumb.data) crumb.data.url = url.slice(0, q);
  }
  return crumb;
}

/** Set the per-session opaque user id (never email/displayName). */
export function setSentryUser(userId: string | null | undefined): void {
  if (!initialized) return;
  Sentry.setUser(userId ? { id: userId } : null);
}

/** Keep the `workspace_id` tag in sync with the focused workspace. */
export function setSentryWorkspace(workspaceId: string | null | undefined): void {
  if (!initialized) return;
  Sentry.setTag("workspace_id", workspaceId ?? undefined);
}

/** Clear per-session identity on logout (tenant_id stays — it's deployment-wide). */
export function clearSentryContext(): void {
  if (!initialized) return;
  Sentry.setUser(null);
  Sentry.setTag("workspace_id", undefined);
}

/** Record a refresh-outcome breadcrumb (see fetch-with-refresh.ts). */
export function addAuthBreadcrumb(message: string): void {
  if (!initialized) return;
  Sentry.addBreadcrumb({ category: "auth", message, level: "info" });
}

/**
 * Emit one event at the terminal involuntary logout, carrying the preceding
 * auth breadcrumb trail — turns a "random logout" into a reconstructable
 * sequence. Not called on manual user logout.
 */
export function captureLogout(reason: string): void {
  if (!initialized) return;
  Sentry.captureMessage(`involuntary logout: ${reason}`, "warning");
}
