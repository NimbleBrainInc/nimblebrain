/**
 * A test's connector list (a directory of `{servers: [...]}` files) as the
 * path catalog a runtime reads it from: each installable server a bare
 * connector, as `bun run catalog:convert` writes it. Unlike the converter, an
 * entry the runtime would drop is left out rather than failing, since some
 * fixtures list one on purpose.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aiCatalogFromServers } from "../../scripts/lib/connector-list-to-ai-catalog.ts";
import { type CatalogListings, createCatalogListings } from "../../src/catalogs/reader.ts";
import { type CatalogConfig, resolveCatalogs } from "../../src/config/catalogs.ts";
import { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import {
  projectServerDetailToCatalogListing,
  validateServerDetailSafety,
} from "../../src/connectors/catalog/projection.ts";
import { readCatalogEntries } from "../../src/connectors/catalog/read.ts";
import { slugifyServerName } from "../../src/connectors/runtime/paths.ts";
import { createPluginRecordStore } from "../../src/plugins/installed/record.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import type { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

/** The catalog name a converted test connector list is addressed by. */
export const CONNECTOR_LIST_TEST_CATALOG = "test";

/**
 * Write `connectorDir`'s servers as a listing beside it and return the
 * `catalogs` block that reads it.
 */
export function connectorListCatalogs(
  connectorDir: string,
  outDir: string = join(dirname(connectorDir), "connector-listing"),
): CatalogConfig[] {
  const servers = readCatalogEntries(connectorDir)
    .entries.map((e) => e.detail)
    .filter((d) => projectServerDetailToCatalogListing(d) !== null);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "ai-catalog.json"),
    JSON.stringify(aiCatalogFromServers(servers, { publisher: "catalog.test" })),
  );
  return [{ source: outDir, policy: "available", name: CONNECTOR_LIST_TEST_CATALOG }];
}

/**
 * The listings reader over `connectorDir` converted, for a fake runtime's
 * `getCatalogListings`. The listing and its cache are written under `outDir`.
 */
export function connectorListListings(connectorDir: string, outDir: string): CatalogListings {
  const [catalog] = connectorListCatalogs(connectorDir, join(outDir, "listing"));
  return createCatalogListings({
    catalogs: resolveCatalogs([catalog as CatalogConfig]),
    cacheDir: join(outDir, "cache"),
  });
}

/**
 * A connector list built from a test's connector list (a directory or file of
 * `{servers: [...]}`) as a runtime reads a listing's bare connectors: each
 * server a listed record, one the safety scrub refuses marked `refused`. For a
 * fake runtime's `getConnectorCatalog`.
 */
export function connectorListCatalog(connectorDir: string): ConnectorCatalog {
  return new ConnectorCatalog(async () =>
    readCatalogEntries(connectorDir).entries.map(({ detail }) => ({
      address: `${slugifyServerName(detail.name)}@${CONNECTOR_LIST_TEST_CATALOG}`,
      detail,
      ...(validateServerDetailSafety(detail) ? { refused: true as const } : {}),
    })),
  );
}

/**
 * What a fake runtime needs to install from a test's connector list the way a
 * runtime does: the list converted to a path catalog (read afresh on each
 * call, so a test may write its list after building the harness), installed
 * by address or unique id as a one-item plugin, with its record kept beside
 * the owner's connectors.
 */
export function connectorListPluginRuntime(
  connectorDir: string,
  deps: { workDir: string; workspaces: WorkspaceStore },
): Pick<
  Runtime,
  "getConnectorCatalog" | "getCatalogListings" | "getPluginRecords" | "withPendingServerRecords"
> {
  const records = createPluginRecordStore({ workspaces: deps.workspaces, workDir: deps.workDir });
  let reads = 0;
  return {
    getConnectorCatalog: () => connectorListCatalog(connectorDir),
    getCatalogListings: () =>
      connectorListListings(connectorDir, join(deps.workDir, `connector-list-${reads++}`)),
    getPluginRecords: () => records,
    withPendingServerRecords: (_owner, _records, fn) => fn(),
  };
}
