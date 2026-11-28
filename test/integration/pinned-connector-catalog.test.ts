/**
 * With no catalog directory mounted, the connector list install reads server
 * records from is the pinned plugin catalog's: fetched at boot from `NB_PLUGIN_CATALOG_URL`, verified against
 * the pin, and cached in the work directory, so a restart with the catalog
 * unreachable lists the same connectors, and a first boot with no catalog and
 * no cache starts with an empty one instead of failing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import { resetPinnedConnectorAttempts } from "../../src/connectors/catalog/pinned.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { OFFLINE_PLUGIN_CATALOG_URL, sha256 } from "../helpers/plugin-catalog.ts";

const LIST = new TextEncoder().encode(`servers:
  - name: com.example/fixture
    title: Fixture
    description: A connector from the fixture catalog
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: https://mcp.example.test/mcp
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
`);
const PIN = sha256(LIST);

const ENV = ["NB_PLUGIN_CATALOG_URL", "NB_PLUGIN_CATALOG_CONNECTORS_SHA256", CATALOG_DIR_ENV];
let saved: Record<string, string | undefined>;
let workDir: string;
let server: ReturnType<typeof Bun.serve> | null;

/** Serve the list at the catalog's current-build path only, as the catalog does today. */
function startCatalog(): string {
  server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/nimblebrain/connectors.yaml"
        ? new Response(LIST, { headers: { "content-type": "application/yaml" } })
        : new Response("", { status: 404 }),
  });
  return `http://127.0.0.1:${server.port}`;
}

async function connectorList(dir: string): Promise<string[]> {
  const runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: dir,
  });
  try {
    return (await runtime.getConnectorCatalog().listings()).map((e) => e.id);
  } finally {
    await runtime.shutdown();
  }
}

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  delete process.env[CATALOG_DIR_ENV];
  process.env.NB_PLUGIN_CATALOG_CONNECTORS_SHA256 = PIN;
  workDir = mkdtempSync(join(tmpdir(), "nb-pinned-catalog-"));
  server = null;
  resetPinnedConnectorAttempts();
});

afterEach(async () => {
  await server?.stop(true);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetPinnedConnectorAttempts();
  rmSync(workDir, { recursive: true, force: true });
});

describe("the pinned connector catalog", () => {
  test("install reads it, and a restart with the catalog unreachable reads the cache", async () => {
    process.env.NB_PLUGIN_CATALOG_URL = startCatalog();
    expect(await connectorList(workDir)).toEqual(["com.example/fixture"]);

    await server?.stop(true);
    server = null;
    process.env.NB_PLUGIN_CATALOG_URL = OFFLINE_PLUGIN_CATALOG_URL;
    resetPinnedConnectorAttempts();
    expect(await connectorList(workDir)).toEqual(["com.example/fixture"]);
  }, 30_000);

  test("a list that does not match the pin is not read", async () => {
    process.env.NB_PLUGIN_CATALOG_URL = startCatalog();
    process.env.NB_PLUGIN_CATALOG_CONNECTORS_SHA256 = "e".repeat(64);
    expect(await connectorList(workDir)).toEqual([]);
  }, 30_000);

  test("no catalog and no cache boots with an empty catalog", async () => {
    process.env.NB_PLUGIN_CATALOG_URL = OFFLINE_PLUGIN_CATALOG_URL;
    expect(await connectorList(workDir)).toEqual([]);
  }, 30_000);
});
