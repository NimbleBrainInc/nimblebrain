/**
 * Unit tests for the personal-connector grant actions on `manage_connectors`:
 * `grant_connector`, `revoke_connector`, `list_personal_connectors`.
 *
 * A grant lets the caller use one of THEIR OWN personal connectors (installed on
 * their identity) inside a workspace they belong to — any workspace, including
 * their own personal one (a personal workspace is just a workspace). It is
 * written to the caller's own grant ledger and is per-granter — no admin gate.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AccountLookup } from "../../src/connectors/catalog/account-lookup.ts";
import type { ConnectorCatalogEntry } from "../../src/connectors/catalog/types.ts";
import {
  readComposioConnection,
  saveComposioConnection,
} from "../../src/connectors/providers/composio/connection.ts";
import { createComposioProvider } from "../../src/connectors/providers/composio/provider.ts";
import { slugifyServerName } from "../../src/connectors/runtime/paths.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { PermissionStore } from "../../src/permissions/permission-store.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { McpOAuthRecords } from "../../src/tools/mcp-oauth-records.ts";
import type { ToolSource } from "../../src/tools/types.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const ALICE: UserIdentity = {
  id: "usr_alice",
  email: "alice@example.com",
  displayName: "Alice",
} as UserIdentity;

const SHARED_WS = "ws_003eba8844413cd9";
/** A workspace only Alice belongs to. */
const personalWs = "ws_0015146e7514bc0c";

interface Harness {
  workDir: string;
  store: PermissionStore;
  tool: ReturnType<typeof createManageConnectorsTool>;
}

async function buildHarness(opts: {
  identity?: UserIdentity | null;
  personalConnectors?: string[];
  /** Personal connectors brokered by Composio, keyed by the catalog connector id. */
  composioConnectors?: string[];
  memberOfShared?: boolean;
  /** Same-pod probe result — `true` makes every listed connector read `running`. */
  connectorRunning?: boolean;
  /** The workspace the call is made in (the request URL's). */
  wsId?: string;
  /** Connectors installed as workspace connectors, keyed `serverName` → wsIds. */
  workspaceInstalls?: Record<string, string[]>;
  /** Tool names each running workspace source lists, keyed `serverName`. */
  workspaceTools?: Record<string, string[]>;
  /**
   * Tool names each personal connector's source lists once started, keyed
   * `serverName`; `"fails"` makes its start throw, `"unstarted"` returns a source
   * whose tools/list throws. Absent → no such source.
   */
  identityTools?: Record<string, string[] | "fails" | "unstarted">;
  /** The operator's catalog entries. Absent → an empty catalog. */
  catalog?: ConnectorCatalogEntry[];
  /** What the lifecycle's account lookup answers for a live source; counts its calls. */
  lookUpAccount?: (serverName: string, lookup: AccountLookup) => Promise<string | null>;
}): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-connector-grants-"));
  // `list_personal_connectors` derives `authed` from the OAuth token record,
  // which the credential store answers.
  installTestCredentialStore(workDir);
  const store = new PermissionStore(workDir);
  const workspaceStore = new WorkspaceStore(workDir);
  await seedWorkspace(workspaceStore, SHARED_WS, { name: "Helix" });
  if (opts.memberOfShared !== false) {
    await workspaceStore.addMember(SHARED_WS, ALICE.id, "member");
  }
  // A workspace only the caller belongs to — just a workspace.
  await seedWorkspace(workspaceStore, personalWs, {
    name: "Alice's workspace",
    members: [{ userId: ALICE.id, role: "admin" }],
  });

  // Personal connectors live on the identity plane — both grant and
  // list_personal_connectors read the IdentityConnectorStore.
  const connectorStore = new IdentityConnectorStore({ workDir });
  for (const serverName of opts.personalConnectors ?? []) {
    await connectorStore.add(ALICE.id, {
      url: `https://mcp.example.com/${serverName}`,
      serverName,
      ui: null,
    });
  }

  for (const connectorId of opts.composioConnectors ?? []) {
    await connectorStore.add(ALICE.id, {
      url: `https://composio.example/${connectorId}`,
      serverName: slugifyServerName(connectorId),
      ui: null,
      brokered: { provider: "composio", connectorId },
    });
  }
  const composio = createComposioProvider();

  const runtime = {
    getWorkDir: () => workDir,
    getManagedConnectorRegistry: () => ({
      get: (id: string) => (id === "composio" ? composio : undefined),
    }),
    getPermissionStore: () => store,
    getWorkspaceStore: () => workspaceStore,
    // list_personal_connectors enriches display metadata from the catalog; an
    // empty catalog is fine here (the assertions key on serverName + grants).
    getConnectorCatalog: () => ({ catalogEntries: async () => opts.catalog ?? [] }),
    // Same-pod connection-state probe — nothing warm in this unit context, so
    // every connector reports the resting state.
    getLifecycle: () => ({
      isIdentityConnectorRunning: () => opts.connectorRunning === true,
      lookUpAccount: async (_owner: unknown, serverName: string, lookup: AccountLookup) =>
        (await opts.lookUpAccount?.(serverName, lookup)) ?? null,
      getInstance: (serverName: string, wsId: string) =>
        opts.workspaceInstalls?.[serverName]?.includes(wsId) ? { serverName } : undefined,
    }),
    // A workspace source runs only where `workspaceTools` names one; otherwise
    // tool listings take the installed-but-not-running path.
    getRegistryForWorkspace: () => ({
      getSource: (serverName: string) => fakeSource(serverName, opts.workspaceTools?.[serverName]),
    }),
    getIdentityConnectorSource: async (userId: string, serverName: string) => {
      const tools = opts.identityTools?.[serverName];
      if (tools === "fails") throw new Error("not authenticated");
      if (tools === "unstarted") {
        return {
          name: serverName,
          tools: async () => {
            throw new Error(`McpSource "${serverName}" not started`);
          },
        } as unknown as ToolSource;
      }
      return userId === ALICE.id ? fakeSource(serverName, tools) : undefined;
    },
  } as unknown as Runtime;

  const ctx: ManageConnectorsContext = {
    runtime,
    getIdentity: () => (opts.identity === undefined ? ALICE : opts.identity),
    getWorkspaceId: () => opts.wsId ?? null,
  };
  return { workDir, store, tool: createManageConnectorsTool(ctx) };
}

