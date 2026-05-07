import { loadCatalog } from "../connectors/load-catalog.ts";
import type { ConnectorRegistry, DirectoryEntry, RegistryConfig } from "./types.ts";

/**
 * Wraps the in-process curated catalog as a registry. This is the
 * platform's first-party list of vetted remote OAuth services
 * (Granola, Notion, HubSpot, Gmail, etc.). Operators with custom
 * curation needs can override the entire catalog via `NB_CATALOG_PATH`
 * — see `loadCatalog` for the resolution order.
 */
export class CuratedRegistry implements ConnectorRegistry {
  constructor(public readonly config: RegistryConfig) {}

  async listEntries(): Promise<DirectoryEntry[]> {
    const catalog = loadCatalog();
    return catalog.map((c) => ({
      id: c.id,
      registryId: this.config.id,
      registryType: "curated",
      name: c.name,
      description: c.description,
      iconUrl: c.iconUrl,
      tags: c.tags,
      defaultScope: c.defaultScope,
      install: {
        kind: "remote-oauth",
        url: c.url,
        auth: c.auth,
        ...(c.requiredScopes ? { requiredScopes: c.requiredScopes } : {}),
        ...(c.additionalAuthorizationParams
          ? { additionalAuthorizationParams: c.additionalAuthorizationParams }
          : {}),
        ...(c.operatorSetup ? { operatorSetup: c.operatorSetup } : {}),
      },
    }));
  }
}
