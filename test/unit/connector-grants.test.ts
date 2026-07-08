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

import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { PermissionStore } from "../../src/permissions/permission-store.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import { personalWorkspaceIdFor, WorkspaceStore } from "../../src/workspace/workspace-store.ts";

const ALICE: UserIdentity = {
  id: "usr_alice",
  email: "alice@example.com",
  displayName: "Alice",
} as UserIdentity;

const SHARED_WS = "ws_helix";
const personalWs = personalWorkspaceIdFor(ALICE.id);

interface Harness {
  workDir: string;
  store: PermissionStore;
  tool: ReturnType<typeof createManageConnectorsTool>;
}

/** A fake personal-connector lifecycle instance in the caller's personal workspace. */
function personalInstance(serverName: string) {
  return {
    serverName,
    wsId: personalWs,
    bundleName: serverName,
    description: `${serverName} connector`,
    state: "running",
  };
}

async function buildHarness(opts: {
  identity?: UserIdentity | null;
  personalConnectors?: string[];
  memberOfShared?: boolean;
}): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-connector-grants-"));
  const store = new PermissionStore(workDir);
  const workspaceStore = new WorkspaceStore(workDir);
  await workspaceStore.create("Helix", SHARED_WS.slice(3));
  if (opts.memberOfShared !== false) {
    await workspaceStore.addMember(SHARED_WS, ALICE.id, "member");
  }
  // The caller's personal workspace — just a workspace they belong to.
  await ensureUserWorkspace(workspaceStore, { id: ALICE.id, displayName: ALICE.displayName });

  // Personal connectors live on the identity (grant reads the store); the
  // lifecycle instances mock still backs list_personal_connectors, which reads
  // the ws_user_ registry until its own re-key lands.
  const connectorStore = new IdentityConnectorStore({ workDir });
  for (const serverName of opts.personalConnectors ?? []) {
    await connectorStore.add(ALICE.id, {
      url: `https://mcp.example.com/${serverName}`,
      serverName,
      ui: null,
    });
  }
  const instances = (opts.personalConnectors ?? []).map(personalInstance);

  const runtime = {
    getWorkDir: () => workDir,
    getPermissionStore: () => store,
    getWorkspaceStore: () => workspaceStore,
    getLifecycle: () => ({
      getInstances: () => instances,
      getInstance: (s: string, w: string) =>
        instances.find((i) => i.serverName === s && i.wsId === w),
    }),
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
  connectors?: Array<{ serverName: string; grantedWorkspaces: string[] }>;
} {
  return (result.structuredContent ?? {}) as never;
}

describe("manage_connectors — personal-connector grants", () => {
  let h: Harness;
  afterEach(() => {
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

  test("grant_connector grants to the caller's own personal workspace — just a workspace", async () => {
    // A personal workspace is grant-gated like any other (no free-at-home).
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