/** A running source that lists `tools` under the registry's `<server>__` prefix. */
function fakeSource(serverName: string, tools: string[] | undefined): ToolSource | undefined {
  if (!tools) return undefined;
  return {
    name: serverName,
    tools: async () =>
      tools.map((t) => ({
        name: `${serverName}__${t}`,
        description: t,
        inputSchema: { type: "object" },
      })),
  } as unknown as ToolSource;
}

function sc(result: { structuredContent?: unknown }): {
  ok?: boolean;
  error?: string;
  connectors?: Array<{
    serverName: string;
    grantedWorkspaces: string[];
    state?: string;
    identity?: Record<string, unknown>;
  }>;
} {
  return (result.structuredContent ?? {}) as never;
}

describe("manage_connectors — personal-connector grants", () => {
  let h: Harness;
  afterEach(() => {
    resetTestCredentialStore();
    if (h) rmSync(h.workDir, { recursive: true, force: true });
  });

  test("grant_connector grants an owned connector to a shared workspace the caller belongs to", async () => {
    h = await buildHarness({ personalConnectors: ["granola"] });
    const res = await h.tool.handler({
      action: "grant_connector",
      serverName: "granola",
      wsId: SHARED_WS,
    });
    expect(res.isError).toBeFalsy();
    expect(await h.store.getConnectorGrants(ALICE.id, "granola")).toEqual([SHARED_WS]);
  });

  test("grant_connector grants to a workspace only the caller belongs to — just a workspace", async () => {
    // Grant-gated like any other (no free-at-home).
    h = await buildHarness({ personalConnectors: ["granola"] });
    const res = await h.tool.handler({
      action: "grant_connector",
      serverName: "granola",
      wsId: personalWs,
    });
    expect(res.isError).toBeFalsy();
    expect(await h.store.getConnectorGrants(ALICE.id, "granola")).toEqual([personalWs]);
  });

  test("grant_connector rejects a connector the caller has not installed personally", async () => {
    h = await buildHarness({ personalConnectors: [] }); // granola not installed
    const res = await h.tool.handler({
      action: "grant_connector",
      serverName: "granola",
      wsId: SHARED_WS,
    });
    expect(res.isError).toBe(true);
    expect(sc(res).error ?? res.content?.[0]).toBeTruthy();
  });

  test("grant_connector rejects a workspace the caller is not a member of", async () => {
    h = await buildHarness({ personalConnectors: ["granola"], memberOfShared: false });
    const res = await h.tool.handler({
      action: "grant_connector",
      serverName: "granola",
      wsId: SHARED_WS,
    });
    expect(res.isError).toBe(true);
    expect(await h.store.getConnectorGrants(ALICE.id, "granola")).toEqual([]);
  });

  test("revoke_connector removes a grant and is idempotent", async () => {
    h = await buildHarness({ personalConnectors: ["granola"] });
    await h.tool.handler({ action: "grant_connector", serverName: "granola", wsId: SHARED_WS });
    const res = await h.tool.handler({
      action: "revoke_connector",
      serverName: "granola",
      wsId: SHARED_WS,
    });
    expect(res.isError).toBeFalsy();
    expect(await h.store.getConnectorGrants(ALICE.id, "granola")).toEqual([]);
    // Revoking again is a safe no-op.
    const again = await h.tool.handler({
      action: "revoke_connector",
      serverName: "granola",
      wsId: SHARED_WS,
    });
    expect(again.isError).toBeFalsy();
  });

  test("list_personal_connectors returns the caller's connectors with their grant state", async () => {
    h = await buildHarness({ personalConnectors: ["granola", "notion"] });
    await h.tool.handler({ action: "grant_connector", serverName: "granola", wsId: SHARED_WS });
    const res = await h.tool.handler({ action: "list_personal_connectors" });
    const connectors = sc(res).connectors ?? [];
    const granola = connectors.find((c) => c.serverName === "granola");
    const notion = connectors.find((c) => c.serverName === "notion");
    expect(granola?.grantedWorkspaces).toEqual([SHARED_WS]);
    expect(notion?.grantedWorkspaces).toEqual([]); // installed, ungranted
    // Probe defaults false in this harness → resting state.
    expect(granola?.state).toBe("not_authenticated");
  });

  test("list_personal_connectors reports 'running' when the source is registered", async () => {
    h = await buildHarness({ personalConnectors: ["granola"], connectorRunning: true });
    const res = await h.tool.handler({ action: "list_personal_connectors" });
    const granola = (sc(res).connectors ?? []).find((c) => c.serverName === "granola");
    expect(granola?.state).toBe("running");
  });

  test("list_personal_connectors names the signed-in account from the OIDC identity record", async () => {
    h = await buildHarness({ personalConnectors: ["granola", "notion"] });
    const owner = { type: "user", userId: ALICE.id } as const;
    for (const serverName of ["granola", "notion"]) {
      await new McpOAuthRecords({ owner, serverName }).write("tokens", {
        access_token: "at",
        token_type: "Bearer",
      });
    }
    await new McpOAuthRecords({ owner, serverName: "granola" }).write("identity", {
      sub: "vendor-subject",
      email: "alice@vendor.example",
      name: "Alice V",
    });
    const res = await h.tool.handler({ action: "list_personal_connectors" });
    const connectors = sc(res).connectors ?? [];
    const granola = connectors.find((c) => c.serverName === "granola");
    const notion = connectors.find((c) => c.serverName === "notion");
    expect(granola?.state).toBe("running");
    // Display fields only — the vendor subject never leaves the server.
    expect(granola?.identity).toEqual({ email: "alice@vendor.example", name: "Alice V" });
    expect(notion?.state).toBe("running");
    expect(notion?.identity).toBeUndefined();
  });

  test("list_personal_connectors names the account a Composio connection recorded", async () => {
    h = await buildHarness({ composioConnectors: ["com.google/gmail", "com.slack/slack"] });
    const owner = { type: "user", userId: ALICE.id } as const;
    const base = {
      connectedAccountId: "ca_1",
      toolkit: "gmail",
      userId: "user:usr_alice",
      connectedAt: "2026-01-01T00:00:00.000Z",
      status: "ACTIVE",
    };
    await saveComposioConnection(h.workDir, owner, "com.google/gmail", {
      ...base,
      displayName: "alice@mail.example",
    });
    await saveComposioConnection(h.workDir, owner, "com.slack/slack", {
      ...base,
      toolkit: "slack",
    });
    const res = await h.tool.handler({ action: "list_personal_connectors" });
    const connectors = sc(res).connectors ?? [];
    const gmail = connectors.find((c) => c.serverName === slugifyServerName("com.google/gmail"));
    const slack = connectors.find((c) => c.serverName === slugifyServerName("com.slack/slack"));
    expect(gmail?.state).toBe("running");
    expect(gmail?.identity).toEqual({ name: "alice@mail.example" });
    expect(slack?.state).toBe("running");
    expect(slack?.identity).toBeUndefined();
  });

  describe("a connection whose sign-in named no account is asked through its catalog entry", () => {
    const owner = { type: "user", userId: ALICE.id } as const;
    const CLOSE = "com-example-close";
    const ZOOM_ID = "us.example/zoom";
    const lookup = { tool: "org_info", arguments: {}, field: "user.email" };
    const catalog: ConnectorCatalogEntry[] = [
      {
        id: "com.example/close",
        name: "Close",
        description: "CRM",
        url: `https://mcp.example.com/${CLOSE}`,
        auth: "dcr",
        account: lookup,
      },
      {
        id: ZOOM_ID,
        name: "Zoom",
        description: "Meetings",
        url: "https://broker.example/mcp",
        auth: "composio",
        account: { tool: "ZOOM_GET_USER", arguments: { userId: "me" }, field: "data.email" },
      },
    ];
    const connection = {
      connectedAccountId: "ca_1",
      toolkit: "zoom",
      userId: "user:usr_alice",
      connectedAt: "2026-01-01T00:00:00.000Z",
      status: "ACTIVE",
    };
    const tokens = { access_token: "at", token_type: "Bearer" };
    const listed = async (serverName: string) =>
      (sc(await h.tool.handler({ action: "list_personal_connectors" })).connectors ?? []).find(
        (c) => c.serverName === serverName,
      );

    test("an OAuth connector is asked once, and the answer is kept with its records", async () => {
      const asked: string[] = [];
      h = await buildHarness({
        personalConnectors: [CLOSE],
        catalog,
        lookUpAccount: async (serverName, l) => {
          asked.push(`${serverName}:${l.tool}:${l.field}`);
          return "alice@close.example";
        },
      });
      await new McpOAuthRecords({ owner, serverName: CLOSE }).write("tokens", tokens);

      expect((await listed(CLOSE))?.identity).toEqual({ name: "alice@close.example" });
      // The second listing reads what the first one stored.
      expect((await listed(CLOSE))?.identity).toEqual({ name: "alice@close.example" });
      expect(asked).toEqual([`${CLOSE}:org_info:user.email`]);
    });

    test("a brokered connector is asked once, and the answer is kept on its connection", async () => {
      let asks = 0;
      h = await buildHarness({
        composioConnectors: [ZOOM_ID],
        catalog,
        lookUpAccount: async () => {
          asks++;
          return "alice@zoom.example";
        },
      });
      await saveComposioConnection(h.workDir, owner, ZOOM_ID, connection);
      const serverName = slugifyServerName(ZOOM_ID);

      expect((await listed(serverName))?.identity).toEqual({ name: "alice@zoom.example" });
      expect((await listed(serverName))?.identity).toEqual({ name: "alice@zoom.example" });
      expect(asks).toBe(1);
      expect((await readComposioConnection(h.workDir, owner, ZOOM_ID))?.displayName).toBe(
        "alice@zoom.example",
      );
    });

    test("a brokered connector is asked only once its connection exists, warm source or not", async () => {
      let asks = 0;
      h = await buildHarness({
        composioConnectors: [ZOOM_ID],
        catalog,
        connectorRunning: true,
        lookUpAccount: async () => {
          asks++;
          return "alice@zoom.example";
        },
      });
      const serverName = slugifyServerName(ZOOM_ID);

      // Installed and warm (a tools listing started it), but not signed in:
      // there is no account to ask about, and nothing to remember a failure of.
      expect((await listed(serverName))?.identity).toBeUndefined();
      expect(asks).toBe(0);

      await saveComposioConnection(h.workDir, owner, ZOOM_ID, connection);
      expect((await listed(serverName))?.identity).toEqual({ name: "alice@zoom.example" });
      expect(asks).toBe(1);
    });

    test("an account the sign-in recorded is not asked for again", async () => {
      let asks = 0;
      h = await buildHarness({
        personalConnectors: [CLOSE],
        catalog,
        lookUpAccount: async () => {
          asks++;
          return "someone-else@close.example";
        },
      });
      const records = new McpOAuthRecords({ owner, serverName: CLOSE });
      await records.write("tokens", tokens);
      await records.write("identity", { email: "alice@vendor.example" });

      expect((await listed(CLOSE))?.identity).toEqual({ email: "alice@vendor.example" });
      expect(asks).toBe(0);
    });

    test("nothing is asked of a connector that is not the catalog entry's server, or not signed in", async () => {
      let asks = 0;
      const lookUpAccount = async () => {
        asks++;
        return "alice@close.example";
      };
      // Same name as the entry, another URL: the entry's lookup is not its to use.
      h = await buildHarness({
        personalConnectors: [CLOSE],
        catalog: [{ ...catalog[0], url: "https://mcp.example.com/elsewhere" }],
        lookUpAccount,
      });
      await new McpOAuthRecords({ owner, serverName: CLOSE }).write("tokens", tokens);
      expect((await listed(CLOSE))?.identity).toBeUndefined();
      rmSync(h.workDir, { recursive: true, force: true });
      resetTestCredentialStore();

      // The entry's server, with no tokens: there is no connection to ask.
      h = await buildHarness({ personalConnectors: [CLOSE], catalog, lookUpAccount });
      expect((await listed(CLOSE))?.identity).toBeUndefined();
      expect(asks).toBe(0);
    });

    test("an answer that names no account leaves the row unlabelled and stores nothing", async () => {
      h = await buildHarness({
        personalConnectors: [CLOSE],
        catalog,
        lookUpAccount: async () => null,
      });
      const records = new McpOAuthRecords({ owner, serverName: CLOSE });
      await records.write("tokens", tokens);

      expect((await listed(CLOSE))?.identity).toBeUndefined();
      expect(await records.has("identity")).toBe(false);
    });
  });

  test("all grant actions require authentication", async () => {
    h = await buildHarness({ identity: null, personalConnectors: ["granola"] });
    for (const action of ["grant_connector", "revoke_connector", "list_personal_connectors"]) {
      const res = await h.tool.handler({ action, serverName: "granola", wsId: SHARED_WS });
      expect(res.isError).toBe(true);
    }
  });
});

