/**
 * Sentry error capture for the runtime — initialized as a Bun **preload**
 * (`bunfig.toml` → `preload`), so it runs before the kernel entry regardless of
 * how the process is launched (`bun run src/cli/index.ts serve …`, the chart's
 * command override, `bun start`, tests).
 *
 * Why a preload and not `src/`:
 *   The kernel's observability is vendor-neutral OpenTelemetry — `the wire is
 *   the interface` — and `check-no-sentry-in-kernel` fails CI on any `@sentry/*`
 *   import under `src/`. Sentry is a branded SDK and additive, operator-opt-in
 *   deployment glue, so it lives here (outside `src/`), exactly as `@sentry/react`
 *   lives only in `web/`. The kernel never couples to it.
 *
 * Off by default and switched explicitly: `NB_SENTRY_ENABLED=true` is the gate
 * (mirrors the web client's `enabled` flag), never inferred from DSN presence.
 * When it's off the SDK is never imported, so OSS checkouts, local dev, and
 * tests pay nothing. The chart sets `NB_SENTRY_ENABLED` per tenant from
 * `runtime.config.sentry.enabled`, so a tenant opts in/out by that flag. Vars
 * are `NB_SENTRY_*` (our knobs, like the web client), not Sentry's auto-read
 * `SENTRY_*` — the preload is the sole, explicit control point.
 *
 * Coexistence with the kernel's OTel: `skipOpenTelemetrySetup: true` keeps
 * Sentry from registering its own global TracerProvider. The kernel owns the
 * global provider (`src/observability/tracing.ts`) and exports OTLP to Tempo
 * (Grafana); Sentry here is error capture only. Performance tracing
 * (`tracesSampleRate > 0`) drives Sentry's own transactions and is off by
 * default — turning it on does not disturb the Grafana trace pipeline.
 *
 * Trust boundary (mirrors `web/src/sentry.ts`): `sendDefaultPii: false` plus
 * `beforeSend: scrubEvent` keep request headers/cookies, bodies, and query
 * strings out of the event envelope, and `beforeBreadcrumb: scrubBreadcrumb`
 * scrubs the breadcrumb trail (drops `console` crumbs, strips URL query
 * strings) — the default integrations breadcrumb `console.*` and outbound
 * LLM/MCP/OAuth requests, which can carry prompts and tokens. Only the
 * deployment-constant `tenant_id` (from `NB_TENANT_ID`, never a request header)
 * is stamped here; per-request `workspace_id` / opaque `user_id` are added by
 * the kernel where the verified identity is in scope.
 */
import { resolveSentryConfig, scrubBreadcrumb, scrubEvent, sentryEnabled } from "./sentry-config.ts";

if (sentryEnabled(process.env)) {
  const config = resolveSentryConfig(process.env);
  if (config) {
    const Sentry = await import("@sentry/bun");
    Sentry.init({
      dsn: config.dsn,
      environment: config.environment,
      release: config.release,
      tracesSampleRate: config.tracesSampleRate,
      sendDefaultPii: false,
      skipOpenTelemetrySetup: true,
      beforeSend: scrubEvent,
      beforeBreadcrumb: scrubBreadcrumb,
    });

    const tenantId = process.env.NB_TENANT_ID?.trim();
    if (tenantId) Sentry.setTag("tenant_id", tenantId);
  } else {
    // Explicitly enabled but no endpoint — surface the misconfig rather than
    // silently staying off. (Not in src/, so the no-raw-console rule is N/A.)
    console.warn("[sentry] NB_SENTRY_ENABLED is set but NB_SENTRY_DSN is empty — error reporting is disabled.");
  }
}
