/**
 * `ConnectorCatalog` is the connector list: the server records (`ServerDetail`,
 * the shape the upstream MCP registry publishes) that binding, the Configure
 * page and the installed list read.
 *
 * It composes its sources, projects the records, and serves the lookup tables
 * the Configure page and the installed list read. Browse is built from catalog
 * listings (`src/catalogs/browse.ts`) and reads nothing here; installing a
 * catalog item reads its artifact.
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
 *    inline, verified against the entry's digest and safety-scrubbed
 *    (`listedServerRecords`). A connector installed before records existed,
 *    which no plugin adopted, reads its record here.
 * 3. **The owner's plain connections' view.** A connection no plugin created,
 *    whose server exactly one plugin entry of the listings names and serves at
 *    its endpoint, reads that entry's verified artifact's record
 *    (`src/catalogs/plain-records.ts`). Read only: it is no install record.
 *
 * A catalog built for no owner is source 2 alone.
 *
 * Per-instance memoization: `servers()` is cached for the lifetime of
 * the instance so a single tool invocation does not re-read once per
 * lookup. `Runtime.getConnectorCatalog()` returns a fresh instance per
 * request, keeping the lifetime short.
 */

import { log } from "../../observability/log.ts";
import { brokeredRef } from "../runtime/brokered.ts";
import type { ConnectorRef } from "../runtime/types.ts";
import { projectServerDetailToCatalogListing, serverDetailToCatalogEntry } from "./projection.ts";
import type { ServerDetail } from "./server-detail.ts";
import type { CatalogListing, ConnectorCatalogEntry } from "./types.ts";

/** Raw-shape result for callers that need `ServerDetail[]` directly. */
export interface AggregatedServers {
  /**
   * Each server tagged with where it came from (`plugin <address>` or
   * `listing <address>`), so downstream callers can thread provenance into
   * structured logs.
   */
  servers: Array<{ file: string; detail: ServerDetail }>;
  /**
   * The listed records `validateServerDetailSafety` refused. They never reach
   * Browse and grant nothing. They are kept for one reader, the runtime's
   * `adminTools` gate: a restriction only narrows, and a connector installed
   * before its entry was refused is still callable, so dropping the
   * restriction with the entry would open its admin-only tools to every member.
   */
  refused: Array<{ file: string; detail: ServerDetail }>;
}

/**
 * A catalog source that could not be read, as Browse reports it: keyed on the
 * source, so an operator reading it knows exactly what to open.
 */
export interface CatalogError {
  file: string;
  message: string;
}

/**
 * The server records one owner's installed plugins supplied (ADR-0077), each
 * tagged with the plugin that supplied it, in that owner's install order. Read
 * ahead of the listings, so what an owner's connection reads is its own
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

/** What a record read for a plain connection names as its file. */
const VIEWED_FILE_PREFIX = "view ";

type Tagged = { file: string; detail: ServerDetail; refused?: true };

export class ConnectorCatalog {
  /** Memoized `servers()` result for this instance. */
  private cache: Promise<AggregatedServers> | null = null;

  /** The listings' read, shared with every view {@link forOwner} makes. */
  private list: { read: Promise<Tagged[]> | null } = { read: null };

  constructor(
    private listed?: ListedServerRecords,
    private installed?: InstalledServerRecords,
    private viewed?: InstalledServerRecords,
  ) {}

  /**
   * The same list as `installed`'s owner sees it, sharing this instance's read
   * of the listings: a sweep over many owners reads them once. `viewed` is
   * that owner's plain connections' records, read after the listings.
   */
  forOwner(installed: InstalledServerRecords, viewed?: InstalledServerRecords): ConnectorCatalog {
    const view = new ConnectorCatalog(this.listed, installed, viewed);
    view.list = this.list;
    return view;
  }

  /**
   * Every record, tagged with where it came from. Memoized per instance, so
   * repeated calls within one request share a single read.
   */
  async servers(): Promise<AggregatedServers> {
    if (!this.cache) this.cache = this.read();
    return this.cache;
  }

  /**
   * Every installable record as an install action's listing, first wins by id.
   * A record that is not installable (no remote, an unsupported transport) is
   * logged and left out.
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
    const [installed, listed] = await Promise.all([
      readTagged(this.installed, INSTALLED_FILE_PREFIX),
      this.readListed(),
    ]);
    const installedNames = new Set(installed.map((s) => s.detail.name));
    const fromListings = listed.filter((l) => !installedNames.has(l.detail.name));
    // Read only when no other source names the server: a view never shadows a record.
    const named = new Set([...installedNames, ...listed.map((l) => l.detail.name)]);
    const viewed = (await readTagged(this.viewed, VIEWED_FILE_PREFIX)).filter(
      (v) => !named.has(v.detail.name),
    );
    const strip = ({ file, detail }: Tagged) => ({ file, detail });
    return {
      servers: [...installed, ...fromListings.filter((l) => !l.refused), ...viewed].map(strip),
      refused: fromListings.filter((l) => l.refused).map(strip),
    };
  }

  /** The listings' records alone, read once for this instance and every view sharing it. */
  private readListed(): Promise<Tagged[]> {
    if (!this.list.read) this.list.read = readTagged(this.listed, LISTED_FILE_PREFIX);
    return this.list.read;
  }
}

/** One tagged source's records, first per name; each was validated where it was read. */
async function readTagged(
  source: ListedServerRecords | undefined,
  prefix: string,
): Promise<Tagged[]> {
  if (!source) return [];
  const seen = new Set<string>();
  const out: Tagged[] = [];
  for (const { address, detail, refused } of await source()) {
    if (seen.has(detail.name)) continue;
    seen.add(detail.name);
    out.push({ file: `${prefix}${address}`, detail, ...(refused ? { refused } : {}) });
  }
  return out;
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
