/**
 * The declared `connectors` block of `nimblebrain.json` — the config interface
 * managed-connector providers are configured through.
 *
 * One instance per tenant is the only supported topology, so **instance config
 * == tenant config**: there is exactly one config layer, installed once at the
 * composition root (`Runtime.start`) and read synchronously by provider wiring
 * thereafter. There is no cross-tenant scoping and no config-layer merge here.
 *
 * Settings fall back **per field**: a setting declared in the block wins, a
 * setting left out reads its provider's legacy `<VENDOR>_*` var. Nothing is
 * silently discarded, so an upgrade from the env-sniffing era breaks nothing and
 * declaring one setting can't disturb another.
 *
 * Each provider owns its own resolution (Composio's is `providers/composio/config.ts`);
 * this module only holds what was declared.
 */

/** The declared `connectors.providers.composio` block. */
export interface ComposioProviderConfig {
  /**
   * Platform-wide Composio API key — the broker credential, and the gate on
   * registering the provider at all. Falls back to `COMPOSIO_API_KEY`.
   *
   * Declarable because a connector's persisted transport credential names the
   * `composio` credential provider rather than an env var, so resolution is this
   * provider's own business. Keeping a secret in a mounted config file is still
   * the operator's call — the env fallback remains the better posture for most
   * deployments.
   */
  apiKey?: string;
  /**
   * Per-toolkit Composio auth-config ids (`ac_…`), keyed by the **toolkit slug**
   * the catalog entry already names — `{ "gmail": "ac_xyz" }`.
   *
   * Non-secret identifiers (a client_id, not a client_secret — inert without
   * `apiKey`), and per-deployment, because the id differs per Composio account
   * while the catalog is shared.
   *
   * Keyed by toolkit rather than by env-var name on purpose: the toolkit is
   * already the entry's own identifier, so declaring an id introduces no string
   * that has to match anything elsewhere. Keying on a name the catalog also has
   * to spell puts one string in three places — the catalog, the deploy values,
   * and whatever guards the spelling — where a typo yields config no connector
   * reads.
   */
  authConfigs?: Record<string, string>;
  /** Composio API base URL override (self-hosted / staging). Must be http(s). */
  baseUrl?: string;
  /**
   * Run Composio's arm of the connection-revalidator probe. Default: true when
   * the provider is configured; falls back to `COMPOSIO_MONITOR_ENABLED`. Only
   * the enable/disable is vendor-specific — the sweep *cadence* is
   * provider-agnostic and belongs to the revalidator.
   */
  monitorEnabled?: boolean;
}

/**
 * The declared `connectors.providers.smithery` block — settings only. The broker
 * credential is read from `SMITHERY_API_KEY`; see the module note above.
 */
export interface SmitheryProviderConfig {
  /** Platform-wide Smithery API key. Falls back to `SMITHERY_API_KEY`. */
  apiKey?: string;
  /** Smithery namespace brokered connections are created under. Falls back to `SMITHERY_NAMESPACE`. */
  namespace?: string;
  /** Connect API base URL override. Must be http(s). Falls back to `SMITHERY_API_BASE_URL`. */
  baseUrl?: string;
  /**
   * Run Smithery's arm of the connection-revalidator probe. Default: true when
   * the provider is configured; falls back to `SMITHERY_MONITOR_ENABLED`.
   */
  monitorEnabled?: boolean;
}

/** Declared provider blocks, keyed by the connector `auth-kind` the provider owns. */
export interface ManagedProviderConfigs {
  composio?: ComposioProviderConfig;
  smithery?: SmitheryProviderConfig;
}

/** The `connectors` block of `nimblebrain.json`. */
export interface ConnectorsConfig {
  providers?: ManagedProviderConfigs;
}

// ── Schema drift guard ───────────────────────────────────────────────
//
// `Record<keyof Required<T>, true>` makes a field added to one of the
// interfaces above a *compile* error until it is listed here, and
// `test/unit/config-schema-drift.test.ts` then fails until it is also declared
// in `nimblebrain-config.schema.json`. Two mechanical steps, no silent drift
// between the runtime's typed surface and the published schema.

const CONNECTORS_FIELDS: Record<keyof Required<ConnectorsConfig>, true> = {
  providers: true,
};

const MANAGED_PROVIDER_FIELDS: Record<keyof Required<ManagedProviderConfigs>, true> = {
  composio: true,
  smithery: true,
};

const COMPOSIO_PROVIDER_FIELDS: Record<keyof Required<ComposioProviderConfig>, true> = {
  apiKey: true,
  authConfigs: true,
  baseUrl: true,
  monitorEnabled: true,
};

/** Every key the `connectors` block accepts. */
export const CONNECTORS_CONFIG_KEYS: string[] = Object.keys(CONNECTORS_FIELDS);
/** Every provider a `connectors.providers` block may declare. */
export const MANAGED_PROVIDER_KEYS: string[] = Object.keys(MANAGED_PROVIDER_FIELDS);
const SMITHERY_PROVIDER_FIELDS: Record<keyof Required<SmitheryProviderConfig>, true> = {
  apiKey: true,
  namespace: true,
  baseUrl: true,
  monitorEnabled: true,
};

/** Every key the `connectors.providers.composio` block accepts. */
export const COMPOSIO_PROVIDER_CONFIG_KEYS: string[] = Object.keys(COMPOSIO_PROVIDER_FIELDS);
/** Every key the `connectors.providers.smithery` block accepts. */
export const SMITHERY_PROVIDER_CONFIG_KEYS: string[] = Object.keys(SMITHERY_PROVIDER_FIELDS);

// ── The installed config ─────────────────────────────────────────────

let _declared: ConnectorsConfig | undefined;

/**
 * Install the declared `connectors` block. Called once at the composition root
 * (`Runtime.start`), ahead of every provider read — the registry build, the
 * route mount, and the probe wiring all happen later in `start`. That ordering
 * is the guarantee; providers cache their resolution outright and are not
 * expected to see a second install.
 */
export function setConnectorsConfig(config: ConnectorsConfig | undefined): void {
  _declared = config;
}

/** The block a provider declared, or undefined when the operator declared none. */
export function declaredProviderConfig<K extends keyof ManagedProviderConfigs>(
  id: K,
): ManagedProviderConfigs[K] | undefined {
  return _declared?.providers?.[id];
}

/** Test-only. Drop the installed block so a suite starts from the env-fallback path. */
export function _resetConnectorsConfigForTest(): void {
  setConnectorsConfig(undefined);
}
