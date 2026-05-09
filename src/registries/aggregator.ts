import { StaticRegistry } from "../connectors/static-registry.ts";
import { MpakRegistry } from "./mpak-registry.ts";
import type { RegistryStore } from "./registry-store.ts";
import type {
  ConnectorRegistry,
  DirectoryEntry,
  ListEntriesContext,
  RegistryConfig,
} from "./types.ts";

/**
 * Builds the active registry list from configuration and aggregates
 * their entries into one stream. Used by `manage_connectors.list_directory`.
 *
 * Failures from individual registries are isolated: if one registry
 * throws (network blip on mpak, malformed catalog override) the
 * others still surface their entries. The aggregator returns the
 * partial result + a list of errors so the UI can show "we're missing
 * results from <registry>" without blanking the page.
 */
export interface AggregatedDirectory {
  entries: DirectoryEntry[];
  /** Per-registry failures encountered while aggregating. */
  errors: Array<{ registryId: string; message: string }>;
}

export class DirectoryAggregator {
  constructor(private store: RegistryStore) {}

  async list(ctx?: ListEntriesContext): Promise<AggregatedDirectory> {
    const configs = await this.store.list();
    const enabled = configs.filter((c) => c.enabled);

    const entries: DirectoryEntry[] = [];
    const errors: AggregatedDirectory["errors"] = [];

    for (const cfg of enabled) {
      const registry = this.buildRegistry(cfg);
      if (!registry) continue;
      try {
        const items = await registry.listEntries(ctx);
        entries.push(...items);
      } catch (err) {
        errors.push({
          registryId: cfg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Within-registry dedup: a registry can occasionally repeat its
    // own ids (config error, duplicate in a fetched response).
    // Composite (registryId, id) keeps the first occurrence.
    const seen = new Set<string>();
    const deduped: DirectoryEntry[] = [];
    for (const e of entries) {
      const key = `${e.registryId}::${e.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(e);
    }

    return { entries: deduped, errors };
  }

  /**
   * Map a registry config to its implementation. Unknown types or
   * missing required config (a static registry without a path) are
   * silently skipped — keeps a forward-compatible upgrade path when
   * future registry types ship.
   */
  private buildRegistry(cfg: RegistryConfig): ConnectorRegistry | null {
    switch (cfg.type) {
      case "static":
        if (!cfg.url) return null;
        return new StaticRegistry(cfg, cfg.url);
      case "mpak":
        return new MpakRegistry(cfg);
      default:
        return null;
    }
  }
}
