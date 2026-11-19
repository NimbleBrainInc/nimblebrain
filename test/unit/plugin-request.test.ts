/**
 * The in-conversation ask for a personal plugin (ADR-0069 "Only the owner
 * grants"): `nb__search` names the caller's own plugins that are off in the
 * run's workspace, and `nb__manage_tools` `request_plugin` asks for one. The ask
 * writes no grant, is refused in an unattended run, and never names another
 * member's plugin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import type { ConnectorCatalogEntry } from "../../src/connectors/catalog/types.ts";
import type { ManagedConnectorRegistry } from "../../src/connectors/providers/registry.ts";
import type { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import type { ToolPromotionControls } from "../../src/engine/types.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { OrchestratorRuntime } from "../../src/orchestrator/route.ts";
import { PermissionStore } from "../../src/permissions/permission-store.ts";
import type { PluginRequestOutput } from "../../src/platform/schemas/plugins.ts";
import { IdentityToolRouter } from "../../src/runtime/identity-tool-router.ts";
import { type RequestContext, runWithRequestContext } from "../../src/runtime/request-context.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import type { ManageConnectorsContext } from "../../src/tools/connector-tools.ts";
import { createManageToolsToolDefs } from "../../src/tools/manage-tools.ts";
import {
  describeUngrantedPlugins,
  discoverUngrantedPlugins,
  requestPlugin,
  ungrantedPluginGuidance,
} from "../../src/tools/plugin-request.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createSystemTools } from "../../src/tools/system-tools.ts";
import type { ToolSource } from "../../src/tools/types.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { stub } from "../helpers/stub.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const ALICE = { id: "usr_alice", email: "alice@example.com" } as UserIdentity;
const BOB = { id: "usr_bob", email: "bob@example.com" } as UserIdentity;
const WS = "ws_003eba8844413cd9";

const CATALOG = [
  { id: "granola", name: "Granola", description: "Meeting notes and transcripts" },
  { id: "gmail", name: "Gmail", description: "Read and send email" },
  { id: "notion", name: "Notion", description: "Pages and meeting notes" },
] as ConnectorCatalogEntry[];

let workDir: string;
let permissions: PermissionStore;
let runtime: Runtime;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-plugin-request-"));
  installTestCredentialStore(workDir);
  permissions = new PermissionStore(workDir);
  const workspaces = new WorkspaceStore(workDir);
  await seedWorkspace(workspaces, WS, {
    name: "Helix",
    members: [
      { userId: ALICE.id, role: "member" },
      { userId: BOB.id, role: "member" },
    ],
  });
  const connectors = new IdentityConnectorStore({ workDir });
  for (const serverName of ["granola", "gmail"]) {
    await connectors.add(ALICE.id, {
      url: `https://mcp.example.com/${serverName}`,
      serverName,
      ui: null,
    });
  }
  // Bob's plugin: never Alice's to see or ask for.
  await connectors.add(BOB.id, {
    url: "https://mcp.example.com/notion",
    serverName: "notion",
    ui: null,
  });
  // Alice's Gmail is already on in this workspace.
  await permissions.grantConnector(ALICE.id, "gmail", WS);

  runtime = stub<Runtime>({
    getWorkDir: () => workDir,
    getPermissionStore: () => permissions,
    getWorkspaceStore: () => workspaces,
    getConnectorCatalog: () => stub<ConnectorCatalog>({ catalogEntries: async () => CATALOG }),
    getManagedConnectorRegistry: () => stub<ManagedConnectorRegistry>({ get: () => undefined }),
    getLifecycle: () => stub<ConnectorLifecycleManager>({ lookUpAccount: async () => null }),
    listDiscoverableTools: async () => [],
  });
});

afterEach(() => {
  resetTestCredentialStore();
  rmSync(workDir, { recursive: true, force: true });
});

/** The context a tool call in a chat run carries, as the run door stamps it. */
function chatContext(identity: UserIdentity, extra: Partial<RequestContext> = {}): RequestContext {
  return { identity, workspaceId: WS, conversationId: "conv_1", ...extra };
}

function pluginCtx(): ManageConnectorsContext {
  return {
    runtime,
    getIdentity: () => null,
    getWorkspaceId: () => null,
  };
}

/** A plugin context reading the caller and workspace from the request, as `createSystemTools` builds it. */
function requestScopedCtx(): ManageConnectorsContext {
  return {
    runtime,
    getIdentity: () => ALICE,
    getWorkspaceId: () => WS,
  };
}

