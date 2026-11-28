/**
 * Browse: what this instance offers to install, built from catalog listings
 * (ADR-0077). Every row comes from a listing entry and is addressed
 * `name@catalog`; no artifact is opened to build it.
 *
 * What a row shows is the entry's: `displayName`, `description`, `tags`, and
 * the extension's `iconUrl` and `category`. Its `status` is derived from the
 * auth its server declares in the extension's `servers` (`browseStatus`):
 *
 * - `ready` for `dcr`, `none` and `provider`, and for a broker this instance
 *   has (a configured `connectors.providers.<id>`);
 * - `setup` for `static` until the workspace has the OAuth client it needs,
 *   which only an admin can add;
 * - hidden, so no row at all, for a broker this instance does not have: it
 *   could never be installed here.
 *
 * Several catalogs sit side by side. The same server listed by two catalogs is
 * a row under each, with no precedence between them.
 *
 * **A row's setup comes from its listing.** Installing a row reads its
 * artifact (`src/tools/plugin-install.ts`), never anything here. A bare
 * connector's row is projected from its own inline record, which carries every
 * setup fact the web asks for before install (a static entry's OAuth client
 * portal and secret key, a broker's fields, secret headers). A plugin's row
 * names its one server's auth in the extension, and only `dcr` and `none` need
 * nothing more; an entry this shape cannot show (no server, several, or setup
 * its listing cannot describe) is left out and logged, and still installs by
 * its address. A publisher lists a server that needs setup as a bare connector.
 */

import type { CatalogError } from "../connectors/catalog/catalog.ts";
import {
  projectServerDetailToCatalogListing,
  validateServerDetailSafety,
} from "../connectors/catalog/projection.ts";
import { type ServerDetail, validateServerDetail } from "../connectors/catalog/server-detail.ts";
import type { BrowseStatus, CatalogListing } from "../connectors/catalog/types.ts";
import { log } from "../observability/log.ts";
import type { ListedEntry } from "./listing.ts";
import { PLUGIN_TYPES, SERVER_RECORD_TYPE } from "./listing.ts";
import type { CatalogListings, CatalogSnapshot } from "./reader.ts";

/** The brokers this instance has, by auth kind. */
export interface Brokers {
  has(id: string): boolean;
}

export interface BrowseDeps {
  listings: CatalogListings;
  brokers: Brokers;
  /** Whether the workspace has the OAuth client a static entry needs; absent outside a workspace. */
  isOAuthClientConfigured?: (catalogId: string, clientSecretKey: string) => Promise<boolean>;
}

/** Browse's rows, and the catalogs that could not be read. */
export interface BrowseResult {
  entries: CatalogListing[];
  errors: CatalogError[];
}

/** Auth kinds that need nothing before an install. */
const READY_AUTH = new Set(["dcr", "none", "provider"]);

/**
 * A row's status from its server's auth: `ready`, `setup`, or `hidden` when
 * this instance cannot install it at all.
 */
export function browseStatus(
  auth: string,
  opts: { brokers: Brokers; oauthClientConfigured?: boolean },
): BrowseStatus | "hidden" {
  if (READY_AUTH.has(auth)) return "ready";
  if (auth === "static") return opts.oauthClientConfigured === true ? "ready" : "setup";
  return opts.brokers.has(auth) ? "ready" : "hidden";
}

/** Snapshots whose "not installable here" entries were already logged, so a refresh logs once. */
const reported = new WeakSet<CatalogSnapshot>();

/** Build Browse from every catalog's listing. Never throws. */
export async function browseCatalog(deps: BrowseDeps): Promise<BrowseResult> {
  const snapshots = await deps.listings.snapshots();
  const configured = oauthProbe(deps);
  const entries: CatalogListing[] = [];
  for (const snapshot of snapshots) {
    entries.push(...(await snapshotRows(snapshot, deps.brokers, configured)));
  }
  const errors: CatalogError[] = snapshots
    .filter((s) => s.origin === "none" && s.error)
    .map((s) => ({ file: s.catalog.label, message: s.error as string }));
  return { entries, errors };
}

