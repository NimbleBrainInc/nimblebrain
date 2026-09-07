/**
 * `ConnectorCatalog` is the one place connectors come from.
 *
 * It reads a single directory of `ServerDetail` files — the shape the
 * upstream MCP registry publishes — validates and safety-scrubs every
 * entry, projects the survivors into the two shapes callers need, and
 * serves the lookup tables the Configure page and the installed list
 * read. `NB_CURATED_CATALOG_DIR` points at that directory; the image
 * ships a minimal example so a fresh install is not empty.
 *
 * **Populating the directory is not the runtime's job.** A GitOps
 * ConfigMap, an operator, or a job that mirrors some upstream index all
 * do it the same way: write `ServerDetail` files. That keeps the seam a
 * serialization boundary anyone can reach rather than an in-process
 * interface only this codebase can implement, and it is why federating
 * a second index needs no runtime code — only a writer.
 *
 * Composition across files is the read's own concern: every
 * `*.yaml`/`*.yml`/`*.json` in the directory is read in sorted order,
 * validated independently so a diagnostic names its file, and deduped
 * first-wins. Splitting curation across files is a GitOps convenience
 * that still rolls up to one catalog.
 *
 * Per-instance memoization: `servers()` is cached for the lifetime of
 * the instance so a single tool invocation does not re-read once per
 * lookup. `Runtime.getConnectorCatalog()` returns a fresh instance per
 * request, keeping the lifetime short.
 */

import { join } from "node:path";
import { log } from "../../observability/log.ts";
import {
  projectServerDetailToCatalogListing,
  serverDetailToCatalogEntry,
  validateServerDetailSafety,
} from "./projection.ts";
import { readCatalogEntries } from "./read.ts";
import type { ServerDetail } from "./server-detail.ts";
import type { CatalogListing, ConnectorCatalogEntry, ListEntriesContext } from "./types.ts";

/** Browse-list result: surviving listings + the files that failed. */
export interface AggregatedCatalog {
  entries: CatalogListing[];
  errors: CatalogError[];
}

/** Raw-shape result for callers that need `ServerDetail[]` directly. */
export interface AggregatedServers {
  /**
   * Each surviving server tagged with the catalog file that carried it,
   * so downstream callers can thread provenance into structured logs
   * without re-reading the directory.
   */
  servers: Array<{ file: string; detail: ServerDetail }>;
  errors: CatalogError[];
}

/**
 * A catalog file that could not be read, parsed, or validated. Keyed on
 * the file rather than on a configured source id: the file IS the
 * identity, so an operator reading this knows exactly what to open.
 */
export interface CatalogError {
  file: string;
  message: string;
}

/**
 * The minimal curated catalog shipped in the image — a directory of
 * `ServerDetail` YAML files. Deliberately tiny: a couple of DCR entries
 * so a fresh / OSS / dev install has a non-empty Browse without
 * inheriting anyone's production curation.
 */
export const BUNDLED_CATALOG_PATH = join(import.meta.dir, "curated");

/**
 * Deployment override for the catalog directory — a mounted ConfigMap
 * (e.g. `/config/connectors`) replacing the in-image example with the
 * real, externally-managed catalog. This is the whole configuration
 * surface: where the files are. What writes them is outside the
 * runtime.
 */
export const CATALOG_DIR_ENV = "NB_CURATED_CATALOG_DIR";

/** The catalog directory: the deployment override when set, else the in-image example. */
export function catalogPath(): string {
  const override = process.env[CATALOG_DIR_ENV]?.trim();
  return override && override.length > 0 ? override : BUNDLED_CATALOG_PATH;
}

/**
 * Boot-time visibility check. An empty catalog is indistinguishable
 * from a working one until a user opens Browse and finds nothing, so
 * say it once at startup with the path that produced it.
 */