describe("manage_connectors — personal-connector permissions (identity scope)", () => {
  let h: Harness;
  afterEach(() => {
    resetTestCredentialStore();
    if (h) rmSync(h.workDir, { recursive: true, force: true });
  });

  test("set_permissions on a personal connector writes {scope:'user'} — the record dispatch reads", async () => {
    h = await buildHarness({ personalConnectors: ["granola"] });
    const res = await h.tool.handler({
      action: "set_permissions",
      serverName: "granola",
      tools: { delete_notes: "disallow" },
    });
    expect(res.isError).toBeFalsy();
    // Written under the caller's identity, not any workspace — the same record
    // the identity-door dispatch gate reads.
    expect(await h.store.getConnector({ scope: "user", userId: ALICE.id }, "granola")).toEqual({
      delete_notes: "disallow",
    });
  });

  test("get_permissions on a personal connector reads {scope:'user'}", async () => {
    h = await buildHarness({ personalConnectors: ["granola"] });
    await h.store.setConnector({ scope: "user", userId: ALICE.id }, "granola", {
      delete_notes: "disallow",
    });
    const res = await h.tool.handler({ action: "get_permissions", serverName: "granola" });
    expect((res.structuredContent as { scope?: string })?.scope).toBe("user");
    expect((res.structuredContent as { tools?: Record<string, string> })?.tools).toEqual({
      delete_notes: "disallow",
    });
  });
});

