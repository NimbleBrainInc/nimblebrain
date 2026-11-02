/**
 * A minted fleet connector started by boot takes its credential settings from
 * the catalog at every restart, not from the catalog as boot read it.
 *
 * Boot hands each source a catalog reader that the source keeps for its
 * restarts (recovery, health checks). A reader bound to one `ConnectorCatalog`
 * instance would serve the boot-time read forever, since the instance memoizes
 * it: an audience edit would never land and a withdrawn entry would keep
 * minting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import { slugifyServerName } from "../../src/connectors/runtime/paths.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import {
  MINTED_PROVIDER,
  registerBuiltinCredentialProviders,
} from "../../src/oauth/minted-credential-provider.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { registerCredentialProvider } from "../../src/tools/credential-provider.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const ID = "ai.example.fleet/mcp";
// Closed port: no request reaches a server; the provider spy throws first.
const UNREACHABLE = "http://127.0.0.1:1/mcp";

function catalogYaml(audience: string | null): string {
  if (audience === null) return "servers: []\n";
  return `servers:
  - name: ${ID}
    title: Fleet
    description: Test connector
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: ${UNREACHABLE}
    _meta:
      ai.nimblebrain/connector:
        auth: provider
        providerAuth:
          provider: ${MINTED_PROVIDER}
          config:
            audience: ${audience}
            scope: mcp:invoke
`;
}

let workDir: string;
let catalogFile: string;
let priorCatalogDir: string | undefined;

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `nb-boot-minted-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const catalogDir = join(workDir, "catalog");
  mkdirSync(catalogDir, { recursive: true });
  catalogFile = join(catalogDir, "platform.yaml");
  writeFileSync(catalogFile, catalogYaml("catalog-v1"));
  priorCatalogDir = process.env[CATALOG_DIR_ENV];
  process.env[CATALOG_DIR_ENV] = catalogDir;
});

afterEach(() => {
  registerBuiltinCredentialProviders();
  if (priorCatalogDir === undefined) delete process.env[CATALOG_DIR_ENV];
  else process.env[CATALOG_DIR_ENV] = priorCatalogDir;
  rmSync(workDir, { recursive: true, force: true });
});

describe("a boot-started minted connector restarts from the current catalog", () => {
  test("an audience edit reaches the restart, and a withdrawn entry stops it", async () => {
    const installed: ConnectorRef = {
      url: UNREACHABLE,
      serverName: slugifyServerName(ID),
      transport: {
        type: "streamable-http",
        auth: {
          type: "provider",
          provider: MINTED_PROVIDER,
          config: { audience: "stored", scope: "mcp:invoke" },
        },
      },
      oauthScope: "workspace",
    };
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
      // Boot registered the real provider; a spy now records each audience
      // a connection build asks for, then throws before any network access.
      const audiences: unknown[] = [];
      registerCredentialProvider(MINTED_PROVIDER, {
        credentialFor(_ws, config) {
          audiences.push(config.audience);
          throw new Error("spy: no network");
        },
      });
      const source = runtime.getRegistryForWorkspace(ws.id).getSource(installed.serverName);
      expect(source).toBeInstanceOf(McpSource);

      writeFileSync(catalogFile, catalogYaml("catalog-v2"));
      expect(await (source as McpSource).restart()).toBe(false);
      expect(audiences).toEqual(["catalog-v2"]);

      writeFileSync(catalogFile, catalogYaml(null));
      expect(await (source as McpSource).restart()).toBe(false);
      expect(audiences).toEqual(["catalog-v2"]);
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);
});
