/**
 * Unit tests for the personal-connector grant actions on `manage_connectors`:
 * `grant_connector`, `revoke_connector`, `list_personal_connectors`.
 *
 * A grant lets the caller use one of THEIR OWN personal connectors (installed in
 * `ws_user_<callerId>`) inside a shared workspace they belong to. It is written
 * to the caller's own grant ledger and is per-granter — no admin gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UserIdentity } from "../../src/identity/provider.ts";
import { PermissionStore } from "../../src/permissions/permission-store.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
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

/**
 * A fake bundle instance in the caller's personal workspace. `installSource`
 * "remote" = a remote MCP connection (a real personal connector); "registry" =
 * a pre-gate mpak bundle / Synapse app that is NOT a grantable connector.
 */
function personalInstance(serverName: string, installSource: "remote" | "registry" = "remote") {
  return {
    serverName,
    wsId: personalWs,
    bundleName: serverName,
    description: `${serverName} bundle`,
    state: "running",
    installSource,
  };
}

async function buildHarness(opts: {
  identity?: UserIdentity | null;
  personalConnectors?: string[];
  /** Non-connector bundles (e.g. a pre-gate app) sitting in the personal workspace. */
  personalNonConnectors?: string[];
  memberOfShared?: boolean;
}): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-connector-grants-"));
  const store = new PermissionStore(workDir);
  const workspaceStore = new WorkspaceStore(workDir);
  await workspaceStore.create("Helix", SHARED_WS.slice(3));
  if (opts.memberOfShared !== false) {
    await workspaceStore.addMember(SHARED_WS, ALICE.id, "member");
  }
  const instances = [
    ...(opts.personalConnectors ?? []).map((n) => personalInstance(n, "remote")),
    ...(opts.personalNonConnectors ?? []).map((n) => personalInstance(n, "registry")),
  ];

  const runtime = {
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

  test("grant_connector rejects a self-grant to the caller's own personal workspace", async () => {
    h = await buildHarness({ personalConnectors: ["granola"] });
    const res = await h.tool.handler({
      action: "grant_connector",
      serverName: "granola",
      wsId: personalWs,
    });
    expect(res.isError).toBe(true);
    expect(await h.store.getConnectorGrants(ALICE.id, "granola")).toEqual([]);
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

  // Defense-in-depth for personal workspaces created before the install
  // admission gate: a non-connector bundle (mpak/app, installSource !== "remote")
  // must not be listed or granted as a personal connector.
  test("list_personal_connectors excludes a pre-gate non-connector bundle", async () => {
    h = await buildHarness({ personalConnectors: ["granola"], personalNonConnectors: ["crm_app"] });
    const connectors = sc(await h.tool.handler({ action: "list_personal_connectors" })).connectors ?? [];
    expect(connectors.map((c) => c.serverName)).toEqual(["granola"]); // crm_app excluded
  });

  test("grant_connector rejects a pre-gate non-connector bundle", async () => {
    h = await buildHarness({ personalNonConnectors: ["crm_app"] });
    const res = await h.tool.handler({
      action: "grant_connector",
      serverName: "crm_app",
      wsId: SHARED_WS,
    });
    expect(res.isError).toBe(true);
    expect(await h.store.getConnectorGrants(ALICE.id, "crm_app")).toEqual([]);
  });
});
