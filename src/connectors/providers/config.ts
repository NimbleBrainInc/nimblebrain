/**
 * The declared `connectors` block of `nimblebrain.json` — the config interface
 * managed-connector providers are configured through.
 *
 * One instance per tenant is the only supported topology, so **instance config
 * == tenant config**: there is exactly one config layer, installed once at the
 * composition root (`Runtime.start`) and read synchronously by provider wiring
 * thereafter. There is no cross-tenant scoping and no config-layer merge here.
 *
 * A provider's block is authoritative for that provider's **settings** as a
 * whole: when the block is present, every setting comes from it and the
 * provider's legacy `<VENDOR>_*` env vars are ignored (the provider logs one
 * warning naming them). When the block is absent, the env hydrates them — the
 * back-compat path, so an upgrade from the env-sniffing era breaks nothing.
 *
 * A provider's **broker credential is not a setting and is not declared here.**
 * It stays in the environment while a connector's persisted transport credential
 * is still an env reference; binding it to a `TransportCredentialProvider`
 * (`src/tools/credential-provider.ts`) is what makes it declarable. Persisted
 * state must name *what* credential it needs, never *where* the value comes from.
 *
 * Each provider owns its own resolution (Composio's is `providers/composio/config.ts`);
 * this module only holds what was declared.
 */

/**
 * Composio's arm of the connection-revalidator probe. Only the enable/disable is
 * vendor-specific — the sweep *cadence* is provider-agnostic and belongs to the
 * revalidator (`revalidatorIntervalMsFromEnv` in `bundles/connection-revalidator.ts`),
 * so it is deliberately not declarable here.
 */
export interface ComposioMonitorConfig {
  /** Run the probe. Default: true when the provider is configured. */
  enabled?: boolean;
}

/**
 * The declared `connectors.providers.composio` block — settings only. The broker
 * credential is read from `COMPOSIO_API_KEY`; see the module note above.
 */
export interface ComposioProviderConfig {
  /** Composio API base URL override (self-hosted / staging). Must be http(s). */
  baseUrl?: string;
  /** Connection-revalidator probe knobs. */
  monitor?: ComposioMonitorConfig;
}

/** Declared provider blocks, keyed by the connector `auth-kind` the provider owns. */
export interface ManagedProviderConfigs {
  composio?: ComposioProviderConfig;
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
};

const COMPOSIO_PROVIDER_FIELDS: Record<keyof Required<ComposioProviderConfig>, true> = {
  baseUrl: true,
  monitor: true,
};

const COMPOSIO_MONITOR_FIELDS: Record<keyof Required<ComposioMonitorConfig>, true> = {
  enabled: true,
};

/** Every key the `connectors` block accepts. */
export const CONNECTORS_CONFIG_KEYS: string[] = Object.keys(CONNECTORS_FIELDS);
/** Every provider a `connectors.providers` block may declare. */
export const MANAGED_PROVIDER_KEYS: string[] = Object.keys(MANAGED_PROVIDER_FIELDS);
/** Every key the `connectors.providers.composio` block accepts. */
export const COMPOSIO_PROVIDER_CONFIG_KEYS: string[] = Object.keys(COMPOSIO_PROVIDER_FIELDS);
/** Every key the `connectors.providers.composio.monitor` block accepts. */
export const COMPOSIO_MONITOR_CONFIG_KEYS: string[] = Object.keys(COMPOSIO_MONITOR_FIELDS);

// ── The installed config ─────────────────────────────────────────────

let _declared: ConnectorsConfig | undefined;
let _generation = 0;

/**
 * Install the declared `connectors` block. Called once at the composition root
 * (`Runtime.start`), before any provider wiring reads it.
 */
export function setConnectorsConfig(config: ConnectorsConfig | undefined): void {
  _declared = config;
  _generation += 1;
}

/** The block a provider declared, or undefined when the operator declared none. */
export function declaredProviderConfig<K extends keyof ManagedProviderConfigs>(
  id: K,
): ManagedProviderConfigs[K] | undefined {
  return _declared?.providers?.[id];
}

/**
 * Bumped on every install. A provider's resolver caches its resolution against
 * this counter, so a config installed *after* a read can never be shadowed by an
 * env-only value cached earlier — the resolver recomputes on the next call
 * instead. Without it, read-before-install would silently pin the fallback.
 */
export function connectorsConfigGeneration(): number {
  return _generation;
}

/** Test-only. Drop the installed block so a suite starts from the env-fallback path. */
export function _resetConnectorsConfigForTest(): void {
  setConnectorsConfig(undefined);
}
