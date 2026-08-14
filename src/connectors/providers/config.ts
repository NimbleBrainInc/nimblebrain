/**
 * The declared `connectors` block of `nimblebrain.json` — the config interface
 * managed-connector providers are configured through.
 *
 * One instance per tenant is the only supported topology, so **instance config
 * == tenant config**: there is exactly one config layer, installed once at the
 * composition root (`Runtime.start`) and read synchronously by provider wiring
 * thereafter. There is no cross-tenant scoping and no config-layer merge here.
 *
 * Settings resolve from the block alone — one value, one source. The broker
 * credential is the exception: `apiKey` also reads `<VENDOR>_API_KEY`, because a
 * secret has a legitimate home in the environment (#839).
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
   * Keyed by toolkit rather than by env-var name on purpose. The key is still a
   * string shared with the catalog's `composio.toolkit` and matched exactly, so
   * a mistyped key resolves to nothing — but it is the entry's own identifier
   * rather than a third name invented to carry the value, which is what put the
   * same string in the catalog, the deploy values, and a guard on its spelling.
   * The boot audit in `composio/auth-config-audit.ts` reports any key matching
   * no catalog toolkit, so the remaining coupling is checked rather than merely
   * narrowed.
   */
  authConfigs?: Record<string, string>;
  /** Composio API base URL override (self-hosted / staging). Must be http(s). */
  baseUrl?: string;
  /**
   * Run Composio's arm of the connection-revalidator probe. Default: true when
   * the provider is configured. Only
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
  /** Smithery namespace brokered connections are created under. No default — account-owned. */
  namespace?: string;
  /** Connect API base URL override. Must be http(s). */
  baseUrl?: string;
  /**
   * Run Smithery's arm of the connection-revalidator probe. Default: true when
   * the provider is configured.
   */
  monitorEnabled?: boolean;
}

/** Declared provider blocks, keyed by the connector `auth-kind` the provider owns. */
export interface ManagedProviderConfigs {
  composio?: ComposioProviderConfig;
  smithery?: SmitheryProviderConfig;
}

/**
 * The declared `connectors.gateways.<name>` block — one hosted-MCP vendor that
 * issues a single account-wide API key and brokers nothing.
 *
 * A **gateway** sits on the other side of the line from a managed-connector
 * provider. A provider mints a session per connection and therefore owns an
 * `auth-kind`, routes, and a liveness probe; the registry in `registry.ts` is
 * exactly that set. A gateway publishes fixed endpoints, so the only thing to
 * configure is the credential its catalog entries authenticate with. Declaring
 * one registers a credential provider under its name and nothing else.
 *
 * The name is the operator's own, matched verbatim against the
 * `providerAuth.provider` an `auth: provider` catalog entry declares. Keys are
 * free-form for the same reason Composio's `authConfigs` are keyed by toolkit
 * slug: the entry already carries the identifier, so reusing it beats inventing
 * a second name to carry the value.
 */
export interface GatewayConfig {
  /**
   * The account-wide API key, attached as `Authorization: Bearer`. Falls back to
   * `<NAME>_API_KEY` (the gateway name upper-cased, non-alphanumerics to `_`),
   * so `mcp360` reads `MCP360_API_KEY`.
   *
   * Declarable for the same reason the broker credentials are: a connector's
   * persisted transport names the credential provider rather than an env var, so
   * where the value lives stays this module's business and never reaches tenant
   * state.
   */
  apiKey?: string;
}

/** Declared gateway blocks, keyed by the operator-chosen gateway name. */
export type GatewayConfigs = Record<string, GatewayConfig>;

/** The `connectors` block of `nimblebrain.json`. */
export interface ConnectorsConfig {
  providers?: ManagedProviderConfigs;
  gateways?: GatewayConfigs;
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
  gateways: true,
};

const GATEWAY_FIELDS: Record<keyof Required<GatewayConfig>, true> = {
  apiKey: true,
};

/** Every key a `connectors.gateways.<name>` block accepts. */
export const GATEWAY_CONFIG_KEYS: string[] = Object.keys(GATEWAY_FIELDS);

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

/** The declared gateways, or undefined when the operator declared none. */
export function declaredGatewayConfigs(): GatewayConfigs | undefined {
  return _declared?.gateways;
}

/** Test-only. Drop the installed block so a suite starts from no declared config. */
export function _resetConnectorsConfigForTest(): void {
  setConnectorsConfig(undefined);
}