describe("manage_connectors — list_tools_with_permissions on a personal connector", () => {
  let h: Harness;
  afterEach(() => {
    resetTestCredentialStore();
    if (h) rmSync(h.workDir, { recursive: true, force: true });
  });

  const USER_OWNER = { scope: "user", userId: ALICE.id } as const;
  const listed = (res: { structuredContent?: unknown }) =>
    res.structuredContent as {
      scope?: string;
      tools?: Array<{ name: string }>;
      permissions?: Record<string, string>;
    };

  test("scope 'identity' lists a personal-only connector's tools and policy with no workspace", async () => {
    h = await buildHarness({
      personalConnectors: ["granola"],
      identityTools: { granola: ["list_notes", "delete_notes"] },
    });
    await h.store.setConnector(USER_OWNER, "granola", { delete_notes: "disallow" });
    const res = await h.tool.handler({
      action: "list_tools_with_permissions",
      serverName: "granola",
      scope: "identity",
    });
    expect(res.isError).toBeFalsy();
    expect(listed(res).scope).toBe("user");
    expect(listed(res).tools?.map((t) => t.name)).toEqual(["list_notes", "delete_notes"]);
    expect(listed(res).permissions).toEqual({ delete_notes: "disallow" });
  });

  for (const [state, how] of [
    ["fails", "fails to start"],
    ["unstarted", "is registered but not started"],
  ] as const) {
    test(`a personal connector whose source ${how} returns its policy with no tools`, async () => {
      h = await buildHarness({
        personalConnectors: ["granola"],
        identityTools: { granola: state },
      });
      await h.store.setConnector(USER_OWNER, "granola", { delete_notes: "disallow" });
      const res = await h.tool.handler({
        action: "list_tools_with_permissions",
        serverName: "granola",
        scope: "identity",
      });
      expect(res.isError).toBeFalsy();
      expect(listed(res).tools).toEqual([]);
      expect(listed(res).permissions).toEqual({ delete_notes: "disallow" });
    });
  }

  test("scope 'identity' reads the personal source, not a same-named workspace install", async () => {
    h = await buildHarness({
      personalConnectors: ["granola"],
      wsId: personalWs,
      workspaceInstalls: { granola: [personalWs] },
      workspaceTools: { granola: ["workspace_only"] },
      identityTools: { granola: ["list_notes"] },
    });
    await h.store.setConnector({ scope: "workspace", wsId: personalWs }, "granola", {
      workspace_only: "disallow",
    });
    const res = await h.tool.handler({
      action: "list_tools_with_permissions",
      serverName: "granola",
      scope: "identity",
    });
    expect(listed(res).scope).toBe("user");
    expect(listed(res).tools?.map((t) => t.name)).toEqual(["list_notes"]);
    expect(listed(res).permissions).toEqual({});

    // The unscoped read in that workspace still addresses the workspace install.
    const ws = await h.tool.handler({
      action: "list_tools_with_permissions",
      serverName: "granola",
    });
    expect(listed(ws).scope).toBe("workspace");
    expect(listed(ws).tools?.map((t) => t.name)).toEqual(["workspace_only"]);
    expect(listed(ws).permissions).toEqual({ workspace_only: "disallow" });
  });

  test("set_permissions with scope 'identity' on a personal-only connector writes {scope:'user'}", async () => {
    h = await buildHarness({ personalConnectors: ["granola"] });
    const res = await h.tool.handler({
      action: "set_permissions",
      serverName: "granola",
      scope: "identity",
      tools: { delete_notes: "disallow" },
    });
    expect(res.isError).toBeFalsy();
    expect(await h.store.getConnector(USER_OWNER, "granola")).toEqual({ delete_notes: "disallow" });
  });

  test("scope 'identity' for a connector the caller has no personal copy of is refused", async () => {
    h = await buildHarness({ personalConnectors: [] });
    const res = await h.tool.handler({
      action: "list_tools_with_permissions",
      serverName: "granola",
      scope: "identity",
    });
    expect(res.isError).toBe(true);
  });
});

