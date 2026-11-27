/**
 * `ConnectorCatalog` is the one place connectors come from.
 *
 * It reads one catalog of `ServerDetail` records — the shape the upstream MCP
 * registry publishes — validates and safety-scrubs every entry, projects the
 * survivors into the two shapes callers need, and serves the lookup tables the
 * Configure page and the installed list read.
 *
 * **Where the catalog comes from** (`catalogLocation`), one source at a time:
 *
 * - **The pinned plugin index**, by default: the NimbleBrain index of the
 *   catalog at `NB_PLUGIN_CATALOG_URL` (catalog.nimblebrain.ai), pinned by
 *   `NB_PLUGIN_CATALOG_SHA256`, and the `ServerDetail` each plugin it lists
 *   carries (`plugin-index.ts`). It is the index connector skills come from, so
 *   dev, a local install and a release image show one list, and moving it
 *   forward is bumping the one pin. An operator with their own list publishes
 *   their own catalog and points the URL and pin at it.
 * - **A directory**, when `NB_CURATED_CATALOG_DIR` names one: it replaces the
 *   pinned index wholesale, never merges with it. A mounted directory is
 *   trusted by whoever mounts it, so it needs no pin and an edit takes effect on
 *   the next read. It holds what a public catalog cannot: entries that need
 *   instance setup (`auth: static`, brokered toolkits), a server in development,
 *   a test's fixtures. Replacing rather than merging keeps one answer to where
 *   an entry came from.
 *
 * Composition across files is the read's own concern: every
 * `*.yaml`/`*.yml`/`*.json` in a directory is read in sorted order,
 * validated independently so a diagnostic names its file, and deduped
 * first-wins.
 *
 * Per-instance memoization: `servers()` is cached for the lifetime of
 * the instance so a single tool invocation does not re-read once per
 * lookup. `Runtime.getConnectorCatalog()` returns a fresh instance per
 * request, keeping the lifetime short.
 */

import { join } from "node:path";
import { resolvePluginCatalogConfig } from "../../config/plugin-catalog.ts";
import { log } from "../../observability/log.ts";
import { brokeredRef } from "../runtime/brokered.ts";
import type { ConnectorRef } from "../runtime/types.ts";
import { readIndexCatalog } from "./plugin-index.ts";
import {
  projectServerDetailToCatalogListing,
  serverDetailToCatalogEntry,
  validateServerDetailSafety,
} from "./projection.ts";
import { type CatalogRead, readCatalogEntries } from "./read.ts";
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
  /**
   * The servers `validateServerDetailSafety` refused. They never reach Browse
   * and grant nothing. They are kept for one reader, the runtime's `adminTools`
   * gate: a restriction only narrows, and a connector installed before its
   * entry was refused is still callable, so dropping the restriction with the
   * entry would open its admin-only tools to every member.
   */
  refused: Array<{ file: string; detail: ServerDetail }>;
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
 * The deployment's catalog directory, which replaces the pinned index when
 * set: a mounted ConfigMap (e.g. `/config/connectors`) or any directory of
 * `ServerDetail` files. What writes them is outside the runtime.
 */
export const CATALOG_DIR_ENV = "NB_CURATED_CATALOG_DIR";

/**
 * Where a `ConnectorCatalog` reads: a catalog file or directory, or a function
 * that reads the catalog itself (the pinned plugin index).
 */
export type CatalogLocation = string | (() => Promise<CatalogRead>);

/**
 * The catalog for a runtime whose work directory is `workDir`: the directory
 * `NB_CURATED_CATALOG_DIR` names, else the pinned plugin index, its archives
 * cached under `{workDir}/cache/plugin-catalog`. Throws on a malformed pin.
 */
export function catalogLocation(workDir: string): CatalogLocation {
  const dir = process.env[CATALOG_DIR_ENV]?.trim();
  if (dir) return dir;
  const config = resolvePluginCatalogConfig();
  return () =>
    readIndexCatalog({
      cacheDir: join(workDir, "cache", "plugin-catalog"),
      catalogUrl: config.url,
      pin: config.sha256,
    });
}

