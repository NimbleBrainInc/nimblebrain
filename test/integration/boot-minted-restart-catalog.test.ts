/**
 * A minted fleet connector started by boot takes its credential settings from
 * its connector list at every restart, not from the list as boot read it.
 *
 * Boot hands each source a catalog reader that the source keeps for its
 * restarts (recovery, health checks). A reader bound to one `ConnectorCatalog`
 * instance would serve the boot-time read forever, since the instance memoizes
 * it. The connector was installed from a path catalog of bare connectors
 * before records existed, so boot adopts it into that entry's plugin: from then
 * on its record says what it connects with. A listing edit moves it only when
 * the plugin is updated, and an entry withdrawn from an available catalog
 * leaves it installed (the fleet authorizer's grants decide whether it mints).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugifyServerName } from "../../src/connectors/runtime/paths.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import {
  MINTED_PROVIDER,
  registerBuiltinCredentialProviders,
} from "../../src/oauth/minted-credential-provider.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createManageConnectorsTool } from "../../src/tools/connector-tools.ts";
import { registerCredentialProvider } from "../../src/tools/credential-provider.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { connectorListCatalogs } from "../helpers/connector-list-catalog.ts";
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

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `nb-boot-minted-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const catalogDir = join(workDir, "catalog");
  mkdirSync(catalogDir, { recursive: true });
  catalogFile = join(catalogDir, "platform.yaml");
  writeFileSync(catalogFile, catalogYaml("catalog-v1"));
});

afterEach(() => {
  registerBuiltinCredentialProviders();
  rmSync(workDir, { recursive: true, force: true });
});

describe("a boot-started minted connector restarts from the current catalog", () => {
  test("an audience edit reaches its connections through an update, and a withdrawn entry leaves it", async () => {
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
    const admin = {
      id: "usr_fleet_admin",
      email: "admin@example.test",
      displayName: "Admin",
      orgRole: "member" as const,
      preferences: {},
    };
    const ws = await store.create("Fleet", { members: [{ userId: admin.id, role: "admin" }] });
    await store.update(ws.id, { connectors: [installed] });

    const runtime = await Runtime.start({
      catalogs: connectorListCatalogs(join(workDir, "catalog")),
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

      const edit = async (yaml: string) => {
        writeFileSync(catalogFile, yaml);
        connectorListCatalogs(join(workDir, "catalog"));
        await runtime.getCatalogListings().refresh();
      };
      // Adopted at boot: the record holds the audience the listing had then.
      const address = `${slugifyServerName(ID)}@test`;
      const adopted = await runtime.getWorkspaceStore().get(ws.id);
      expect(adopted?.connectors[0]?.installedBy).toBe(address);
      expect(await (source as McpSource).restart()).toBe(false);
      expect(audiences).toEqual(["catalog-v1"]);

      // An edit is an update available; the restart keeps the record's audience.
      await edit(catalogYaml("catalog-v2"));
      expect(await (source as McpSource).restart()).toBe(false);
      expect(audiences).toEqual(["catalog-v1", "catalog-v1"]);

      // Applied, the connector list the next connect reads holds the new record.
      const tool = createManageConnectorsTool({
        runtime,
        getIdentity: () => admin,
        getWorkspaceId: () => ws.id,
      });
      const updated = await tool.handler({ action: "update_plugin", address });
      expect(updated.isError).toBe(false);
      const audience = async () => {
        const { servers } = await runtime
          .getConnectorCatalog({ kind: "workspace", wsId: ws.id })
          .servers();
        const meta = servers.find((x) => x.detail.name === ID)?.detail._meta?.[
          "ai.nimblebrain/connector"
        ] as { providerAuth?: { config?: { audience?: string } } } | undefined;
        return meta?.providerAuth?.config?.audience;
      };
      expect(await audience()).toBe("catalog-v2");

      // Withdrawn from an available catalog: still installed, still its record.
      await edit(catalogYaml(null));
      expect(await audience()).toBe("catalog-v2");
      expect((await runtime.getWorkspaceStore().get(ws.id))?.plugins?.[0]?.address).toBe(address);
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);
});
