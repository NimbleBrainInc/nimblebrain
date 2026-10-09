/**
 * A placement the catalog gains after a connector was installed reaches that
 * connector at the next boot, without a reinstall.
 *
 * Install stores the catalog's host UI on the connector's record. Registering
 * placements from that stored copy alone would leave the placement registry —
 * what the sidebar, the route table and the connector settings page read — with
 * the shape the catalog had on the day of install.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import { slugifyServerName } from "../../src/connectors/runtime/paths.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const ID = "ai.example.outbound/mcp";
// Closed port: the start fails fast and the connector is still seeded.
const UNREACHABLE = "http://127.0.0.1:1/mcp";

const CATALOG = `servers:
  - name: ${ID}
    title: Outbound
    description: Test connector
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: ${UNREACHABLE}
    _meta:
      ai.nimblebrain/connector:
        auth: dcr
      ai.nimblebrain/host:
        host_version: "1.4"
        name: Outbound
        icon: crosshair
        placements:
          - slot: sidebar.apps
            resourceUri: ui://outbound/main
            route: outbound
          - slot: settings
            resourceUri: ui://outbound/settings
`;

let workDir: string;
let priorCatalogDir: string | undefined;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `nb-boot-catalog-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const catalogDir = join(workDir, "catalog");
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(catalogDir, "platform.yaml"), CATALOG);
  priorCatalogDir = process.env[CATALOG_DIR_ENV];
  process.env[CATALOG_DIR_ENV] = catalogDir;
});

afterEach(() => {
  if (priorCatalogDir === undefined) delete process.env[CATALOG_DIR_ENV];
  else process.env[CATALOG_DIR_ENV] = priorCatalogDir;
  rmSync(workDir, { recursive: true, force: true });
});

describe("boot takes an installed connector's host UI from the catalog", () => {
  test("registers a settings placement the catalog gained after install", async () => {
    // The record as the install left it: the sidebar placement only.
    const installed = {
      url: UNREACHABLE,
      serverName: slugifyServerName(ID),
      transport: { type: "streamable-http", auth: { type: "bearer", token: "test-token" } },
      oauthScope: "workspace",
      ui: {
        name: "Outbound",
        icon: "crosshair",
        placements: [
          { slot: "sidebar.apps", resourceUri: "ui://outbound/main", route: "outbound" },
        ],
      },
    } as unknown as ConnectorRef;
    const store = new WorkspaceStore(workDir);
    const ws = await store.create("Fleet");
    await store.update(ws.id, { connectors: [installed] });

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      logging: { disabled: true },
      allowInsecureRemotes: true,
      workDir,
    });
    try {
      const uris = runtime
        .getPlacementRegistry()
        .forWorkspace(ws.id)
        .map((p) => p.resourceUri);
      expect(uris).toContain("ui://outbound/main");
      expect(uris).toContain("ui://outbound/settings");
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);
});
