import { CuratedRegistry } from "./curated-registry.ts";
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

    // Two-pass dedup:
    //
    //   Pass 1 — within-registry: a registry can occasionally repeat
    //   its own ids (config error, duplicate in a fetched response).
    //   Composite (registryId, id) keeps the first.
    //
    //   Pass 2 — cross-registry on the install target. CuratedRegistry
    //   surfaces stdio bundles via STDIO_BUNDLES; MpakRegistry has its
    //   own stub set with overlapping packages (echo, ipinfo, etc.).
    //   Without this dedup the user sees the same connector twice with
    //   different ids — and the mpak version's id is the package name,
    //   so clicking it routes through `findStdioBundle(packageName)`.
    //   We prefer the curated card (richer copy, stable id), and drop
    //   the mpak duplicate.
    const seenComposite = new Set<string>();
    const passOne: DirectoryEntry[] = [];
    for (const e of entries) {
      const key = `${e.registryId}::${e.id}`;
      if (seenComposite.has(key)) continue;
      seenComposite.add(key);
      passOne.push(e);
    }

    // Stable order for the cross-registry pass: curated first so it
    // wins when an mpak entry has the same package. The aggregator's
    // input order isn't guaranteed, so sort explicitly.
    const registryRank = (type: DirectoryEntry["registryType"]): number => {
      if (type === "curated") return 0;
      if (type === "mpak") return 1;
      return 2;
    };
    passOne.sort((a, b) => registryRank(a.registryType) - registryRank(b.registryType));

    const seenPackage = new Set<string>();
    const deduped: DirectoryEntry[] = [];
    for (const e of passOne) {
      const installKey = installTarget(e);
      if (installKey && seenPackage.has(installKey)) continue;
      if (installKey) seenPackage.add(installKey);
      deduped.push(e);
    }

    return { entries: deduped, errors };
  }

  /**
   * Map a registry config to its implementation. Unknown types are
   * silently skipped — keeps a forward-compatible upgrade path when
   * future registry types ship.
   */
  private buildRegistry(cfg: RegistryConfig): ConnectorRegistry | null {
    switch (cfg.type) {
      case "curated":
        return new CuratedRegistry(cfg);
      case "mpak":
        return new MpakRegistry(cfg);
      default:
        return null;
    }
  }
}

/**
 * The "thing this entry would actually install" — used for cross-
 * registry dedup. Two entries that resolve to the same install
 * target (mpak package name, remote URL, or direct URL) are
 * duplicates regardless of which registry surfaced them. Returns
 * `null` for kinds we don't dedupe on.
 */
function installTarget(entry: DirectoryEntry): string | null {
  switch (entry.install.kind) {
    case "mpak-bundle":
      return `mpak:${entry.install.package}`;
    case "remote-oauth":
      return `url:${entry.install.url}`;
    case "direct-url":
      return `url:${entry.install.url}`;
    default:
      return null;
  }
}