export async function warnIfCatalogEmpty(catalog: ConnectorCatalog): Promise<void> {
  const { servers, errors } = await catalog.servers();
  if (servers.length > 0) return;
  const why = errors.length > 0 ? ` (${errors.map((e) => e.message).join("; ")})` : "";
  log.warn(
    `[catalog] "${catalogPath()}" resolved to 0 entries${why} — Browse will be empty until a ` +
      `non-empty catalog is in place (check the mount or ${CATALOG_DIR_ENV}).`,
  );
}

export class ConnectorCatalog {
  /** Memoized `servers()` result for this instance. */
  private cache: Promise<AggregatedServers> | null = null;

  constructor(private catalogDir: string) {}

  /**
   * Read the catalog directory and return the raw `ServerDetail[]`
   * tagged with the file each came from. Memoized per instance, so
   * repeated calls within one request share a single read.
   *
   * A file that fails to read, parse, or validate contributes to
   * `errors`; every other file still flows.
   */
  async servers(): Promise<AggregatedServers> {
    if (!this.cache) this.cache = this.read();
    return this.cache;
  }

  /**
   * Browse-shaped result. Same data as `servers()` projected through
   * `projectServerDetailToCatalogListing`, deduped first-wins by id.
   *
   * `ctx.isOperatorConfigured` is awaited per static-auth entry to
   * compute `operatorConfigured` — DCR / unknown entries skip the probe.
   */
  async list(ctx?: ListEntriesContext): Promise<AggregatedCatalog> {
    const { servers, errors } = await this.servers();

    const entries: CatalogListing[] = [];
    const seen = new Set<string>();
    for (const { file, detail } of servers) {
      const entry = projectServerDetailToCatalogListing(detail);
      if (!entry) {
        // Projection returned null = the entry is not installable by this
        // runtime (no remotes, or an unsupported transport — a
        // `packages[]`-only entry is a downloadable connector, which this
        // runtime does not acquire). Log so an operator debugging "why
        // doesn't my entry appear in Browse?" sees the cause instead of a
        // silent omission.
        log.warn(
          `[catalog] [${file}] entry "${detail.name}" dropped — not installable as a remote MCP server`,
        );
        continue;
      }
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);

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
   * Flat `ConnectorCatalogEntry[]` — the shape the connector tool
   * surface + Configure page consume. Drops only servers without
   * remotes (those have no installable identity). A missing icon is
   * cosmetic and never drops the entry — the UI falls back to a
   * letter-avatar.
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
   * Lookup table for handleListInstalled: remote connectors match their
   * URL to a catalog entry to render the icon, name, and operator-setup
   * affordance. Built once from the cached read.
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
   * Lookup table for installed-connector loops that need a per-connector
   * catalog match keyed by the persisted composio connectorId.
   * Symmetric to `catalogByUrl` — built once per call rather than
   * re-scanning `catalogEntries()` per connector inside a loop.
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

  private async read(): Promise<AggregatedServers> {
    const { entries, diagnostics } = readCatalogEntries(this.catalogDir);

    // A diagnostic carrying an entry `index` is one bad record inside an
    // otherwise-fine file: logged, like every other per-entry drop, and
    // not worth an operator-facing error. A diagnostic without one is a
    // file that could not be read or parsed at all — that is the case
    // where "the catalog looks empty" needs a cause attached to it, so it
    // reaches callers as an error keyed on the file.
    const out: AggregatedServers = { servers: [], errors: [] };
    for (const d of diagnostics) {
      if (d.index === undefined) out.errors.push({ file: d.source, message: d.message });
      else log.warn(`[catalog] ${d.message}`);
    }

    for (const { detail, source } of entries) {
      // Defense-in-depth: drop entries with javascript:/data:/file: URLs
      // in icon/portal/docs slots, or reserved-key OAuth-param
      // smuggling. Runs here rather than in the read so a catalog file
      // dropped in by any writer is scrubbed on the way through,
      // whatever produced it.
      const safetyError = validateServerDetailSafety(detail);
      if (safetyError) {
        log.warn(`[catalog] [${source}] entry "${detail.name}" dropped — ${safetyError}`);
        continue;
      }
      out.servers.push({ file: source, detail });
    }
    return out;
  }
}
