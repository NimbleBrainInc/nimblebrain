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
 *   - **Settings** (`baseUrl`, `monitor.enabled`) are declarable. Precedence is
 *     whole-block: with `connectors.providers.composio` present the block owns
 *     them and the matching `COMPOSIO_*` vars are ignored (one warning names
 *     them); with the block absent the env hydrates them, so an upgrade from the
 *     env-sniffing era breaks nothing.
 *   - **The broker credential** comes from `COMPOSIO_API_KEY` only. It is NOT a
 *     declarable field, and it is not superseded by the block.
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
import {
  type ComposioProviderConfig,
  connectorsConfigGeneration,
  declaredProviderConfig,
} from "../config.ts";
import { composioMonitorEnabled } from "./monitor-config.ts";

/** Default Composio API host. Overridable via config `baseUrl` or `COMPOSIO_API_BASE_URL`. */
export const COMPOSIO_API_BASE = "https://backend.composio.dev";

/**
 * The settings env vars a declared block supersedes — named in the ignore
 * warning. `COMPOSIO_API_KEY` is deliberately absent: it is the credential, not
 * a setting, and persisted transport references still resolve it from the env.
 */
const SUPERSEDED_ENV_KEYS = ["COMPOSIO_API_BASE_URL", "COMPOSIO_MONITOR_ENABLED"] as const;

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
  /** Which layer supplied the *settings* — the declared block, or the env fallback. */
  source: "config" | "env";
}

let _cached: { generation: number; config: ComposioConfig } | undefined;

/**
 * The resolved Composio config. Computed once and cached (production reads it on
 * every SDK call), recomputed only when a new `connectors` block is installed.
 *
 * The name reflects first-call semantics: the first call runs full validation
 * and logs the operator-facing status line; every later call is a cache hit.
 */
export function validateComposioConfig(): ComposioConfig {
  const generation = connectorsConfigGeneration();
  if (_cached && _cached.generation === generation) return _cached.config;
  const config = resolveComposioConfig();
  _cached = { generation, config };
  return config;
}

function resolveComposioConfig(): ComposioConfig {
  const declared = declaredProviderConfig("composio");
  const source = declared ? "config" : "env";

  const apiKey = process.env.COMPOSIO_API_KEY?.trim() ?? "";
  if (!apiKey) {
    log.info("[composio] integration: not configured (set COMPOSIO_API_KEY to enable)");
    return {
      configured: false,
      apiKey: "",
      baseUrl: COMPOSIO_API_BASE,
      monitorEnabled: false,
      source,
    };
  }

  const baseUrl = resolveBaseUrl(declared);
  const tid = requireTenantIdInBouncerMode();

  // Only once the provider is actually live — on an unconfigured deploy nothing
  // is wired, so naming superseded settings would be noise beside "not configured".
  if (declared) warnSupersededEnv();

  log.info(
    `[composio] integration: configured (settings=${source}, base=${baseUrl}${tid ? `, tid=${tid}` : ""})`,
  );

  return {
    configured: true,
    apiKey,
    baseUrl,
    monitorEnabled: declared ? (declared.monitor?.enabled ?? true) : composioMonitorEnabled(true),
    source,
  };
}

/** Resolve + validate the API base from the declared block, else the env, else the default. */
function resolveBaseUrl(declared: ComposioProviderConfig | undefined): string {
  const raw = (declared ? declared.baseUrl : process.env.COMPOSIO_API_BASE_URL)?.trim();
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

/** One warning naming every settings var the declared block supersedes. */
function warnSupersededEnv(): void {
  const present = SUPERSEDED_ENV_KEYS.filter((k) => (process.env[k] ?? "").trim() !== "");
  if (present.length === 0) return;
  log.warn(
    `[composio] connectors.providers.composio is declared in nimblebrain.json; ignoring ${present.join(", ")}. ` +
      "These are the fallback only when the block is absent — move the values into the block, or remove the block. " +
      "COMPOSIO_API_KEY is unaffected: the broker credential is always read from the environment.",
  );
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
