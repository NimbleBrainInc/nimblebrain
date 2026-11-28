/**
 * The run worker serves a workspace from the moment it exists, so "Run now" in
 * it ends promptly rather than at the worker's next listing (`DUE_INTERVAL_MS`).
 *
 * - A workspace created after boot, which nothing else has reached, is served
 *   at its creation: its first run ends within a short bound.
 * - Deleted, it is served no more: no `due` call reaches the plugin for it.
 * - Restored, it is served again at once: its next run ends within the bound.
 *
 * The tasks calls go straight to the bound tasks source, never through
 * `ensureWorkspaceRegistry`, so only the worker's own serving is under test.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type { BoundServer } from "../../src/plugins/bound-servers.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { DUE_INTERVAL_MS, TASKS_CONTRACT } from "../../src/runtime/run-worker.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { answer, callTasks, waitForRun } from "../helpers/tasks-plugin.ts";

const OWNER = DEV_IDENTITY;
/** Well under the worker's listing interval: a run that waited for it fails. */
const PROMPT_MS = 2_000;

let workDir: string;
let runtime: Runtime;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-run-worker-serve-"));
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
  });
}, 60_000);

afterAll(async () => {
  await runtime?.shutdown();
  rmSync(workDir, { recursive: true, force: true });
}, 30_000);

function tasksServer(): BoundServer {
  // biome-ignore lint/complexity/useLiteralKeys: the bound servers are private to the runtime
  const server = runtime["_boundServers"].get(TASKS_CONTRACT);
  if (!server) throw new Error("no tasks server is bound");
  return server;
}

/** Run a task now and follow it to its end; how long that took. */
async function runToEnd(wsId: string, taskId: string): Promise<{ ms: number; execution: string }> {
  const started = Date.now();
  const asked = answer<{ runId: string }>(await callTasks(runtime, OWNER, wsId, "run", { taskId }));
  const ended = await waitForRun(runtime, OWNER, wsId, asked.runId, PROMPT_MS * 5);
  return { ms: Date.now() - started, execution: ended.run.execution };
}

describe("the run worker serves a workspace from the moment it exists", () => {
  let wsId: string;
  let taskId: string;

  test("a workspace created after boot runs its first task promptly", async () => {
    expect(PROMPT_MS).toBeLessThan(DUE_INTERVAL_MS);
    const ws = await runtime.getWorkspaceStore().create("Fresh", {
      members: [{ userId: OWNER.id, role: "admin" }],
    });
    wsId = ws.id;
    taskId = answer<{ task: { id: string } }>(
      await callTasks(runtime, OWNER, wsId, "create", {
        manifest: { name: "Echo" },
        body: "say hello",
      }),
    ).task.id;

    const run = await runToEnd(wsId, taskId);
    expect(run.execution).toBe("completed");
    expect(run.ms).toBeLessThan(PROMPT_MS);
  }, 30_000);

  test("deleted, it is served no more; restored, its runs start promptly again", async () => {
    const server = tasksServer();
    const calls = spyOn(server, "call");
    const dues = () =>
      calls.mock.calls.filter(([tool, , scope]) => tool === "due" && scope.workspaceId === wsId)
        .length;
    try {
      const deleted = await runWithRequestContext({ identity: OWNER, workspaceId: wsId }, () =>
        runtime.deleteWorkspace(wsId),
      );
      expect(deleted.deleted).toBe(true);
      calls.mockClear();
      await Bun.sleep(300);
      expect(dues()).toBe(0);

      expect((await runtime.restoreWorkspace(wsId)).restored).toBe(true);
      const run = await runToEnd(wsId, taskId);
      expect(run.execution).toBe("completed");
      expect(run.ms).toBeLessThan(PROMPT_MS);
      expect(dues()).toBeGreaterThan(0);
    } finally {
      calls.mockRestore();
    }
  }, 30_000);
});