/**
 * Boot-time visibility check. An empty catalog is indistinguishable
 * from a working one until a user opens Browse and finds nothing, so
 * say it once at startup with the cause.
 */
export async function warnIfCatalogEmpty(catalog: ConnectorCatalog): Promise<void> {
  const { servers, errors } = await catalog.servers();
  if (servers.length > 0) return;
  const why = errors.length > 0 ? ` (${errors.map((e) => e.message).join("; ")})` : "";
  log.warn(
    `[catalog] the connector catalog resolved to 0 entries${why} — Browse will be empty until ` +
      `the plugin catalog is reachable (NB_PLUGIN_CATALOG_URL) or ${CATALOG_DIR_ENV} names a ` +
      "non-empty directory.",
  );
}

export class ConnectorCatalog {
  /** Memoized `servers()` result for this instance. */
  private cache: Promise<AggregatedServers> | null = null;

  constructor(private location: CatalogLocation) {}

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
   * `ctx.isOAuthClientConfigured` is awaited per static-auth entry to
   * compute `oauthClientConfigured` — DCR / unknown entries skip the probe.
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
        entry.install.oauthClientSetup &&
        ctx?.isOAuthClientConfigured
      ) {
        entry.oauthClientConfigured = await ctx.isOAuthClientConfigured(
          entry.id,
          entry.install.oauthClientSetup.clientSecretKey,
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
   * URL to a catalog entry to render the icon, name, and OAuth client setup
   * affordance. Built once from the cached read.
   */
  async catalogByUrl(): Promise<Map<string, ConnectorCatalogEntry>> {
    const entries = await this.catalogEntries();
    return new Map(entries.map((e) => [e.url, e]));
  }

  /**
   * The Browse listing for one id, matched exactly, or `null` when the catalog
   * lists none. Same projection and first-wins dedupe as `list()`. An install
   * resolves the requested id to this, so what gets installed is the operator's
   * entry and never the caller's copy of it.
   */
  async listingById(id: string): Promise<CatalogListing | null> {
    const { servers } = await this.servers();
    for (const { detail } of servers) {
      if (detail.name !== id) continue;
      const listing = projectServerDetailToCatalogListing(detail);
      if (listing) return listing;
    }
    return null;
  }

  /** Single-entry lookup by reverse-DNS id (used by set_oauth_client handlers). */
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
    const { entries, diagnostics } =
      typeof this.location === "string" ? readCatalogEntries(this.location) : await this.location();

    // A diagnostic carrying an entry `index` is one bad record inside an
    // otherwise-fine file: logged, like every other per-entry drop, and
    // not worth an operator-facing error. A diagnostic without one is a
    // file that could not be read or parsed at all — that is the case
    // where "the catalog looks empty" needs a cause attached to it, so it
    // reaches callers as an error keyed on the file.
    const out: AggregatedServers = { servers: [], refused: [], errors: [] };
    for (const d of diagnostics) {
      if (d.index === undefined) out.errors.push({ file: d.source, message: d.message });
      else if (d.collision) log.error(`[catalog] ${d.message}`);
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
        out.refused.push({ file: source, detail });
        continue;
      }
      out.servers.push({ file: source, detail });
    }
    return out;
  }
}

/**
 * Match an installed connector's ref to its catalog entry. Prefers a URL match;
 * EVERY brokered connector stores a per-install session URL that misses
 * `byUrl`, so they fall back to the catalog id their provider stamped on the
 * ref at install — recovered by `brokeredRef`, which owns the provider list.
 *
 * The fallback must cover each brokered kind: without it the connector reads as
 * uncatalogued — slug instead of display name, letter avatar instead of icon,
 * and every catalog-gated section of the Configure page dark.
 */
export function catalogEntryForRef(
  ref: ConnectorRef,
  byUrl: Map<string, ConnectorCatalogEntry>,
  byId: Map<string, ConnectorCatalogEntry>,
): ConnectorCatalogEntry | undefined {
  const byUrlMatch = ref.url ? byUrl.get(ref.url) : undefined;
  if (byUrlMatch) return byUrlMatch;
  const connectorId = brokeredRef(ref)?.connectorId;
  return connectorId ? byId.get(connectorId) : undefined;
}