describe("manage_connectors — permissions when a personal connector and a workspace install share a name", () => {
  let h: Harness;
  afterEach(() => {
    resetTestCredentialStore();
    if (h) rmSync(h.workDir, { recursive: true, force: true });
  });

  const both = (wsId: string) => ({
    personalConnectors: ["granola"],
    wsId,
    workspaceInstalls: { granola: [wsId] },
  });
  const USER_OWNER = { scope: "user", userId: ALICE.id } as const;

  test("set_permissions with scope 'workspace' writes the workspace policy, not the admin's personal one", async () => {
    h = await buildHarness(both(personalWs));
    const res = await h.tool.handler({
      action: "set_permissions",
      serverName: "granola",
      scope: "workspace",
      tools: { delete_notes: "disallow" },
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { scope?: string }).scope).toBe("workspace");
    expect(await h.store.getConnector({ scope: "workspace", wsId: personalWs }, "granola")).toEqual(
      { delete_notes: "disallow" },
    );
    expect(await h.store.getConnector(USER_OWNER, "granola")).toEqual({});
  });

  test("unscoped set_permissions inside the workspace addresses the workspace install", async () => {
    h = await buildHarness(both(personalWs));
    await h.tool.handler({
      action: "set_permissions",
      serverName: "granola",
      tools: { delete_notes: "disallow" },
    });
    expect(await h.store.getConnector({ scope: "workspace", wsId: personalWs }, "granola")).toEqual(
      { delete_notes: "disallow" },
    );
    expect(await h.store.getConnector(USER_OWNER, "granola")).toEqual({});
  });

  test("list_tools_with_permissions with scope 'identity' reads the personal policy", async () => {
    h = await buildHarness(both(personalWs));
    await h.store.setConnector(USER_OWNER, "granola", { delete_notes: "disallow" });
    const res = await h.tool.handler({
      action: "list_tools_with_permissions",
      serverName: "granola",
      scope: "identity",
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      scope: "user",
      permissions: { delete_notes: "disallow" },
    });
  });

  test("scope 'identity' addresses the personal connector", async () => {
    h = await buildHarness(both(personalWs));
    const res = await h.tool.handler({
      action: "set_permissions",
      serverName: "granola",
      scope: "identity",
      tools: { delete_notes: "disallow" },
    });
    expect(res.isError).toBeFalsy();
    expect(await h.store.getConnector(USER_OWNER, "granola")).toEqual({ delete_notes: "disallow" });
    expect(await h.store.getConnector({ scope: "workspace", wsId: personalWs }, "granola")).toEqual(
      {},
    );
  });

  test("a non-admin's unscoped write is refused and pointed at scope 'identity'", async () => {
    h = await buildHarness(both(SHARED_WS));
    const res = await h.tool.handler({
      action: "set_permissions",
      serverName: "granola",
      tools: { delete_notes: "disallow" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
    expect(text).toContain('scope: "identity"');
    expect(await h.store.getConnector(USER_OWNER, "granola")).toEqual({});
  });

  test("scope 'identity' for a connector the caller has no personal copy of is refused", async () => {
    h = await buildHarness({ wsId: personalWs, workspaceInstalls: { granola: [personalWs] } });
    const res = await h.tool.handler({
      action: "get_permissions",
      serverName: "granola",
      scope: "identity",
    });
    expect(res.isError).toBe(true);
  });
});
