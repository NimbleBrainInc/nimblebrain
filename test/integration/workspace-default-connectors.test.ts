/**
 * `connectors.workspaceDefaults` installs its catalog connectors into every new
 * workspace, on both creation paths: the workspace bootstrap provisions for a
 * user with none, and one an org admin creates with `manage_workspaces`. A
 * connector that needs sign-in lands unconnected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleBootstrap } from "../../src/api/handlers.ts";
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import { _resetConnectorsConfigForTest } from "../../src/connectors/providers/config.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createManageWorkspacesTool } from "../../src/tools/workspace-mgmt-tools.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const NOTION_ID = "com.notion/mcp";
const NOTION_SERVER = "com-notion-mcp";

let workDir: string;
let runtime: Runtime;
let priorCatalogDir: string | undefined;

beforeEach(async () => {
  priorCatalogDir = process.env[CATALOG_DIR_ENV];
  process.env[CATALOG_DIR_ENV] = CONNECTOR_FIXTURE_DIR;
  workDir = join(tmpdir(), `nb-ws-defaults-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir,
    connectors: { workspaceDefaults: [NOTION_ID] },
  });
});

afterEach(async () => {
  await runtime.shutdown();
  _resetConnectorsConfigForTest();
  if (priorCatalogDir === undefined) delete process.env[CATALOG_DIR_ENV];
  else process.env[CATALOG_DIR_ENV] = priorCatalogDir;
  rmSync(workDir, { recursive: true, force: true });
});

async function serverNames(wsId: string): Promise<string[]> {
  const ws = await runtime.getWorkspaceStore().get(wsId);
  return (ws?.connectors ?? []).flatMap((c) =>
    "serverName" in c && c.serverName ? [c.serverName] : [],
  );
}

describe("workspace default connectors", () => {
  test("a workspace bootstrap provisions starts with the defaults, unconnected", async () => {
    const identity: UserIdentity = {
      id: "user_new",
      email: "user_new@example.test",
      displayName: "New User",
      orgRole: "member",
      preferences: {},
    };
    const res = await handleBootstrap(runtime, identity);
    const body = (await res.json()) as {
      activeWorkspace: string;
      workspaces: Array<{ id: string; connectorCount: number }>;
    };

    expect(await serverNames(body.activeWorkspace)).toEqual([NOTION_SERVER]);
    // Bootstrap reports the workspace as it is once the defaults are in.
    expect(body.workspaces[0]?.connectorCount).toBe(1);
    const instance = runtime.getLifecycle().getInstance(NOTION_SERVER, body.activeWorkspace);
    expect(instance?.state).toBe("not_authenticated");
  });

  test("a workspace created with explicit connectors keeps both them and the defaults", async () => {
    const admin: UserIdentity = {
      id: "user_admin",
      email: "user_admin@example.test",
      displayName: "Admin",
      orgRole: "admin",
    };
    const tool = createManageWorkspacesTool({
      getIdentity: () => admin,
      workspaceStore: runtime.getWorkspaceStore(),
      runtime,
    });
    const result = await tool.handler({
      action: "create",
      name: "Team",
      connectors: [{ url: "https://mcp.example.test/mcp", serverName: "example" }],
    });
    expect(result.isError).toBeFalsy();
    const created = (result.structuredContent as { workspace: { id: string } }).workspace;

    expect((await serverNames(created.id)).sort()).toEqual([NOTION_SERVER, "example"]);
  });
});