describe("discovery", () => {
  test("names only the caller's own plugins that are off here", async () => {
    const found = await runWithRequestContext(chatContext(ALICE), () =>
      discoverUngrantedPlugins(requestScopedCtx(), ""),
    );
    // Granola is Alice's and off here; Gmail is granted; Notion is Bob's.
    expect(found.map((p) => p.serverName)).toEqual(["granola"]);
    expect(found[0]?.displayName).toBe("Granola");
  });

  test("never names another member's plugin, whatever the query", async () => {
    const found = await runWithRequestContext(chatContext(ALICE), () =>
      discoverUngrantedPlugins(requestScopedCtx(), "notion pages"),
    );
    expect(found).toEqual([]);
  });

  test("names nothing in an unattended run", async () => {
    const found = await runWithRequestContext(chatContext(ALICE, { unattended: true }), () =>
      discoverUngrantedPlugins(requestScopedCtx(), ""),
    );
    expect(found).toEqual([]);
  });

  test("names nothing without a caller or a workspace", async () => {
    expect(await discoverUngrantedPlugins(pluginCtx(), "")).toEqual([]);
  });

  test("nb__search lists the plugin by name, with no tool of it", async () => {
    const systemTools = await createSystemTools(() => new ToolRegistry(), { runtime });
    const result = await runWithRequestContext(chatContext(ALICE), () =>
      systemTools.execute("search", { scope: "tools", query: "meeting notes" }),
    );
    const text = extractText(result.content);
    expect(text).toContain("**granola** (Granola)");
    expect(text).toContain("request_plugin");
    expect(text).not.toContain("notion");
    expect(text).not.toContain("granola__");
    expect(result.structuredContent?.pluginsOffHere).toEqual([
      { name: "granola", displayName: "Granola" },
    ]);
  });

  test("the description tells the model how to ask", () => {
    const text = describeUngrantedPlugins([
      { serverName: "granola", displayName: "Granola", description: null, account: null },
    ]);
    expect(text).toContain('nb__manage_tools `{"request_plugin": "<name>"}`');
  });
});

