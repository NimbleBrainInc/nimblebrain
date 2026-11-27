/**
 * Deleting a workspace makes it a tombstone; the purge reconcile removes it
 * after the retention window; an admin can restore it before then.
 *
 * - Deleted, the workspace is in no view and every door answers it as not
 *   found: the REST door, `/mcp/<wsId>`, and the app bridge's per-request
 *   calls to it. The run worker stops serving it. No plugin is told.
 * - Restored within the window, everything is as it was: the record and its
 *   members, the kernel's own data, and each plugin's records, which no plugin
 *   was ever asked to remove.
 * - After the window, the reconcile calls each bound plugin's private
 *   `delete_workspace`, then removes the kernel's data. A plugin's error leaves
 *   the tombstone for the next pass, and a purge that stopped halfway (a crash)
 *   is finished by the pass at the next boot.
 * - A window of 0 purges at once.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type { BoundServer } from "../../src/plugins/bound-servers.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { RuntimeConfig } from "../../src/runtime/types.ts";
import { buildMcpRequest } from "../../web/src/mcp-bridge-client.ts";
import { ownerConversationsDir } from "../helpers/conversation-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { answer, callTasks, eventually } from "../helpers/tasks-plugin.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const WS = "ws_70b5ed00c0ffee01";
const OWNER = DEV_IDENTITY;
const MODEL = "anthropic:claude-sonnet-4-6";
const TASKS_CONTRACT = "ai.nimblebrain.tasks";
const DAY_MS = 86_400_000;
const SECRET = { kind: "workspace", wsId: WS } as const;

let workDir: string;
let runtime: Runtime;
let handle: ServerHandle | null;

function config(extra: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
    ...extra,
  };
}

/** The workspace with a record in every place a delete must leave alone. */
async function seedData(): Promise<{ conversationId: string; taskId: string }> {
  await seedWorkspace(runtime.getWorkspaceStore(), WS, {
    name: "Helix",
    members: [{ userId: OWNER.id, role: "admin" }],
  });
  await runtime.ensureWorkspaceRegistry(WS);
  const conversation = await runtime
    .workspaceConversationStore(WS, OWNER.id)
    .create({ model: MODEL, ownerId: OWNER.id, workspaceId: WS });
  const task = answer<{ task: { id: string } }>(
    await callTasks(runtime, OWNER, WS, "create", { manifest: { name: "Daily" }, body: "x" }),
  ).task.id;
  await runtime.getCredentialStore().put(SECRET, "api_key", "s3cret");
  return { conversationId: conversation.id, taskId: task };
}

function deleteAsOwner(wsId = WS) {
  return runWithRequestContext({ identity: OWNER, workspaceId: wsId }, () =>
    runtime.deleteWorkspace(wsId),
  );
}

/** The tasks plugin's server, whose calls a test watches or fails. */
function tasksServer(): BoundServer {
  // biome-ignore lint/complexity/useLiteralKeys: the bound servers are private to the runtime
  const server = runtime["_boundServers"].get(TASKS_CONTRACT);
  if (!server) throw new Error("no tasks server is bound");
  return server;
}

function tasksData(): string {
  return join(workDir, "plugin-data", "tasks", "workspaces", WS);
}

async function taskIds(): Promise<string[]> {
  const listed = answer<{ tasks: Array<{ id: string }> }>(
    await callTasks(runtime, OWNER, WS, "list", {}),
  );
  return listed.tasks.map((t) => t.id);
}

/** Each door's answer for the workspace: REST, `/mcp/<wsId>`, and a bridge request. */
async function doors(): Promise<{ rest: number; mcp: number; bridge: number }> {
  const base = `http://localhost:${handle?.port}`;
  const rest = await fetch(`${base}/v1/workspaces/${WS}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server: "tasks", tool: "list", arguments: {} }),
  });
  const mcp = await fetch(`${base}/mcp/${WS}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "door-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const call = buildMcpRequest("2", "tools/call", { name: "tasks__list", arguments: {} });
  const bridge = await fetch(`${base}/mcp/${WS}`, {
    method: "POST",
    headers: call.headers,
    body: call.body,
  });
  await Promise.all([rest.body?.cancel(), mcp.body?.cancel(), bridge.body?.cancel()]);
  return { rest: rest.status, mcp: mcp.status, bridge: bridge.status };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-ws-tombstone-"));
  handle = null;
});

