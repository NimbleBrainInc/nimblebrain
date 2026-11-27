/**
 * Turning either default plugin off leaves the other working.
 *
 * - `plugins: { tasks: false }`: no tasks server starts, so the run worker
 *   never calls `due`; no `tasks__*` tool and no Scheduled placement appear; a
 *   notification route naming a task is answered `tasks_unavailable`; chat,
 *   files and the door keep working.
 * - `plugins: { conversations: false }` (chat off): a task still runs, since a
 *   run needs no conversation.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type { Notification } from "../../src/notifications/types.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { RuntimeConfig } from "../../src/runtime/types.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { answer, callTasks, waitForRun } from "../helpers/tasks-plugin.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const WS = TEST_WORKSPACE_ID;
const testDir = join(tmpdir(), `nimblebrain-tasks-off-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

async function start(name: string, plugins: RuntimeConfig["plugins"]): Promise<Runtime> {
  const workDir = join(testDir, name);
  mkdirSync(workDir, { recursive: true });
  const runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
    plugins,
  });
  await provisionTestWorkspace(runtime);
  return runtime;
}

describe("tasks off", () => {
  it("serves no tasks, answers a task route tasks_unavailable, and keeps chat and files", async () => {
    const runtime = await start("tasks-off", { tasks: false });
    try {
      expect(runtime.isTasksEnabled()).toBe(false);
      expect(runtime.getIdentitySource("tasks")).toBeUndefined();
      expect(existsSync(join(testDir, "tasks-off", "plugin-data", "tasks"))).toBe(false);

      const names = (await runtime.listToolsForWorkspace(WS, DEV_IDENTITY.id)).map((t) => t.name);
      expect(names.some((n) => n.startsWith("tasks__"))).toBe(false);
      expect(names).toContain("files__list");
      const placements = runtime.getPlacementRegistry().forWorkspace(WS);
      expect(placements.some((p) => p.serverName === "tasks")).toBe(false);

      const item = { source: "acme", envelope: { eventId: "e1", name: "x" } } as Notification;
      const answered = await runtime.offerTaskEvent({
        wsId: WS,
        taskId: "anything",
        ownerId: DEV_IDENTITY.id,
        item,
      });
      expect(answered).toMatchObject({ accepted: false, classification: "tasks_unavailable" });
      expect(await runtime.listOwnTasks(WS, DEV_IDENTITY.id)).toEqual([]);

      const chat = await runtime.chat({ identity: DEV_IDENTITY, workspaceId: WS, message: "hi" });
      expect(chat.response).toContain("hi");

      const files = runtime.getIdentitySource("files");
      const listed = await runWithRequestContext({ identity: DEV_IDENTITY, workspaceId: WS }, () =>
        files!.execute("list", {}),
      );
      expect(listed.isError).toBeFalsy();
    } finally {
      await runtime.shutdown();
    }
  }, 60_000);
});

describe("chat off", () => {
  it("still runs a task", async () => {
    const runtime = await start("chat-off", { conversations: false });
    try {
      expect(runtime.isChatEnabled()).toBe(false);
      expect(runtime.isTasksEnabled()).toBe(true);
      answer(
        await callTasks(runtime, DEV_IDENTITY, WS, "create", {
          manifest: { name: "Report" },
          body: "write the report",
        }),
      );
      const asked = answer<{ runId: string }>(
        await callTasks(runtime, DEV_IDENTITY, WS, "run", { taskId: "report" }),
      );
      const ended = await waitForRun(runtime, DEV_IDENTITY, WS, asked.runId);
      expect(ended.run.execution).toBe("completed");
      expect(ended.result?.output).toContain("write the report");
    } finally {
      await runtime.shutdown();
    }
  }, 60_000);
});
