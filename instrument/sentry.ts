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
 * No-op by default: with no `SENTRY_DSN` the SDK is never imported (see
 * `resolveSentryConfig`), so OSS checkouts, local dev, and tests pay nothing.
 * The chart only emits `SENTRY_*` env when `runtime.config.sentry.enabled` is
 * true, and a tenant opts out by flipping that flag — so config is per-tenant,
 * mirroring the web client.
 *
 * Coexistence with the kernel's OTel: `skipOpenTelemetrySetup: true` keeps
 * Sentry from registering its own global TracerProvider. The kernel owns the
 * global provider (`src/observability/tracing.ts`) and exports OTLP to Tempo
 * (Grafana); Sentry here is error capture only. Performance tracing
 * (`tracesSampleRate > 0`) drives Sentry's own transactions and is off by
 * default — turning it on does not disturb the Grafana trace pipeline.
 *
 * Trust boundary: `sendDefaultPii: false` plus `beforeSend: scrubEvent` keep
 * request headers/cookies, bodies, and query strings out of events. Only the
 * deployment-constant `tenant_id` (from `NB_TENANT_ID`, never a request header)
 * is stamped here; per-request `workspace_id` / opaque `user_id` are added by
 * the kernel where the verified identity is in scope.
 */
import { resolveSentryConfig, scrubEvent } from "./sentry-config.ts";

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
  });

  const tenantId = process.env.NB_TENANT_ID?.trim();
  if (tenantId) Sentry.setTag("tenant_id", tenantId);
}
