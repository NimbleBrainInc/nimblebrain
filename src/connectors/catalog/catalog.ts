/**
 * `ConnectorCatalog` is the connector list: the server records (`ServerDetail`,
 * the shape the upstream MCP registry publishes) that install, binding and the
 * Configure page read.
 *
 * It reads its sources, validates and safety-scrubs every entry, projects the
 * survivors, and serves the lookup tables the Configure page and the installed
 * list read. Browse is built from catalog listings (`src/catalogs/browse.ts`)
 * and reads nothing here; installing a catalog item reads its artifact.
 *
 * **Sources, first per name wins:**
 *
 * 1. **An owner's installed plugins' records.** A plugin installed from a
 *    catalog (ADR-0077) carries each server's record in its artifact, and its
 *    installed record keeps it. A catalog built for one owner (a workspace or
 *    a person, `Runtime.getConnectorCatalog(owner)`) reads that owner's records
 *    first, in its install order, so a connection reads the record of the
 *    plugin its own owner installed, never another owner's.
 * 2. **The listings' bare connectors.** Each configured catalog's entries of
 *    type `application/vnd.nimblebrain.server+json` carry a server record
 *    inline, verified against the entry's digest (`listedServerRecords`). A
 *    connector installed before records existed, which no plugin adopted,
 *    reads its record here.
 * 3. **The pinned plugin catalog's connector list**: the list of the catalog
 *    at `NB_PLUGIN_CATALOG_URL` (catalog.nimblebrain.ai), verified against the
 *    image's pin and cached in the work directory (`pinned.ts`).
 *
 * A catalog built for no owner is sources 2 and 3.
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
import { type CatalogFile, loadPinnedConnectors } from "./pinned.ts";
import {
  projectServerDetailToCatalogListing,
  serverDetailToCatalogEntry,
  validateServerDetailSafety,
} from "./projection.ts";
import { readCatalogEntries } from "./read.ts";
import type { ServerDetail } from "./server-detail.ts";
import type { CatalogListing, ConnectorCatalogEntry } from "./types.ts";

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
 * Where a `ConnectorCatalog` reads: a catalog file or directory, or a function
 * that produces the file (the pinned catalog, fetched on first read).
 */
export type CatalogLocation = string | (() => Promise<CatalogFile>);

/**
 * The pinned plugin catalog's connector list for a runtime whose work
 * directory is `workDir`, cached under `{workDir}/cache/plugin-catalog`.
 * Throws on a malformed pin.
 */
