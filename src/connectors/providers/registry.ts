/**
 * The managed-connector provider registry.
 *
 * The runtime builds this once at startup and dispatches all brokered
 * connector wiring (routes, revalidator probes, sessions, API-key connects)
 * through it. A provider is present in the registry **iff configured** — absent
 * config ⇒ no provider ⇒ no vendor import, no routes, no probe. That gating is
 * what makes an optional vendor (Composio) stop linking at boot for deploys
 * that don't use it.
 *
 * Phase 1 hydrates from the existing `COMPOSIO_*` env (no config-schema change
 * yet). Phase 2 will feed the same builder from the declared
 * `connectors.providers.*` block in `nimblebrain.json`; the seam is here.
 */

import { createComposioProvider } from "./composio/provider.ts";
import { validateComposioConfig } from "./composio/sdk.ts";
import type { ConnectorAuthKind, ManagedConnectorProvider } from "./managed-provider.ts";

/** Read-only lookup of the configured brokered providers, keyed by `auth-kind`. */
export interface ManagedConnectorRegistry {
  /** The provider owning `id`, or undefined when none is configured for it. */
  get(id: ConnectorAuthKind): ManagedConnectorProvider | undefined;
  /** Whether a provider is registered for `id`. */
  has(id: ConnectorAuthKind): boolean;
  /** Every registered provider, for wiring that fans out over all of them (routes, probes). */
  list(): ManagedConnectorProvider[];
}

class MapManagedConnectorRegistry implements ManagedConnectorRegistry {
  private readonly providers = new Map<ConnectorAuthKind, ManagedConnectorProvider>();

  constructor(providers: readonly ManagedConnectorProvider[]) {
    for (const provider of providers) this.providers.set(provider.id, provider);
  }

  get(id: ConnectorAuthKind): ManagedConnectorProvider | undefined {
    return this.providers.get(id);
  }

  has(id: ConnectorAuthKind): boolean {
    return this.providers.has(id);
  }

  list(): ManagedConnectorProvider[] {
    return [...this.providers.values()];
  }
}

/**
 * Wrap an explicit provider list in a registry. The seam for tests to register
 * a fake provider (the target test model — mock the seam, not the vendor) and
 * for the builder below.
 */
export function managedConnectorRegistryOf(
  providers: readonly ManagedConnectorProvider[],
): ManagedConnectorRegistry {
  return new MapManagedConnectorRegistry(providers);
}

/**
 * Build the registry from instance config. Phase 1: the only source is the
 * `COMPOSIO_*` env, surfaced through `validateComposioConfig()`. Constructing a
 * provider links no vendor (the SDK loads lazily inside the impl), so this is
 * safe to call at startup unconditionally; the gate is purely whether a
 * provider is *present*.
 */
export function buildManagedConnectorRegistry(): ManagedConnectorRegistry {
  const providers: ManagedConnectorProvider[] = [];

  if (validateComposioConfig().configured) {
    providers.push(createComposioProvider());
  }

  return new MapManagedConnectorRegistry(providers);
}
