import { loadCatalog } from "../connectors/load-catalog.ts";
import type {
  ConnectorRegistry,
  DirectoryEntry,
  ListEntriesContext,
  RegistryConfig,
} from "./types.ts";

/**
 * Wraps the in-process curated catalog as a registry. This is the
 * platform's first-party list of vetted remote OAuth services
 * (Granola, Notion, HubSpot, Gmail, etc.). Operators with custom
 * curation needs can override the entire catalog via `NB_CATALOG_PATH`
 * — see `loadCatalog` for the resolution order.
 */
export class CuratedRegistry implements ConnectorRegistry {
  constructor(public readonly config: RegistryConfig) {}

  async listEntries(ctx?: ListEntriesContext): Promise<DirectoryEntry[]> {
    const catalog = loadCatalog();
    const out: DirectoryEntry[] = [];
    for (const c of catalog) {
      // For static-auth entries, ask the caller's workspace whether
      // the operator has configured the OAuth app yet. DCR entries
      // (no operator setup needed) leave the field undefined so the
      // UI doesn't render a meaningless badge.
      let operatorConfigured: boolean | undefined;
      if (c.auth === "static" && c.operatorSetup && ctx?.isOperatorConfigured) {
        operatorConfigured = await ctx.isOperatorConfigured(c.id, c.operatorSetup.clientSecretKey);
      }
      out.push({
        id: c.id,
        registryId: this.config.id,
        registryType: "curated",
        name: c.name,
        description: c.description,
        iconUrl: c.iconUrl,
        tags: c.tags,
        defaultScope: c.defaultScope,
        ...(operatorConfigured !== undefined ? { operatorConfigured } : {}),
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
      });
    }
    return out;
  }
}
