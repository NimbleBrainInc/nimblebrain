/**
 * `ConnectorDirectory` is the single client-facing seam for the
 * registry layer. Everything callers want — Browse rows, raw
 * `ServerDetail[]`, lookup tables for the Configure page and the
 * installed-list icons — comes from one of its methods. Sources are an
 * implementation detail.
 *
 * The split rationale:
 *
 *   - `ConnectorSource` (`fetch(): Promise<ServerDetail[]>`) is a thin
 *     adapter over a backend (file / future MCP registry).
 *     One responsibility: how to talk to that backend. Internal cache
 *     strategy is private to the source.
 *   - `ConnectorDirectory` owns everything that should be uniform
 *     across source types: scope filtering, projection, error
 *     aggregation, dedup, and the lookup tables the Configure page +
 *     installed-list need. Adding a new source type only adds a
 *     `fetch()` implementation; filter / projection / lookups are
 *     inherited automatically.
 *
 * Per-instance memoization: `servers()` is cached for the lifetime of
 * the directory instance so a single tool invocation doesn't refetch
 * once per lookup. The `Runtime.getConnectorDirectory()` factory
 * returns a fresh instance per request, keeping the lifetime short.
 */

import type { ServerDetail } from "../connectors/server-detail.ts";
import { log } from "../observability/log.ts";
import {
  type ConnectorCatalogEntry,
  projectServerDetailToDirectoryEntry,
  serverDetailToCatalogEntry,
  validateServerDetailSafety,
} from "./projection.ts";
import type { RegistryStore } from "./registry-store.ts";
import { StaticSource } from "./static-source.ts";
import type {
  ConnectorSource,
  DirectoryEntry,
  ListEntriesContext,
  RegistryConfig,
} from "./types.ts";

/** Browse-list result: surviving entries + per-source failures. */
export interface AggregatedDirectory {
  entries: DirectoryEntry[];
  errors: SourceError[];
}

/** Raw-shape result for callers that need `ServerDetail[]` directly. */
export interface AggregatedServers {
  /**
   * Each surviving server tagged with the source that emitted it,
   * so downstream callers (catalog lookups, install dispatch) can
   * thread provenance into their structured logs without reaching
   * back into the directory.
   */
  servers: Array<{ source: RegistryConfig; detail: ServerDetail }>;
  errors: SourceError[];
}

export interface SourceError {
  registryId: string;
  message: string;
}

export class ConnectorDirectory {
  /** Memoized `servers()` result for this instance. */
  private cache: Promise<AggregatedServers> | null = null;

  constructor(private store: RegistryStore) {}

  /**
   * Fetch every enabled source, apply per-source scope filter, and
   * return the raw `ServerDetail[]` tagged with provenance. Memoized
   * per directory instance — repeated calls within a single request
   * share one network round-trip.
   *
   * Per-source failures are isolated: a single down source contributes
   * an entry to `errors`; the rest of the result still flows.
   */
  async servers(): Promise<AggregatedServers> {
    if (!this.cache) this.cache = this.fetchAll();
    return this.cache;
  }

