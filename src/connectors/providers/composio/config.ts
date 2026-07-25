/**
 * Composio provider configuration — the resolution of the declared
 * `connectors.providers.composio` block against the legacy `COMPOSIO_*` env.
 *
 * Synchronous and vendor-free by construction: nothing here touches
 * `@composio/core`, so the registry can decide whether Composio is configured
 * (and therefore whether to register a provider at all) without linking the
 * vendor. `sdk.ts` is the vendor adapter; this is its config.
 *
 * Two layers, split on what the value *is*:
 *
 *   - **Settings** (`baseUrl`, `monitorEnabled`) are declarable, and each falls
 *     back on its own: a field declared in the block wins, a field left out
 *     reads its `COMPOSIO_*` var. Nothing is ever silently discarded, so an
 *     upgrade from the env-sniffing era breaks nothing and a block added for one
 *     setting can't disturb another. Same shape as `providers.*.apiKey` falling
 *     back to `ANTHROPIC_API_KEY` elsewhere in this schema.
 *   - **The broker credential** comes from `COMPOSIO_API_KEY` only. It is NOT a
 *     declarable field.
 *
 * Why the credential is env-only *today*: a connector installed through Composio
 * persists its transport credential as the secret reference `${COMPOSIO_API_KEY}`
 * in `workspace.json`, resolved from the process env at transport-build time.
 * That is a durable reference into the environment namespace, so a credential
 * declared anywhere else would leave installed connectors authenticating with an
 * empty header. The fix is to persist a *credential provider* name instead of an
 * env reference (`TransportCredentialProvider`, the kernel's generic seam — see
 * `src/tools/credential-provider.ts`), at which point resolution becomes this
 * module's private business and the credential can join the declared block. Until
 * then the credential stays where persisted state already points.
 *
 * Validation is applied to the *resolved* values regardless of source:
 *
 *   - `baseUrl` must parse as http(s) (a non-http scheme would turn
 *     `/v1/composio-auth/proxy` into an open redirect)
 *   - bouncer (multi-tenant) mode requires `NB_TENANT_ID`, or two tenants with
 *     the same `wsId` would share one Composio `user_id` namespace
 *
 * Both throw at startup so a misconfigured deploy fails at deploy time rather
 * than on the first user click.
 */

import { getBouncerMode } from "../../../oauth/bouncer-config.ts";
import { log } from "../../../observability/log.ts";
import { declaredProviderConfig } from "../config.ts";

/** Default Composio API host. Overridable via config `baseUrl` or `COMPOSIO_API_BASE_URL`. */
export const COMPOSIO_API_BASE = "https://backend.composio.dev";

/** Resolved Composio provider config. Every consumer of a `COMPOSIO_*` value reads it from here. */
export interface ComposioConfig {
  /** Whether the broker credential resolved — the gate on registering the provider at all. */
  configured: boolean;
  /** The platform-wide broker credential, from `COMPOSIO_API_KEY`. Empty when unconfigured. */
  apiKey: string;
  /** Validated http(s) API base. */
  baseUrl: string;
  /** Run the connection-revalidator probe. False whenever unconfigured. */
  monitorEnabled: boolean;
}

let _cached: ComposioConfig | undefined;

/**
 * The resolved Composio config. Computed once and cached — production reads it on
 * every SDK call.
 *
 * The cache is **install-once**: `setConnectorsConfig` does not invalidate it, so
 * a second install in one process is not observed. That matches the composition-
 * root contract (one install in `Runtime.start`, ahead of every reader) and is
 * why a test that installs a block pairs it with `_resetComposioConfigForTest()`.
 *
 * The name reflects first-call semantics: the first call runs full validation
 * and logs the operator-facing status line; every later call is a cache hit.
 */
export function validateComposioConfig(): ComposioConfig {
  if (!_cached) _cached = resolveComposioConfig();
  return _cached;
}

function resolveComposioConfig(): ComposioConfig {
  const declared = declaredProviderConfig("composio");

  const apiKey = process.env.COMPOSIO_API_KEY?.trim() ?? "";
  if (!apiKey) {
    log.info("[composio] integration: not configured (set COMPOSIO_API_KEY to enable)");
    return { configured: false, apiKey: "", baseUrl: COMPOSIO_API_BASE, monitorEnabled: false };
  }

  const baseUrl = resolveBaseUrl(declared?.baseUrl);
  const tid = requireTenantIdInBouncerMode();

  log.info(`[composio] integration: configured (base=${baseUrl}${tid ? `, tid=${tid}` : ""})`);

  return {
    configured: true,
    apiKey,
    baseUrl,
    monitorEnabled: declared?.monitorEnabled ?? monitorEnabledFromEnv(),
  };
}

/** Resolve + validate the API base: the declared value, else the env, else the default. */
function resolveBaseUrl(declared: string | undefined): string {
  const raw = (declared ?? process.env.COMPOSIO_API_BASE_URL)?.trim();
  if (!raw) return COMPOSIO_API_BASE;

  const label = declared ? "connectors.providers.composio.baseUrl" : "COMPOSIO_API_BASE_URL";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`[composio] ${label} is not a valid URL: "${raw}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `[composio] ${label} must be http(s): "${raw}". ` +
        "Other schemes would expose `/v1/composio-auth/proxy` as an open redirect.",
    );
  }
  return raw;
}

/**
 * Multi-tenant safety: the Composio `user_id` formula prefixes `NB_TENANT_ID`
 * when set. An active bouncer config is the reliable signal of a multi-tenant
 * deploy, where a missing prefix would collapse every tenant into one Composio
 * namespace. The tenant id is a deployment identity, not provider config — it
 * stays env-only.
 */
function requireTenantIdInBouncerMode(): string | undefined {
  const tid = process.env.NB_TENANT_ID?.trim();
  if (getBouncerMode() && !tid) {
    throw new Error(
      "[composio] NB_TENANT_ID is required when running in bouncer (multi-tenant) mode. " +
        "Without a tenant prefix, Composio `user_id` collisions could leak connected " +
        "accounts across tenants. Set NB_TENANT_ID via the deployment env to a stable " +
        "per-pod tenant identifier.",
    );
  }
  return tid;
}

/**
 * The env fallback for the probe's kill switch. Default ON — only an explicit
 * `false` (case/whitespace-insensitive) disables, so an unset or malformed value
 * fails safe to enabled. Read only when the block leaves `monitorEnabled` out.
 */
function monitorEnabledFromEnv(): boolean {
  return (process.env.COMPOSIO_MONITOR_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

/**
 * Test-only. Drop the cached resolution so the next call re-reads config + env.
 *
 * Production reads config once at startup and never re-reads — operators restart
 * the platform after changing `nimblebrain.json` or the `COMPOSIO_*` env.
 * Mirrors the bouncer-config caching contract.
 */
export function _resetComposioConfigForTest(): void {
  _cached = undefined;
}