export function catalogLocation(workDir: string): CatalogLocation {
  const config = resolvePluginCatalogConfig();
  return () =>
    loadPinnedConnectors({
      cacheDir: join(workDir, "cache", "plugin-catalog"),
      catalogUrl: config.url,
      sha256: config.connectorsSha256,
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
    `[catalog] the connector list resolved to 0 entries${why} — an installed connector that ` +
      `no plugin record or listing describes reads no catalog record until the plugin ` +
      `catalog is reachable (NB_PLUGIN_CATALOG_URL).`,
  );
}

/**
 * The server records one owner's installed plugins supplied (ADR-0077), each
 * tagged with the plugin that supplied it, in that owner's install order. Read
 * ahead of the connector list, so what an owner's connection reads is its own
 * plugin's record.
 */
export type InstalledServerRecords = () => Promise<
  Array<{ address: string; detail: ServerDetail }>
>;

/**
 * The server records the configured listings carry inline, as bare
 * connectors, each tagged with its entry's address: verified against the
 * entry's digest and validated (`listedServerRecords`). One the safety scrub
 * refused is `refused`, read only for its `adminTools` restriction.
 */
export type ListedServerRecords = () => Promise<
  Array<{ address: string; detail: ServerDetail; refused?: true }>
>;

/** What a record an installed plugin supplied names as its file. */
const INSTALLED_FILE_PREFIX = "plugin ";

/** What a record a listing carries names as its file. */
const LISTED_FILE_PREFIX = "listing ";

export class ConnectorCatalog {
  /** Memoized `servers()` result for this instance. */
  private cache: Promise<AggregatedServers> | null = null;

  /** The operator list's read, shared with every view {@link forOwner} makes. */
  private list: { read: Promise<AggregatedServers> | null } = { read: null };

  constructor(
    private location: CatalogLocation,
    private installed?: InstalledServerRecords,
    private listed?: ListedServerRecords,
  ) {}

  /**
   * The same list as `installed`'s owner sees it, sharing this instance's read
   * of the operator's list: a sweep over many owners reads the list once.
   */
  forOwner(installed: InstalledServerRecords): ConnectorCatalog {
    const view = new ConnectorCatalog(this.location, installed, this.listed);
    view.list = this.list;
    return view;
  }

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
   * Every installable record as an install action's listing, first wins by id:
   * what `listingById` resolves. A record that is not installable (no remote,
   * an unsupported transport) is logged and left out.
   */
  async listings(): Promise<CatalogListing[]> {
    const { servers } = await this.servers();
    const out = new Map<string, CatalogListing>();
    for (const { file, detail } of servers) {
      const listing = projectServerDetailToCatalogListing(detail);
      if (!listing) {
        log.warn(
          `[catalog] [${file}] entry "${detail.name}" dropped — not installable as a remote MCP server`,
        );
        continue;
      }
      if (!out.has(listing.id)) out.set(listing.id, listing);
    }
    return [...out.values()];
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
   * The install action's listing for one id, matched exactly, or `null` when the
   * list holds none. The same projection and first-wins rule Browse uses. An install
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
    this.list = { read: null };
  }

  // ── internals ────────────────────────────────────────────────────

  private async read(): Promise<AggregatedServers> {
    const [installed, listed, list] = await Promise.all([
      this.readTagged(this.installed, INSTALLED_FILE_PREFIX),
      this.readTagged(this.listed, LISTED_FILE_PREFIX),
      this.readList(),
    ]);
    const installedNames = new Set(installed.map((s) => s.detail.name));
    const fromListings = listed.filter((l) => !installedNames.has(l.detail.name));
    const ahead = [...installed, ...fromListings.filter((l) => !l.refused)];
    const refusedAhead = fromListings.filter((l) => l.refused);
    if (ahead.length === 0 && refusedAhead.length === 0) return list;
    // A name a listing names, refused or not, is the listing's: the list's copy is shadowed.
    const named = new Set([...ahead, ...refusedAhead].map((s) => s.detail.name));
    const strip = ({ file, detail }: { file: string; detail: ServerDetail }) => ({ file, detail });
    return {
      servers: [...ahead.map(strip), ...list.servers.filter((s) => !named.has(s.detail.name))],
      refused: [
        ...refusedAhead.map(strip),
        ...list.refused.filter((s) => !named.has(s.detail.name)),
      ],
      errors: list.errors,
    };
  }

  /** The operator's list alone, read once for this instance and every view sharing it. */
  private readList(): Promise<AggregatedServers> {
    if (!this.list.read) this.list.read = this.readListOnce();
    return this.list.read;
  }

  private async readListOnce(): Promise<AggregatedServers> {
    const file: CatalogFile =
      typeof this.location === "string" ? { path: this.location } : await this.location();
    if ("error" in file) {
      return { servers: [], refused: [], errors: [{ file: file.source, message: file.error }] };
    }
    const { entries, diagnostics } = readCatalogEntries(file.path);

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

  /** One tagged source's records, first per name; each was validated where it was read. */
  private async readTagged(
    source: ListedServerRecords | undefined,
    prefix: string,
  ): Promise<Array<{ file: string; detail: ServerDetail; refused?: true }>> {
    if (!source) return [];
    const seen = new Set<string>();
    const out: Array<{ file: string; detail: ServerDetail; refused?: true }> = [];
    for (const { address, detail, refused } of await source()) {
      if (seen.has(detail.name)) continue;
      seen.add(detail.name);
      out.push({ file: `${prefix}${address}`, detail, ...(refused ? { refused } : {}) });
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
