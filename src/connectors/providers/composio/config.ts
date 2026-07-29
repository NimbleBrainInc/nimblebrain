/**
 * Composio provider configuration — the resolution of the declared
 * `connectors.providers.composio` block against the legacy `COMPOSIO_*` env.
 *
 * Synchronous and vendor-free by construction: nothing here touches
 * `@composio/core`, so the registry can decide whether Composio is configured
 * (and therefore whether to register a provider at all) without linking the
 * vendor. `sdk.ts` is the vendor adapter; this is its config.
 *
 * Every field — the broker credential included — is declarable, and each falls
 * back on its own: a field declared in the block wins, a field left out (or left
 * blank) reads its `COMPOSIO_*` var. Nothing is ever silently discarded, so an
 * upgrade from the env-sniffing era breaks nothing and a block added for one
 * setting can't disturb another. Same shape as `providers.*.apiKey` falling back
 * to `ANTHROPIC_API_KEY` elsewhere in this schema.
 *
 * The credential is declarable because nothing persisted points at where it
 * lives: an installed connector's transport names the `composio` credential
 * provider (`transport-credential.ts`), so resolution is this module's private
 * business. Refs written before that seam carry a `${COMPOSIO_API_KEY}` env
 * reference and are mapped forward on read.
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
  /**
   * The platform-wide broker credential — declared or from the env. Empty when
   * Composio is unconfigured — its presence IS the gate on registering the
   * provider, so there is no separate `configured` flag to drift from it.
   */
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

  const apiKey = declared?.apiKey?.trim() || (process.env.COMPOSIO_API_KEY?.trim() ?? "");
  if (!apiKey) {
    log.info(
      "[composio] integration: not configured (set connectors.providers.composio.apiKey " +
        "or COMPOSIO_API_KEY to enable)",
    );
    return { apiKey: "", baseUrl: COMPOSIO_API_BASE, monitorEnabled: false };
  }

  const baseUrl = resolveBaseUrl(declared?.baseUrl);
  const tid = requireTenantIdInBouncerMode();

  log.info(`[composio] integration: configured (base=${baseUrl}${tid ? `, tid=${tid}` : ""})`);

  return {
    apiKey,
    baseUrl,
    monitorEnabled: declared?.monitorEnabled ?? monitorEnabledFromEnv(),
  };
}

/**
 * Resolve + validate the API base: the declared value, else the env, else the default.
 *
 * A blank declared value counts as *absent*, so the env fallback still applies. A
 * templated deploy renders `"baseUrl": "{{ .Values… }}"` to `""` when the value is
 * unset, and treating that as a declaration would discard the operator's
 * `COMPOSIO_API_BASE_URL` and silently point a self-hosted platform at the public
 * backend — the exact loss per-field precedence exists to prevent.
 */
function resolveBaseUrl(declaredRaw: string | undefined): string {
  const declared = declaredRaw?.trim() || undefined;
  const raw = declared ?? process.env.COMPOSIO_API_BASE_URL?.trim();
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

/**
 * The auth-config id for one toolkit, or `""` when it has none.
 *
 * Reads the declared block directly rather than routing through
 * `validateComposioConfig`, whose unconfigured early-return would zero this
 * lookup — reporting a missing auth config for what is really a missing API key.
 * Callers gate on the credential separately and say so in their own words.
 */
export function composioAuthConfigId(toolkit: string): string {
  return declaredProviderConfig("composio")?.authConfigs?.[toolkit]?.trim() ?? "";
}
