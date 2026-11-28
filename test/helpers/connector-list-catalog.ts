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
import { projectServerDetailToCatalogListing } from "../../src/connectors/catalog/projection.ts";
import { readCatalogEntries } from "../../src/connectors/catalog/read.ts";

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
