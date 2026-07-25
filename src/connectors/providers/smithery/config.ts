/**
 * Smithery provider configuration — the resolution of the declared
 * `connectors.providers.smithery` block against the legacy `SMITHERY_*` env.
 *
 * Same two-layer split as Composio's, on the same rule — what the value *is*,
 * not which vendor owns it:
 *
 *   - **Settings** (`namespace`, `baseUrl`, `monitorEnabled`) are declarable and
 *     each falls back on its own, so an upgrade from the env-only era breaks
 *     nothing and declaring one setting can't disturb another.
 *   - **The broker credential** is declarable too, because persisted state names
 *     the `smithery` credential provider rather than an env var — so where the
 *     value lives is this module's private business. See
 *     `transport-credential.ts` for the invariant that makes that true.
 *
 * `namespace` is a *setting*, not a credential — it names which Smithery
 * namespace connections live in, and nothing persisted references it by env
 * name (the install records the namespace on the ref itself). So it is
 * declarable, unlike the API key.
 *
 * **No tenant-id guard here, deliberately.** `smitheryUserId` uses the same
 * `${NB_TENANT_ID}:${wsId}` formula as Composio's, and a collision would be
 * worse — two tenants would share one brokered connection and the grant behind
 * it. But the invariant is already enforced upstream: `getBouncerMode()` throws
 * when bouncer (multi-tenant) mode is on without `NB_TENANT_ID`, which is what
 * makes Composio's own duplicate guard unreachable. A second copy would be dead
 * code asserting a condition that cannot occur.
 *
 * The provider is registered only when BOTH the credential and a namespace
 * resolve. A namespace is globally unique and account-owned at Smithery, so
 * there is no safe default to invent; half-configured must mean *off*, not
 * "guess". Vendor-free and synchronous by construction — the registry decides
 * whether to register without loading the Connect client.
 */

import { log } from "../../../observability/log.ts";
import { declaredProviderConfig } from "../config.ts";

/** Default Smithery Connect API host. Overridable via config `baseUrl` or `SMITHERY_API_BASE_URL`. */
export const SMITHERY_API_BASE = "https://api.smithery.ai";

/** Max time a single Smithery Connect API call may run before we abort. */
export const SMITHERY_TIMEOUT_MS = 10_000;

/** Resolved Smithery provider config. Every consumer of a `SMITHERY_*` value reads it from here. */
export interface SmitheryConfig {
  /**
   * The platform-wide broker credential, from `SMITHERY_API_KEY`. Empty when
   * unconfigured — its presence (with a namespace) IS the gate on registering
   * the provider, so there is no separate `configured` flag to drift from it.
   */
  apiKey: string;
  /** The namespace brokered connections are created under. Empty when unconfigured. */
  namespace: string;
  /** Validated http(s) Connect API base. */
  baseUrl: string;
  /** Run Smithery's arm of the connection-revalidator probe. False whenever unconfigured. */
  monitorEnabled: boolean;
}

const UNCONFIGURED: SmitheryConfig = {
  apiKey: "",
  namespace: "",
  baseUrl: SMITHERY_API_BASE,
  monitorEnabled: false,
};

let _cached: SmitheryConfig | undefined;

/**
 * The resolved Smithery config. Computed once and cached — the same
 * install-once contract as Composio's, so a test that installs a block pairs it
 * with `_resetSmitheryConfigForTest()`.
 */
export function validateSmitheryConfig(): SmitheryConfig {
  if (!_cached) _cached = resolveSmitheryConfig();
  return _cached;
}

/**
 * Resolve + validate the Connect API base: the declared value, else the env,
 * else the default. Extracted so the resolver stays within the complexity
 * ceiling, same split as Composio's.
 *
 * Must be http(s) — the session URL derived from it becomes an installed
 * connector's remote MCP target, and it is persisted on the ref, so a bad scheme
 * would be baked into tenant state rather than merely misconfiguring a client.
 */
function resolveBaseUrl(raw: string): string {
  if (!raw) return SMITHERY_API_BASE;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`[smithery] baseUrl is not a valid URL: "${raw}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `[smithery] baseUrl must be http(s): "${raw}". The session URL derived from it ` +
        "becomes an installed connector's remote MCP target.",
    );
  }
  return raw.replace(/\/+$/, "");
}

function resolveSmitheryConfig(): SmitheryConfig {
  const declared = declaredProviderConfig("smithery");
  const apiKey = declared?.apiKey?.trim() || (process.env.SMITHERY_API_KEY?.trim() ?? "");
  // A blank declared value counts as *absent*, so the env fallback still
  // applies. A templated deploy renders `"namespace": "{{ .Values… }}"` to `""`
  // when the value is unset; treating that as a declaration would discard the
  // operator's `SMITHERY_NAMESPACE` and silently leave the provider
  // unregistered — the exact loss per-field precedence exists to prevent.
  const namespace = declared?.namespace?.trim() || (process.env.SMITHERY_NAMESPACE?.trim() ?? "");
  const rawBaseUrl = declared?.baseUrl?.trim() || (process.env.SMITHERY_API_BASE_URL?.trim() ?? "");

  if (!apiKey) {
    log.info(
      "[smithery] integration: not configured (set connectors.providers.smithery.apiKey " +
        "or SMITHERY_API_KEY to enable)",
    );
    return UNCONFIGURED;
  }
  if (!namespace) {
    log.warn(
      "[smithery] SMITHERY_API_KEY is set but no namespace resolved — integration disabled. " +
        "Declare connectors.providers.smithery.namespace or set SMITHERY_NAMESPACE.",
    );
    return UNCONFIGURED;
  }

  const baseUrl = resolveBaseUrl(rawBaseUrl);

  const monitorEnabled =
    declared?.monitorEnabled ??
    process.env.SMITHERY_MONITOR_ENABLED?.trim().toLowerCase() !== "false";
  if (!monitorEnabled) {
    log.info("[smithery] connection revalidation disabled by config");
  }

  log.info(`[smithery] integration: configured (namespace=${namespace}, base=${baseUrl})`);
  return { apiKey, namespace, baseUrl, monitorEnabled };
}

/**
 * Test-only. Drop the cached resolution so a suite can re-resolve against a
 * different declared block or env.
 */
export function _resetSmitheryConfigForTest(): void {
  _cached = undefined;
}