afterEach(async () => {
  handle?.stop(true);
  await runtime.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

describe("a deleted workspace", () => {
  beforeEach(async () => {
    runtime = await Runtime.start(config());
  });

  test("is in no view, and every door refuses it as not found", async () => {
    await seedData();
    handle = startServer({ runtime, port: 0 });
    const live = await doors();
    expect(live.rest).toBe(200);
    expect(live.mcp).toBe(200);
    expect(live.bridge).toBe(200);

    const result = await deleteAsOwner();
    expect(result.deleted).toBe(true);
    expect(result.purge).toBeUndefined();
    expect(new Date(result.purgeAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);

    const store = runtime.getWorkspaceStore();
    expect(await store.get(WS)).toBeNull();
    expect((await store.list()).map((w) => w.id)).not.toContain(WS);
    expect(await store.getWorkspacesForUser(OWNER.id)).toEqual([]);
    expect(await doors()).toEqual({ rest: 404, mcp: 404, bridge: 404 });
    await expect(runtime.ensureWorkspaceRegistry(WS)).rejects.toThrow("does not exist");
    // Deleting it again finds nothing live.
    expect((await deleteAsOwner()).deleted).toBe(false);
  });

  test("is dropped by the run worker, and served again once restored", async () => {
    await seedData();
    const server = tasksServer();
    const dueFor = spyOn(server, "call");
    const duesForWs = () =>
      dueFor.mock.calls.filter(([tool, , scope]) => tool === "due" && scope.workspaceId === WS)
        .length;
    try {
      await deleteAsOwner();
      dueFor.mockClear();
      // What would serve it again finds nothing: the worker's refresh lists
      // live workspaces, and a first reach of the workspace is refused.
      expect((await runtime.getWorkspaceStore().list()).map((w) => w.id)).not.toContain(WS);
      await expect(runtime.ensureWorkspaceRegistry(WS)).rejects.toThrow();
      await Bun.sleep(200);
      expect(duesForWs()).toBe(0);

      expect((await runtime.restoreWorkspace(WS)).restored).toBe(true);
      await eventually(() => duesForWs() > 0, 10_000, "a due call for the restored workspace");
    } finally {
      dueFor.mockRestore();
    }
  });

  test("restored within the window, is back as it was, plugin data included", async () => {
    const { conversationId, taskId } = await seedData();
    const before = await runtime.getWorkspaceStore().get(WS);
    await deleteAsOwner();

    // Nothing was removed and no plugin was told.
    expect(existsSync(ownerConversationsDir(workDir, WS, OWNER.id))).toBe(true);
    expect(existsSync(tasksData())).toBe(true);

    const listed = await runtime.listDeletedWorkspaces();
    expect(listed).toEqual([
      expect.objectContaining({
        workspaceId: WS,
        workspaceName: "Helix",
        memberCount: 1,
        deletedBy: OWNER.id,
        restorable: true,
      }),
    ]);

    const restored = await runtime.restoreWorkspace(WS);
    expect(restored.restored).toBe(true);
    expect(await runtime.getWorkspaceStore().get(WS)).toEqual(before);
    expect(await runtime.listDeletedWorkspaces()).toEqual([]);
    expect(await runtime.findConversation(WS, conversationId, { userId: OWNER.id })).not.toBeNull();
    expect(await taskIds()).toEqual([taskId]);
    expect((await runtime.getCredentialStore().list(SECRET)).map((k) => k.key)).toEqual([
      "api_key",
    ]);
    await runtime.ensureWorkspaceRegistry(WS);
  });

  test("a restore asked for while the delete is still stopping it runs after, and stays loaded", async () => {
    await seedData();
    // biome-ignore lint/complexity/useLiteralKeys: the run worker is private to the runtime
    const worker = runtime["_runWorker"];
    if (!worker) throw new Error("no run worker");
    const drop = worker.drop.bind(worker);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dropping = () => {};
    const reached = new Promise<void>((resolve) => {
      dropping = resolve;
    });
    const spy = spyOn(worker, "drop").mockImplementation(async (wsId) => {
      dropping();
      await held;
      await drop(wsId);
    });
    try {
      const deleting = deleteAsOwner();
      await reached;
      // The tombstone is written and the delete is waiting on the worker.
      const restoring = runtime.restoreWorkspace(WS);
      let restoredEarly = false;
      void restoring.then(() => {
        restoredEarly = true;
      });
      await Bun.sleep(50);
      expect(restoredEarly).toBe(false);

      release();
      expect((await deleting).deleted).toBe(true);
      expect((await restoring).restored).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(await runtime.getWorkspaceStore().get(WS)).not.toBeNull();
    // The delete finished before the restore began, so nothing unloaded what
    // the restore started.
    // biome-ignore lint/complexity/useLiteralKeys: the registries are private to the runtime
    expect(runtime["_workspaceRegistries"].has(WS)).toBe(true);
  });

  test("after the window, is purged: each plugin's delete_workspace, then the kernel's data", async () => {
    await seedData();
    await deleteAsOwner();
    const later = new Date(Date.now() + 31 * DAY_MS);
    const calls = spyOn(tasksServer(), "call");
    try {
      // Within the window the reconcile leaves it alone.
      expect((await runtime.purgeDeletedWorkspaces()).size).toBe(0);
      expect(existsSync(join(workDir, "workspaces", WS))).toBe(true);

      const results = await runtime.purgeDeletedWorkspaces(later);
      expect(results.get(WS)).toEqual({ purged: true, connectors: [] });
      expect(calls.mock.calls.map(([tool, , scope]) => [tool, scope])).toContainEqual([
        "delete_workspace",
        { workspaceId: WS },
      ]);
    } finally {
      calls.mockRestore();
    }

    expect(existsSync(ownerConversationsDir(workDir, WS, OWNER.id))).toBe(false);
    expect(existsSync(tasksData())).toBe(false);
    expect(existsSync(join(workDir, "workspaces", WS))).toBe(false);
    expect(await runtime.getCredentialStore().list(SECRET)).toEqual([]);
    expect(await runtime.listDeletedWorkspaces()).toEqual([]);
    expect(await runtime.restoreWorkspace(WS)).toEqual({ restored: false, reason: "not_found" });
    // Idempotent: another pass finds nothing.
    expect((await runtime.purgeDeletedWorkspaces(later)).size).toBe(0);
  });

  test("a plugin's error leaves the tombstone, and the next pass purges it", async () => {
    await seedData();
    await deleteAsOwner();
    const server = tasksServer();
    const call = server.call.bind(server);
    let failures = 1;
    const spy = spyOn(server, "call").mockImplementation(async (tool, args, scope) => {
      if (tool === "delete_workspace" && failures-- > 0) throw new Error("tasks is unavailable");
      return call(tool, args, scope);
    });
    try {
      const later = new Date(Date.now() + 31 * DAY_MS);
      const first = (await runtime.purgeDeletedWorkspaces(later)).get(WS);
      expect(first?.purged).toBe(false);
      expect(first?.error).toContain("tasks is unavailable");
      // Still deleted, nothing of the kernel's removed, and no longer restorable:
      // the purge began.
      expect(await runtime.getWorkspaceStore().getDeleted(WS)).not.toBeNull();
      expect(existsSync(tasksData())).toBe(true);
      expect((await runtime.getCredentialStore().list(SECRET)).length).toBe(1);
      expect(await runtime.restoreWorkspace(WS)).toEqual({ restored: false, reason: "purging" });

      const second = (await runtime.purgeDeletedWorkspaces(later)).get(WS);
      expect(second?.purged).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(tasksData())).toBe(false);
    expect(existsSync(join(workDir, "workspaces", WS))).toBe(false);
  });
});

test("a workspace deleted with no signed-in identity is purged by the automatic pass", async () => {
  runtime = await Runtime.start(config());
  await seedData();
  const result = await runWithRequestContext({ identity: null, workspaceId: WS }, () =>
    runtime.deleteWorkspace(WS),
  );
  expect(result.deleted).toBe(true);
  expect((await runtime.getWorkspaceStore().getDeleted(WS))?.tombstone.deletedBy).toBeNull();

  const results = await runtime.purgeDeletedWorkspaces(new Date(Date.now() + 31 * DAY_MS));

  expect(results.get(WS)).toEqual({ purged: true, connectors: [] });
  expect(existsSync(ownerConversationsDir(workDir, WS, OWNER.id))).toBe(false);
  expect(existsSync(tasksData())).toBe(false);
  expect(existsSync(join(workDir, "workspaces", WS))).toBe(false);
});

test("a purge that stopped halfway is finished by the pass at the next boot", async () => {
  runtime = await Runtime.start(config());
  await seedData();
  await deleteAsOwner();
  // The state a crash inside the purge's last step leaves: the purge began,
  // and the record is gone while the rest of the directory and every plugin's
  // records are not.
  await runtime.getWorkspaceStore().markPurging(WS, new Date());
  rmSync(join(workDir, "workspaces", WS, "workspace.json"));
  await runtime.shutdown();

  runtime = await Runtime.start(config());
  await eventually(
    () => !existsSync(join(workDir, "workspaces", WS)),
    10_000,
    "the boot pass to finish the purge",
  );
  expect(existsSync(tasksData())).toBe(false);
  expect(existsSync(ownerConversationsDir(workDir, WS, OWNER.id))).toBe(false);
  expect(await runtime.listDeletedWorkspaces()).toEqual([]);
});

test("a retention window of 0 purges at once", async () => {
  runtime = await Runtime.start(config({ workspaces: { deletedRetentionDays: 0 } }));
  await seedData();

  const result = await deleteAsOwner();

  expect(result.deleted).toBe(true);
  expect(result.purge).toEqual({ purged: true, connectors: [] });
  expect(existsSync(join(workDir, "workspaces", WS))).toBe(false);
  expect(existsSync(tasksData())).toBe(false);
  expect(existsSync(ownerConversationsDir(workDir, WS, OWNER.id))).toBe(false);
});

test("an archive an earlier release left is removed once the window has passed", async () => {
  runtime = await Runtime.start(config());
  const archived = join(workDir, "archived", WS);
  await Bun.write(join(archived, "workspace.json"), "{}");
  const archivedAt = Date.now();

  await runtime.purgeDeletedWorkspaces(new Date(archivedAt + DAY_MS));
  expect(existsSync(archived)).toBe(true);
  await runtime.purgeDeletedWorkspaces(new Date(archivedAt + 31 * DAY_MS));
  expect(existsSync(archived)).toBe(false);
});