describe("request_plugin", () => {
  test("asks for the caller's plugin and writes no grant", async () => {
    const result = await runWithRequestContext(chatContext(ALICE), () =>
      requestPlugin(requestScopedCtx(), "granola"),
    );
    expect(result.isError).toBe(false);
    const out = result.structuredContent as PluginRequestOutput;
    expect(out.pluginRequest).toEqual({
      serverName: "granola",
      displayName: "Granola",
      account: null,
      wsId: WS,
      workspaceName: "Helix",
    });
    expect(await permissions.getConnectorGrants(ALICE.id, "granola")).toEqual([]);
  });

  test("is refused in an unattended run", async () => {
    const result = await runWithRequestContext(chatContext(ALICE, { unattended: true }), () =>
      requestPlugin(requestScopedCtx(), "granola"),
    );
    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("A task runs with no one to ask");
    expect(await permissions.getConnectorGrants(ALICE.id, "granola")).toEqual([]);
  });

  test("is refused outside a conversation", async () => {
    const result = await runWithRequestContext({ identity: ALICE, workspaceId: WS }, () =>
      requestPlugin(requestScopedCtx(), "granola"),
    );
    expect(result.isError).toBe(true);
  });

  test("another member's plugin is not found, and nothing of theirs is named", async () => {
    const result = await runWithRequestContext(chatContext(ALICE), () =>
      requestPlugin(requestScopedCtx(), "notion"),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(await permissions.getConnectorGrants(BOB.id, "notion")).toEqual([]);
  });

  test("a plugin already on here is not asked for again", async () => {
    const result = await runWithRequestContext(chatContext(ALICE), () =>
      requestPlugin(requestScopedCtx(), "gmail"),
    );
    expect(result.isError).toBe(true);
  });

  test("nb__manage_tools routes request_plugin, sent alone", async () => {
    const asked: string[] = [];
    const [tool] = createManageToolsToolDefs(undefined, async (name) => {
      asked.push(name);
      return { content: [], isError: false };
    });
    if (!tool) throw new Error("manage_tools not built");
    const alone = await tool.handler({ request_plugin: "granola" });
    expect(alone.isError).toBe(false);
    const mixed = await tool.handler({ request_plugin: "granola", add: ["granola__x"] });
    expect(mixed.isError).toBe(true);
    expect(asked).toEqual(["granola"]);
  });

  test("nb__manage_tools request_plugin reaches the caller's plugin through the nb source", async () => {
    const systemTools = await createSystemTools(() => new ToolRegistry(), { runtime });
    const result = await runWithRequestContext(chatContext(ALICE), () =>
      systemTools.execute("manage_tools", { request_plugin: "granola" }),
    );
    expect(result.isError).toBe(false);
    expect((result.structuredContent as PluginRequestOutput).pluginRequest.serverName).toBe(
      "granola",
    );
    expect(await permissions.getConnectorGrants(ALICE.id, "granola")).toEqual([]);
  });
});

/** What an `add` or a direct call returns for a plugin of the caller's that is off here. */
const ASK_GRANOLA =
  'Granola is your plugin but isn\'t turned on in this workspace. To use it, ask the person with nb__manage_tools `{"request_plugin": "granola"}`';

describe("a name of the caller's plugin that is off here", () => {
  test("names the plugin and how to ask for it", async () => {
    const text = await runWithRequestContext(chatContext(ALICE), () =>
      ungrantedPluginGuidance(requestScopedCtx(), "my_granola__list_notes"),
    );
    expect(text).toStartWith(ASK_GRANOLA);
  });

  test("in an unattended run, says a person must turn it on from Plugins", async () => {
    const text = await runWithRequestContext(chatContext(ALICE, { unattended: true }), () =>
      ungrantedPluginGuidance(requestScopedCtx(), "my_granola__list_notes"),
    );
    expect(text).toContain("Granola is your plugin but isn't turned on in this workspace.");
    expect(text).toContain("a person must turn it on from Plugins");
    expect(text).not.toContain("request_plugin");
  });

  test("anything else keeps the generic answer: another member's, granted, workspace, unknown", async () => {
    for (const name of [
      "my_notion__search",
      "my_gmail__send",
      "granola__list_notes",
      "my_nope__x",
    ]) {
      const text = await runWithRequestContext(chatContext(ALICE), () =>
        ungrantedPluginGuidance(requestScopedCtx(), name),
      );
      expect(text).toBeNull();
    }
  });

  test("nb__manage_tools add: the not-found item says how to ask; other failures stay generic", async () => {
    const notFound = (toolName: string) => ({
      ok: false,
      toolName,
      changed: false,
      reason: "not_found",
      message: `${toolName} was not found in the current tool registry.`,
    });
    const controls: ToolPromotionControls = {
      addTool: async (toolName) => notFound(toolName),
      removeTool: (toolName) => notFound(toolName),
    };
    const systemTools = await createSystemTools(() => new ToolRegistry(), {
      runtime,
      toolPromotionCtx: controls,
    });
    const result = await runWithRequestContext(chatContext(ALICE), () =>
      systemTools.execute("manage_tools", {
        add: ["my_granola__list_notes", "my_notion__search", "crm__search"],
      }),
    );
    const text = extractText(result.content);
    expect(text).toContain(`add my_granola__list_notes: ${ASK_GRANOLA}`);
    expect(text).toContain("add my_notion__search: my_notion__search was not found");
    expect(text).toContain("add crm__search: crm__search was not found");
    expect(text).not.toContain("Notion");
  });

  describe("a direct call through the router", () => {
    const granolaSource = stub<ToolSource>({ name: "granola" });
    function router(): IdentityToolRouter {
      const orchestrator = stub<OrchestratorRuntime>({
        getIdentitySource: () => undefined,
        getIdentityConnectorSource: async (userId: string, name: string) =>
          userId === ALICE.id && name === "granola" ? granolaSource : undefined,
        getPermissionStore: () => permissions,
        // As `Runtime.ungrantedPluginGuidance` answers it.
        ungrantedPluginGuidance: (userId: string, wsId: string, toolName: string) =>
          ungrantedPluginGuidance(requestScopedCtx(), toolName, { callerId: userId, wsId }),
      });
      return new IdentityToolRouter({
        identityId: ALICE.id,
        workspaceId: WS,
        runtime: orchestrator,
        caller: "chat",
      });
    }

    test("grant denied: says how to ask, and keeps the reason", async () => {
      const result = await runWithRequestContext(chatContext(ALICE), () =>
        router().execute({ id: "c1", name: "my_granola__list_notes", input: {} }),
      );
      expect(result.isError).toBe(true);
      expect(extractText(result.content)).toStartWith(ASK_GRANOLA);
      expect(result.structuredContent?.reason).toBe("connector_grant_denied");
    });

    test("grant denied in an unattended run: a person must turn it on", async () => {
      const result = await runWithRequestContext(chatContext(ALICE, { unattended: true }), () =>
        router().execute({ id: "c1", name: "my_granola__list_notes", input: {} }),
      );
      expect(extractText(result.content)).toContain("a person must turn it on from Plugins");
    });

    test("another member's plugin keeps the generic not-found answer", async () => {
      const result = await runWithRequestContext(chatContext(ALICE), () =>
        router().execute({ id: "c1", name: "my_notion__search", input: {} }),
      );
      const text = extractText(result.content);
      expect(result.structuredContent?.reason).toBe("unknown_identity_source");
      expect(text).toContain("no identity source");
      expect(text).not.toContain("Notion");
      expect(text).not.toContain("request_plugin");
    });
  });

  test("nb__status connectors lists the caller's plugins off here, never another member's", async () => {
    const systemTools = await createSystemTools(() => new ToolRegistry(), { runtime });
    const result = await runWithRequestContext(chatContext(ALICE), () =>
      systemTools.execute("status", { scope: "connectors" }),
    );
    const text = extractText(result.content);
    expect(text).toContain("Yours, not turned on in this workspace");
    expect(text).toContain("**granola** (Granola)");
    expect(text).not.toContain("notion");
    expect(text).not.toContain("**gmail**");
  });
});