  /**
   * Browse-shaped result. Same data as `servers()` projected through
   * `projectServerDetailToDirectoryEntry`. Per-(registryId, id) dedup
   * keeps the first occurrence when a single source repeats an id.
   *
   * `ctx.isOperatorConfigured` is awaited per static-auth entry to
   * compute the `operatorConfigured` field — DCR / unknown
   * entries skip the probe.
   */
  async list(ctx?: ListEntriesContext): Promise<AggregatedDirectory> {
    const { servers, errors } = await this.servers();

    const entries: DirectoryEntry[] = [];
    const seen = new Set<string>();
    for (const { source, detail } of servers) {
      const entry = projectServerDetailToDirectoryEntry(detail, {
        registryId: source.id,
        registryType: source.type,
      });
      if (!entry) {
        // Projection returned null = entry isn't installable by this
        // runtime (no remotes, or an unsupported transport — a
        // `packages[]`-only entry is a downloadable bundle, which this
        // runtime does not acquire). Log so an operator debugging "why
        // doesn't my entry appear in Browse?" sees the cause instead of a
        // silent omission.
        log.warn(
          `[connector-directory] [${source.id}] entry "${detail.name}" dropped — not installable as a remote MCP server`,
        );
        continue;
      }
      const key = `${entry.registryId}::${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Workspace-aware probe for static-auth entries only — the rest
      // skip it so the field stays undefined (UI renders no badge).
      if (
        entry.install.kind === "remote-oauth" &&
        entry.install.auth === "static" &&
        entry.install.operatorSetup &&
        ctx?.isOperatorConfigured
      ) {
        entry.operatorConfigured = await ctx.isOperatorConfigured(
          entry.id,
          entry.install.operatorSetup.clientSecretKey,
        );
      }
      entries.push(entry);
    }
    return { entries, errors };
  }

  /**
   * Flat `ConnectorCatalogEntry[]` — the shape the catalog tool surface
   * + Configure page consume. Drops only servers without remotes (those
   * have no installable identity). A missing icon is cosmetic and never
   * drops the entry — the UI falls back to a letter-avatar.
   */
  async catalogEntries(): Promise<ConnectorCatalogEntry[]> {
    const { servers } = await this.servers();
    const out: ConnectorCatalogEntry[] = [];
    for (const { detail } of servers) {
      const entry = serverDetailToCatalogEntry(detail);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Lookup table for handleListInstalled: remote bundles match their
   * URL to a catalog entry to render the icon, name, and operator-setup
   * affordance. Built once from the cached projection.
   */
  async catalogByUrl(): Promise<Map<string, ConnectorCatalogEntry>> {
    const entries = await this.catalogEntries();
    return new Map(entries.map((e) => [e.url, e]));
  }

  /** Single-entry lookup by reverse-DNS id (used by setup_operator handlers). */
  async catalogById(id: string): Promise<ConnectorCatalogEntry | null> {
    const entries = await this.catalogEntries();
    return entries.find((e) => e.id === id) ?? null;
  }

  /**
   * Lookup table for installed-bundle loops that need a per-bundle
   * catalog match keyed by the persisted composio connectorId.
   * Symmetric to `catalogByUrl` — built once per call rather than
   * re-scanning `catalogEntries()` per bundle inside a loop.
   */
  async catalogByIdMap(): Promise<Map<string, ConnectorCatalogEntry>> {
    const entries = await this.catalogEntries();
    return new Map(entries.map((e) => [e.id, e]));
  }

  /** Drop the per-instance memoization. Test / admin escape hatch. */
  resetCache(): void {
    this.cache = null;
  }

  // ── internals ────────────────────────────────────────────────────

  private async fetchAll(): Promise<AggregatedServers> {
    const configs = (await this.store.list()).filter((c) => c.enabled);
    const out: AggregatedServers = { servers: [], errors: [] };

    for (const cfg of configs) {
      const source = this.buildSource(cfg);
      if (!source) continue;
      let raw: ServerDetail[];
      try {
        raw = await source.fetch();
      } catch (err) {
        out.errors.push({
          registryId: cfg.id,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const filtered = applyScopeFilter(raw, cfg.scopes);
      for (const detail of filtered) {
        // Defense-in-depth: drop entries with javascript:/data:/file:
        // URLs in icon/portal/docs slots OR reserved-key OAuth-param
        // smuggling. Runs at the directory boundary so every source
        // (static / future) is scrubbed identically — pre-fix only
        // static-source ran this check, so a non-curated entry with
        // `_meta.docsUrl: "javascript:..."` would render as a clickable
        // `<a href>` in the Configure page.
        const safetyError = validateServerDetailSafety(detail);
        if (safetyError) {
          log.warn(
            `[connector-directory] [${cfg.id}] entry "${detail.name}" dropped — ${safetyError}`,
          );
          continue;
        }
        out.servers.push({ source: cfg, detail });
      }
    }
    return out;
  }

  /**
   * Map a registry config to its `ConnectorSource` via {@link SOURCE_FACTORIES}.
   * A type with no factory — or one whose factory declines for missing
   * required config (a static source without a path) — yields `null` and the
   * registry is skipped. That is the forward-compatible path: a new source
   * type is one factory entry, and a config naming a type this build does not
   * carry degrades to "no entries from that registry" rather than a crash.
   */
  private buildSource(cfg: RegistryConfig): ConnectorSource | null {
    const factory = SOURCE_FACTORIES[cfg.type];
    if (!factory) {
      log.warn(`[connector-directory] no source implementation for registry type "${cfg.type}"`);
      return null;
    }
    return factory(cfg);
  }
}

/**
 * Registry type → source constructor. The map, not a `switch`, is the
 * extension point: `RegistryType` is an open string (see `types.ts`), so
 * adding the upstream MCP registry source is one entry here plus its file.
 */
const SOURCE_FACTORIES: Record<string, (cfg: RegistryConfig) => ConnectorSource | null> = {
  static: (cfg) => (cfg.url ? new StaticSource(cfg.id, cfg.url) : null),
};

/**
 * Drop entries that don't match any of the configured scopes. Match
 * rule (OR-of-prefixes): an entry passes if any of its identifiers
 * match any of the configured scopes. Identifiers checked:
 *
 *   - The reverse-DNS prefix of `ServerDetail.name`
 *     (e.g. `ai.nimblebrain` matches `ai.nimblebrain/echo`)
 *   - The npm scope of any `packages[].identifier`
 *     (e.g. `nimblebraininc` matches `@nimblebraininc/echo`)
 *
 * The dual-rule design lets operators write the scope they think in
 * (npm form for package operators; reverse-DNS for catalog operators)
 * and have it work uniformly across source types. Empty / undefined
 * `scopes` returns the input untouched (no filter).
 */
function applyScopeFilter(servers: ServerDetail[], scopes: string[] | undefined): ServerDetail[] {
  if (!scopes || scopes.length === 0) return servers;
  const norm = scopes.map((s) => s.toLowerCase());
  return servers.filter((s) => {
    const reverseDns = s.name.split("/")[0]?.toLowerCase() ?? "";
    if (norm.some((scope) => reverseDns === scope || reverseDns.startsWith(`${scope}.`))) {
      return true;
    }
    for (const pkg of s.packages ?? []) {
      const npmScope = parseNpmScope(pkg.identifier);
      if (npmScope && norm.includes(npmScope)) return true;
    }
    return false;
  });
}

/** `@scope/name` → `scope` (lowercased); non-scoped npm name → null. */
function parseNpmScope(identifier: string): string | null {
  const m = /^@([^/]+)\//.exec(identifier);
  return m ? (m[1]?.toLowerCase() ?? null) : null;
}