/** One catalog's rows; the items it lists that cannot be installed here yet are logged once. */
async function snapshotRows(
  snapshot: CatalogSnapshot,
  brokers: Brokers,
  configured: OAuthProbe,
): Promise<CatalogListing[]> {
  const rows: CatalogListing[] = [];
  const skipped: string[] = [];
  for (const entry of snapshot.entries) {
    const row = await listedRow(entry, brokers, configured);
    if (typeof row === "string") skipped.push(`${entry.address} (${row})`);
    else if (row) rows.push(row);
  }
  if (skipped.length > 0 && !reported.has(snapshot)) {
    reported.add(snapshot);
    log.info(
      `[catalogs] catalog "${snapshot.catalog.name}" lists ${skipped.length} item(s) this instance cannot install yet: ${skipped.join(", ")}`,
    );
  }
  return rows;
}

type OAuthProbe = (record: CatalogListing) => Promise<boolean | undefined>;

/** Whether a static record's OAuth client is configured, asked once per id per Browse. */
function oauthProbe(deps: BrowseDeps): OAuthProbe {
  const memo = new Map<string, Promise<boolean | undefined>>();
  return (record) => {
    const install = record.install;
    if (install.kind !== "remote-oauth" || install.auth !== "static") {
      return Promise.resolve(undefined);
    }
    const setup = install.oauthClientSetup;
    const probe = deps.isOAuthClientConfigured;
    if (!setup || !probe) return Promise.resolve(undefined);
    let pending = memo.get(record.id);
    if (!pending) {
      pending = probe(record.id, setup.clientSecretKey);
      memo.set(record.id, pending);
    }
    return pending;
  };
}

/** A listed entry's row, null when hidden, or why it cannot be shown here. */
async function listedRow(
  entry: ListedEntry,
  brokers: Brokers,
  configured: OAuthProbe,
): Promise<CatalogListing | null | string> {
  const setup = rowSetup(entry);
  if (typeof setup === "string") return setup;
  const { record, auth } = setup;
  // A broker this instance lacks hides the entry.
  if (browseStatus(auth, { brokers }) === "hidden") return null;
  const oauthClientConfigured = await configured(record);
  const status = browseStatus(auth, { brokers, oauthClientConfigured });
  if (status === "hidden") return null;
  return {
    id: record.id,
    name: entry.displayName,
    description: entry.description ?? "",
    ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
    ...(entry.category ? { category: entry.category } : {}),
    ...(entry.tags ? { tags: entry.tags } : {}),
    install: record.install,
    ...(oauthClientConfigured !== undefined ? { oauthClientConfigured } : {}),
    address: entry.address,
    catalog: entry.catalog,
    status,
  };
}

/** Auth kinds whose row needs no setup facts beyond the kind itself. */
const SELF_DESCRIBED_AUTH = new Set(["dcr", "none"]);

/**
 * Where a row's server and setup come from: a bare connector's inline record,
 * else the extension alone when its one server's auth needs no setup. A string
 * says why there is no row.
 */
function rowSetup(entry: ListedEntry): { record: CatalogListing; auth: string } | string {
  if (entry.type === SERVER_RECORD_TYPE) {
    const record = inlineRecord(entry.data);
    if (record?.install.kind !== "remote-oauth") return "an inline record that cannot be installed";
    return { record, auth: record.install.auth };
  }
  if (!PLUGIN_TYPES.includes(entry.type)) return `type ${entry.type}`;
  const servers = Object.values(entry.servers);
  if (servers.length !== 1) return `${servers.length} servers`;
  const server = servers[0] as { name: string; auth: string };
  if (!SELF_DESCRIBED_AUTH.has(server.auth)) {
    return `${server.auth} setup for ${server.name} that a plugin entry cannot describe; list it as a bare connector`;
  }
  return {
    record: {
      id: server.name,
      name: entry.displayName,
      description: entry.description ?? "",
      install: {
        kind: "remote-oauth",
        // What the row stands for: the artifact install reads the server's own URL from.
        url: entry.url ?? "",
        transportType: "streamable-http",
        auth: server.auth,
      },
    },
    auth: server.auth,
  };
}

/** A bare connector's inline `server.json` record as an install action, or null. */
function inlineRecord(data: unknown): CatalogListing | null {
  if (!validateServerDetail(data).valid) return null;
  const detail = data as ServerDetail;
  if (validateServerDetailSafety(detail)) return null;
  return projectServerDetailToCatalogListing(detail);
}
