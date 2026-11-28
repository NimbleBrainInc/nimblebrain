/**
 * Browse built from catalog listings, end to end (ADR-0077): a runtime booted
 * with `catalogs` reads each listing from a local fixture server in the live
 * catalog's shape and lists its items, addressed `name@catalog`, without
 * fetching any artifact. A `required` catalog without a pin refuses the boot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseCatalog } from "../../src/catalogs/browse.ts";
import type { CatalogConfig } from "../../src/config/catalogs.ts";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { listingBytes, listingEntry } from "../helpers/ai-catalog.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const SERVERS = {
  servers: [
    {
      name: "com.ahrefs/mcp",
      description: "Ahrefs record",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://api.ahrefs.test/mcp" }],
    },
    {
      name: "com.vendor/crm",
      description: "Vendor CRM record",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://crm.vendor.test/mcp" }],
    },
  ],
};

let workDir: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let requests: string[];
let savedDir: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-catalog-listings-"));
  const connectors = join(workDir, "connectors");
  mkdirSync(connectors);
  writeFileSync(join(connectors, "servers.json"), JSON.stringify(SERVERS));
  savedDir = process.env[CATALOG_DIR_ENV];
  process.env[CATALOG_DIR_ENV] = connectors;
  requests = [];
});

afterEach(async () => {
  await server?.stop(true);
  server = null;
  if (savedDir === undefined) delete process.env[CATALOG_DIR_ENV];
  else process.env[CATALOG_DIR_ENV] = savedDir;
  rmSync(workDir, { recursive: true, force: true });
});

/** Serve listings by path, 404 for everything else (a plugin archive included), recording each path. */
function serve(listings: Record<string, Uint8Array>): string {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const body = listings[path];
      return body
        ? new Response(body, { headers: { "content-type": "application/ai-catalog+json" } })
        : new Response("", { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function start(catalogs: unknown) {
  return Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
    // As an operator might write it: the shape is the boot's to check.
    catalogs: catalogs as CatalogConfig[],
  });
}

describe("catalogs", () => {
  test("Browse lists every catalog's items side by side, opening no artifact", async () => {
    const base = serve({
      "/.well-known/ai-catalog.json": listingBytes([
        listingEntry({ name: "ahrefs", category: "Marketing & websites" }),
        listingEntry({
          name: "zoom",
          servers: { zoom: { name: "us.zoom/mcp", auth: "composio" } },
        }),
      ]),
      "/vendor/ai-catalog.json": listingBytes([
        listingEntry({ name: "crm", servers: { crm: { name: "com.vendor/crm", auth: "dcr" } } }),
        listingEntry({ name: "ahrefs" }),
      ]),
    });
    const runtime = await start([
      { source: `${base}/.well-known/ai-catalog.json`, policy: "available", name: "nimblebrain" },
      { source: `${base}/vendor/ai-catalog.json`, policy: "available", name: "vendor" },
    ]);
    try {
      const { entries, errors } = await browseCatalog({
        listings: runtime.getCatalogListings(),
        connectorCatalog: runtime.getConnectorCatalog(),
        brokers: runtime.getManagedConnectorRegistry(),
      });
      expect(errors).toEqual([]);
      expect(entries.map((e) => [e.address, e.id, e.status])).toEqual([
        ["ahrefs@nimblebrain", "com.ahrefs/mcp", "ready"],
        ["crm@vendor", "com.vendor/crm", "ready"],
        ["ahrefs@vendor", "com.ahrefs/mcp", "ready"],
      ]);
      expect(requests.some((p) => p.startsWith("/plugins/"))).toBe(false);
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);

  test("a required catalog without a pin refuses the boot", async () => {
    await expect(
      start([{ source: "https://catalog.example.com/ai-catalog.json", policy: "required" }]),
    ).rejects.toThrow(/required catalog must be pinned/);
  }, 30_000);
});
