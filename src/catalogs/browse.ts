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
 * **Install still reads the connector list.** Until install fetches the
 * entry's artifact, it re-resolves the row's `id` (its server's registry name)
 * to the server record in the connector list (`ConnectorCatalog`: the pinned
 * `connectors.yaml`, or `NB_CURATED_CATALOG_DIR` when set), as it always has.
 * So a row carries that record's `install` action, and an entry is listed only
 * when it names exactly one server and the connector list holds that server's
 * record. The connector list's records that no listing names (a mounted
 * directory's fleet services and tenant entries) are listed under the reserved
 * catalog `curated`, so nothing an operator mounted leaves Browse.
 */

import { CONNECTOR_LIST_CATALOG_NAME } from "../config/catalogs.ts";
import type { CatalogError, ConnectorCatalog } from "../connectors/catalog/catalog.ts";
import type { BrowseStatus, CatalogListing } from "../connectors/catalog/types.ts";
import { log } from "../observability/log.ts";
import type { ListedEntry } from "./listing.ts";
import { PLUGIN_TYPES } from "./listing.ts";
import type { CatalogListings, CatalogSnapshot } from "./reader.ts";

/** The brokers this instance has, by auth kind. */
export interface Brokers {
  has(id: string): boolean;
}

export interface BrowseDeps {
  listings: CatalogListings;
  /** The connector list install reads server records from. */
  connectorCatalog: ConnectorCatalog;
  brokers: Brokers;
  /** Whether the workspace has the OAuth client a static entry needs; absent outside a workspace. */
  isOAuthClientConfigured?: (catalogId: string, clientSecretKey: string) => Promise<boolean>;
}

/** Browse's rows, and the catalogs or files that could not be read. */
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
  const [snapshots, records, servers] = await Promise.all([
    deps.listings.snapshots(),
    deps.connectorCatalog.listings(),
    deps.connectorCatalog.servers(),
  ]);
  const byName = new Map(records.map((r) => [r.id, r]));
  const configured = oauthProbe(deps);

  const entries: CatalogListing[] = [];
  const named = new Set<string>();
  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries) {
      for (const server of Object.values(entry.servers)) named.add(server.name);
    }
    entries.push(...(await snapshotRows(snapshot, byName, deps.brokers, configured)));
  }
  for (const record of records) {
    if (named.has(record.id)) continue;
    const row = await curatedRow(record, deps.brokers, configured);
    if (row) entries.push(row);
  }

  const errors: CatalogError[] = [
    ...snapshots
      .filter((s) => s.origin === "none" && s.error)
      .map((s) => ({ file: s.catalog.label, message: s.error as string })),
    ...servers.errors,
  ];
  return { entries, errors };
}

/** One catalog's rows; the items it lists that cannot be installed here yet are logged once. */
async function snapshotRows(
  snapshot: CatalogSnapshot,
  records: Map<string, CatalogListing>,
  brokers: Brokers,
  configured: OAuthProbe,
): Promise<CatalogListing[]> {
  const rows: CatalogListing[] = [];
  const skipped: string[] = [];
  for (const entry of snapshot.entries) {
    const row = await listedRow(entry, records, brokers, configured);
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

/** A listed entry's row, null when hidden, or why it cannot be installed here yet. */
async function listedRow(
  entry: ListedEntry,
  records: Map<string, CatalogListing>,
  brokers: Brokers,
  configured: OAuthProbe,
): Promise<CatalogListing | null | string> {
  if (!PLUGIN_TYPES.includes(entry.type)) return `type ${entry.type}`;
  const servers = Object.values(entry.servers);
  if (servers.length !== 1) return `${servers.length} servers`;
  const server = servers[0] as { name: string; auth: string };
  // A broker this instance lacks hides the entry whatever the connector list holds.
  if (browseStatus(server.auth, { brokers }) === "hidden") return null;
  const record = records.get(server.name);
  if (!record) return `no record for ${server.name} in the connector list`;
  const oauthClientConfigured = await configured(record);
  const status = browseStatus(server.auth, { brokers, oauthClientConfigured });
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

/** A connector-list record no listing names, under the reserved catalog; null when hidden. */
async function curatedRow(
  record: CatalogListing,
  brokers: Brokers,
  configured: OAuthProbe,
): Promise<CatalogListing | null> {
  const auth = record.install.kind === "remote-oauth" ? record.install.auth : "none";
  const oauthClientConfigured = await configured(record);
  const status = browseStatus(auth, { brokers, oauthClientConfigured });
  if (status === "hidden") return null;
  return {
    ...record,
    ...(oauthClientConfigured !== undefined ? { oauthClientConfigured } : {}),
    address: `${record.id}@${CONNECTOR_LIST_CATALOG_NAME}`,
    catalog: CONNECTOR_LIST_CATALOG_NAME,
    status,
  };
}
