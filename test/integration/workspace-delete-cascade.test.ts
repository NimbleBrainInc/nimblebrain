/**
 * Purging a deleted workspace runs the same teardown as removing each connector
 * it holds; deleting it only stops them.
 *
 *   1. Delete stops the workspace's connectors and forgets them in this process,
 *      telling none of them anything, and restore starts them again.
 *   2. The purge starts them as a restore would, so each is told `on_removing`
 *      and holds the ref its revoke needs, then tears each down through the one
 *      teardown the `uninstall` action uses.
 *   3. A connector that fails its teardown is reported and the purge still
 *      completes. One unreachable vendor must not strand a deleted workspace.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedConnectorProvider } from "../../src/connectors/providers/managed-provider.ts";
import { managedConnectorRegistryOf } from "../../src/connectors/providers/registry.ts";
import { brokeredConnectorDir } from "../../src/connectors/runtime/brokered.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { stopAllToolSurfaceWatches } from "../../src/tools/connector-surface.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import {
  type FixtureCall,
  marked,
  serveModernLifecycleServer,
} from "../helpers/lifecycle-server.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const WS_ID = "ws_003eba8844413cd9";
const ALPHA = "com-example-alpha";
const BETA = "com-example-beta";
const GAMMA = "com-example-gamma";
/** A broker defined entirely in this file — no kernel code names it. */
const BROKER = "example-broker";
const REMOVING = "workspace_removing";

let workDir: string;
let runtime: Runtime;
let servers: Array<{ url: string; calls: FixtureCall[]; close: () => void }>;

/** A connector reachable over HTTP that binds `removing`, installed with no credential to fetch. */
function liveConnector(serverName: string): { ref: ConnectorRef; calls: FixtureCall[] } {
  const served = serveModernLifecycleServer(serverName, {
    tools: [marked(REMOVING, "removing")],
  });
  servers.push(served);
  return {
    ref: {
      url: served.url,
      serverName,
      transport: { type: "streamable-http", auth: { type: "none" } },
    },
    calls: served.calls,
  };
}

/** Install `refs` on the workspace record, then boot, so boot starts them as it does any install. */
async function bootWith(refs: ConnectorRef[]): Promise<void> {
  const store = new WorkspaceStore(workDir);
  await seedWorkspace(store, WS_ID, {
    name: "Helix",
    members: [{ userId: DEV_IDENTITY.id, role: "admin" }],
  });
  await store.update(WS_ID, { connectors: refs });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    allowInsecureRemotes: true,
    workDir,
  });
}

function deleteAsMember() {
  return runWithRequestContext({ identity: DEV_IDENTITY, workspaceId: WS_ID }, () =>
    runtime.deleteWorkspace(WS_ID),
  );
}

const removals = (calls: FixtureCall[]) => calls.filter((c) => c.tool === REMOVING).length;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-ws-delete-"));
  servers = [];
});

afterEach(async () => {
  await runtime.shutdown();
  stopAllToolSurfaceWatches();
  for (const s of servers) s.close();
  rmSync(workDir, { recursive: true, force: true });
});

test("delete stops the connectors and tells them nothing; restore starts them again", async () => {
  const alpha = liveConnector(ALPHA);
  await bootWith([alpha.ref]);
  expect(runtime.getRegistryForWorkspace(WS_ID).hasSource(ALPHA)).toBe(true);

  await deleteAsMember();

  expect(runtime.getWorkspaceRegistries().has(WS_ID)).toBe(false);
  expect(runtime.getLifecycle().getInstance(ALPHA, WS_ID)).toBeUndefined();
  expect(removals(alpha.calls)).toBe(0);

  expect((await runtime.restoreWorkspace(WS_ID)).restored).toBe(true);
  expect(runtime.getRegistryForWorkspace(WS_ID).hasSource(ALPHA)).toBe(true);
  expect(runtime.getLifecycle().getInstance(ALPHA, WS_ID)).toBeDefined();
  expect(removals(alpha.calls)).toBe(0);
}, 30_000);

