/**
 * Unit tests for the personal-connector grant actions on `manage_connectors`:
 * `grant_connector`, `revoke_connector`, `list_personal_connectors`.
 *
 * A grant lets the caller use one of THEIR OWN personal connectors (installed on
 * their identity) inside a workspace they belong to — any workspace, including
 * their own personal one (a personal workspace is just a workspace). It is
 * written to the caller's own grant ledger and is per-granter — no admin gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveComposioConnection } from "../../src/connectors/providers/composio/connection.ts";
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
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";

const ALICE: UserIdentity = {
  id: "usr_alice",
  email: "alice@example.com",
  displayName: "Alice",
} as UserIdentity;

const SHARED_WS = "ws_helix";
/** A workspace only Alice belongs to. */
const personalWs = "ws_alice_own";

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
}): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-connector-grants-"));
  // `list_personal_connectors` derives `authed` from the OAuth token record,
  // which the credential store answers.
  installTestCredentialStore(workDir);
  const store = new PermissionStore(workDir);
  const workspaceStore = new WorkspaceStore(workDir);
  await workspaceStore.create("Helix", SHARED_WS.slice(3));
  if (opts.memberOfShared !== false) {
    await workspaceStore.addMember(SHARED_WS, ALICE.id, "member");
  }
  // A workspace only the caller belongs to — just a workspace.
  await workspaceStore.create("Alice's workspace", personalWs.slice(3), {
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
    getConnectorCatalog: () => ({ catalogEntries: async () => [] }),
    // Same-pod connection-state probe — nothing warm in this unit context, so
    // every connector reports the resting state.
    getLifecycle: () => ({ isIdentityConnectorRunning: () => opts.connectorRunning === true }),
  } as unknown as Runtime;

  const ctx: ManageConnectorsContext = {
    runtime,
    getIdentity: () => (opts.identity === undefined ? ALICE : opts.identity),
    getWorkspaceId: () => null,
  };
  return { workDir, store, tool: createManageConnectorsTool(ctx) };
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
      await new McpOAuthRecords({ owner, serverName, workDir: h.workDir }).write("tokens", {
        access_token: "at",
        token_type: "Bearer",
      });
    }
    await new McpOAuthRecords({ owner, serverName: "granola", workDir: h.workDir }).write(
      "identity",
      { sub: "vendor-subject", email: "alice@vendor.example", name: "Alice V" },
    );
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
