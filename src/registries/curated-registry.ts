import { loadCatalog } from "../connectors/load-catalog.ts";
import { loadStdioBundles } from "../connectors/stdio-catalog.ts";
import type {
  ConnectorRegistry,
  DirectoryEntry,
  ListEntriesContext,
  RegistryConfig,
} from "./types.ts";

/**
 * Wraps the in-process curated catalog as a registry. This is the
 * platform's first-party list of:
 *   - Vetted remote OAuth services (Granola, Notion, HubSpot, ...) —
 *     defined in `connectors/catalog.ts`.
 *   - Curated stdio bundles (`@nimblebraininc/*` mpak packages) —
 *     defined in `connectors/stdio-catalog.ts`.
 *
 * Both surface as `DirectoryEntry`s under `registryType: "curated"` so
 * the Browse UI renders them with one consistent badge. The install
 * action discriminator (`remote-oauth` vs `mpak-bundle`) tells the
 * install handler how to dispatch.
 *
 * Operators with custom curation needs can override the OAuth catalog
 * via `NB_CATALOG_PATH` — see `loadCatalog` for the resolution order.
 * The stdio list is hardcoded; private or per-tenant stdio bundles
 * still install via the chat agent's `bundleManagement` tool.
 */
export class CuratedRegistry implements ConnectorRegistry {
  constructor(public readonly config: RegistryConfig) {}

  async listEntries(ctx?: ListEntriesContext): Promise<DirectoryEntry[]> {
    const catalog = loadCatalog();
    const out: DirectoryEntry[] = [];

    // Remote-OAuth entries (Asana, Granola, Gmail, ...).
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

    // Curated stdio bundles. Workspace-default scope — every stdio
    // bundle is workspace-shared today (no per-user mpak install path
    // exists yet). The install dispatcher in connector-tools resolves
    // by id to the same bundle list.
    for (const s of loadStdioBundles()) {
      out.push({
        id: s.id,
        registryId: this.config.id,
        registryType: "curated",
        name: s.name,
        description: s.description,
        ...(s.iconUrl ? { iconUrl: s.iconUrl } : {}),
        ...(s.tags ? { tags: s.tags } : {}),
        defaultScope: "workspace",
        install: {
          kind: "mpak-bundle",
          package: s.bundleName,
        },
      });
    }
    return out;
  }
}