test("the purge tells each connector it is going, then tears each down", async () => {
  const alpha = liveConnector(ALPHA);
  const beta = liveConnector(BETA);
  await bootWith([alpha.ref, beta.ref]);
  await deleteAsMember();

  const result = await runtime.purgeWorkspace(WS_ID);

  expect(result.purged).toBe(true);
  expect(result.connectors.map((c) => c.serverName)).toEqual([ALPHA, BETA]);
  expect(result.connectors.every((c) => c.ok)).toBe(true);
  // A revoke was attempted for each: the purge held each connector's instance.
  expect(result.connectors.every((c) => c.revoked !== undefined || c.revokeError)).toBe(true);
  expect(removals(alpha.calls)).toBe(1);
  expect(removals(beta.calls)).toBe(1);
  expect(runtime.getWorkspaceRegistries().has(WS_ID)).toBe(false);
  expect(runtime.getLifecycle().getInstance(ALPHA, WS_ID)).toBeUndefined();
  expect(existsSync(join(workDir, "workspaces", WS_ID))).toBe(false);
}, 30_000);

test("a connector whose teardown throws is reported, and the purge still completes", async () => {
  const alpha = liveConnector(ALPHA);
  const beta = liveConnector(BETA);
  await bootWith([alpha.ref, beta.ref]);
  await deleteAsMember();
  const lifecycle = runtime.getLifecycle();
  const uninstall = lifecycle.uninstall.bind(lifecycle);
  const spy = spyOn(lifecycle, "uninstall").mockImplementation(async (name, registry, wsId) => {
    if (name === ALPHA) throw new Error(`${name} would not stop`);
    return uninstall(name, registry, wsId);
  });
  try {
    const result = await runtime.purgeWorkspace(WS_ID);
    const failed = result.connectors.find((c) => c.serverName === ALPHA);
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toContain("would not stop");
    expect(result.connectors.find((c) => c.serverName === BETA)?.ok).toBe(true);
    expect(result.purged).toBe(true);
  } finally {
    spy.mockRestore();
  }
  expect(existsSync(join(workDir, "workspaces", WS_ID))).toBe(false);
}, 30_000);

test("the purge reaches the broker's revoke for a brokered connector, and clears its credential dir", async () => {
  const ref: ConnectorRef = {
    url: "https://broker.example.test/mcp",
    serverName: GAMMA,
    brokered: { provider: BROKER, connectorId: "com.example/gamma" },
  };
  await bootWith([ref]);
  const cleanups: Array<{ connectorId: string; wsId: string }> = [];
  const provider: ManagedConnectorProvider = {
    id: BROKER,
    userId: (owner) => (owner.type === "workspace" ? `ws:${owner.wsId}` : `u:${owner.userId}`),
    createSession: async () => ({ type: "http", url: "https://broker.example.test/mcp" }),
    cleanup: async ({ owner, brokered }) => {
      cleanups.push({
        connectorId: brokered.connectorId,
        wsId: owner.type === "workspace" ? owner.wsId : "",
      });
      return { upstreamDeleted: true, localDeleted: true };
    },
  };
  runtime.getLifecycle().setManagedConnectorRegistry(managedConnectorRegistryOf([provider]));
  // Provider-owned local state, at the directory rule the kernel owns.
  const dir = brokeredConnectorDir(
    workDir,
    { type: "workspace", wsId: WS_ID },
    BROKER,
    "com.example/gamma",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lease.json"), "{}\n");

  await deleteAsMember();
  // Deleted, nothing is revoked: a restore must find the connection intact.
  expect(cleanups).toEqual([]);
  expect(existsSync(dir)).toBe(true);

  const result = await runtime.purgeWorkspace(WS_ID);

  expect(result.purged).toBe(true);
  expect(cleanups).toEqual([{ connectorId: "com.example/gamma", wsId: WS_ID }]);
  expect(existsSync(dir)).toBe(false);
}, 30_000);
