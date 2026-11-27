/**
 * With no catalog directory mounted, Browse lists the servers the pinned plugin
 * index's plugins carry: the index and each archive fetched over HTTP at boot
 * from `NB_PLUGIN_CATALOG_URL`, verified against their digests, and cached in
 * the work directory, so a restart with the catalog unreachable lists the same
 * connectors, and a first boot with no catalog and no cache starts with an
 * empty one instead of failing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import { resetIndexCatalog } from "../../src/connectors/catalog/plugin-index.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import {
  buildCatalog,
  type FixtureCatalog,
  OFFLINE_PLUGIN_CATALOG_URL,
  serverDetail,
} from "../helpers/plugin-catalog.ts";

const ENV = ["NB_PLUGIN_CATALOG_URL", "NB_PLUGIN_CATALOG_SHA256", CATALOG_DIR_ENV];
let saved: Record<string, string | undefined>;
let workDir: string;
let server: ReturnType<typeof Bun.serve> | null;

/** Serve a fixture catalog over HTTP: two connectors, one plugin without a server file. */
function startCatalog(): FixtureCatalog {
  let objects = new Map<string, Uint8Array>();
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const body = objects.get(req.url);
      return body ? new Response(body) : new Response("", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const catalog = buildCatalog(
    [
      {
        name: "fixture",
        servers: { fixture: "com.example/fixture" },
        serverDetails: { fixture: serverDetail("com.example/fixture", { title: "Fixture" }) },
      },
      { name: "no-server-file", servers: { main: "com.example/missing" } },
      {
        name: "second",
        servers: { second: "com.example/second" },
        serverDetails: { second: serverDetail("com.example/second") },
      },
    ],
    { url },
  );
  objects = catalog.objects;
  process.env.NB_PLUGIN_CATALOG_URL = url;
  process.env.NB_PLUGIN_CATALOG_SHA256 = catalog.pin;
  return catalog;
}

async function browse(dir: string): Promise<string[]> {
  const runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: dir,
  });
  try {
    const { entries } = await runtime.getConnectorCatalog().list();
    return entries.map((e) => e.id);
  } finally {
    await runtime.shutdown();
  }
}

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  delete process.env[CATALOG_DIR_ENV];
  workDir = mkdtempSync(join(tmpdir(), "nb-index-catalog-"));
  server = null;
  resetIndexCatalog();
});

afterEach(async () => {
  await server?.stop(true);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetIndexCatalog();
  rmSync(workDir, { recursive: true, force: true });
});

describe("the connector catalog from the plugin index", () => {
  test("Browse lists each plugin's server, and a restart with the catalog unreachable reads the cache", async () => {
    startCatalog();
    expect(await browse(workDir)).toEqual(["com.example/fixture", "com.example/second"]);

    await server?.stop(true);
    server = null;
    process.env.NB_PLUGIN_CATALOG_URL = OFFLINE_PLUGIN_CATALOG_URL;
    resetIndexCatalog();
    expect(await browse(workDir)).toEqual(["com.example/fixture", "com.example/second"]);
  }, 30_000);

  test("an index that does not match the pin is not listed", async () => {
    startCatalog();
    process.env.NB_PLUGIN_CATALOG_SHA256 = "e".repeat(64);
    expect(await browse(workDir)).toEqual([]);
  }, 30_000);

  test("no catalog and no cache boots with an empty catalog", async () => {
    process.env.NB_PLUGIN_CATALOG_URL = OFFLINE_PLUGIN_CATALOG_URL;
    expect(await browse(workDir)).toEqual([]);
  }, 30_000);
});
