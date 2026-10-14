/**
 * Tasks tools answer through the SDK client, which checks each success result
 * against the tool's published output schema. A stored record any earlier
 * release could have written still reads through every view, and each answer's
 * `structuredContent` is the object its text carries.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolResult } from "../../src/engine/types.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type {
  TasksListOutput,
  TasksRunResultOutput,
  TasksRunsOutput,
  TasksStatsOutput,
  TasksStatusOutput,
} from "../../src/platform/schemas/tasks.ts";
import {
  taskFilePath,
  taskRunIndexPath,
  taskRunResultPath,
} from "../../src/platform/tasks/paths.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { ToolSource } from "../../src/tools/types.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

let workDir: string;
let runtime: Runtime;
let tasks: ToolSource;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "task-tool-outputs-"));
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    telemetry: { enabled: false },
    workDir,
  });
  await provisionTestWorkspace(runtime);
  const source = runtime.getIdentitySource("tasks");
  if (!source) throw new Error("tasks source missing");
  tasks = source;
  // List first, as the engine does: the SDK client validates a result against
  // its tool's output schema only once it holds the `tools/list` that declares it.
  await tasks.tools();
});

afterAll(async () => {
  await runtime.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

/** Call a tasks tool as the dev user; a success's structuredContent is its text's object. */
async function call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
  const result: ToolResult = await runWithRequestContext(
    { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID },
    () => tasks.execute(tool, args),
  );
  const block = result.content?.[0];
  const text = block && block.type === "text" ? block.text : "";
  if (result.isError) throw new Error(`tasks__${tool} failed: ${text}`);
  const data = JSON.parse(text) as T;
  expect(result.structuredContent).toEqual(data as Record<string, unknown>);
  return data;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/**
 * Write a task, one run line, and the run's result as an earlier release
 * stored them: a `bundle` source and its `bundleName`, no schedule or kind, a
 * null model, a run with no trigger, and an activity-log call with no input.
 */
function seedStoredTask(): { taskId: string; runId: string } {
  const taskId = "stored-task";
  const runId = "run_0123456789ab";
  const at = [workDir, TEST_WORKSPACE_ID, DEV_IDENTITY.id] as const;
  write(
    taskFilePath(...at, taskId),
    JSON.stringify({
      id: taskId,
      name: "Stored task",
      prompt: "Summarize the inbox.",
      model: null,
      enabled: true,
      source: "bundle",
      bundleName: "inbox-tools",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      lastRunAt: "2026-06-02T00:00:00.000Z",
      lastRunStatus: "success",
      runCount: 1,
      consecutiveErrors: 0,
      cumulativeInputTokens: 10,
      cumulativeOutputTokens: 5,
    }),
  );
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  write(
    taskRunIndexPath(...at, taskId),
    `${JSON.stringify({
      id: runId,
      taskId,
      startedAt,
      completedAt: startedAt,
      status: "success",
      inputTokens: 10,
      outputTokens: 5,
      toolCalls: 1,
      iterations: 1,
      stopReason: "complete",
      resultPreview: "Done.",
    })}\n`,
  );
  write(
    taskRunResultPath(...at, taskId, runId),
    JSON.stringify({
      runId,
      taskId,
      completedAt: startedAt,
      output: "Done.",
      activityLog: [{ id: "call_1", name: "inbox__list", output: "[]", ok: true, ms: 3 }],
      outputFiles: [],
      usage: { inputTokens: 10, outputTokens: 5, iterations: 1 },
      stopReason: "complete",
    }),
  );
  return { taskId, runId };
}

describe("tasks tool outputs", () => {
  it("a task and run stored by an earlier release read through every view", async () => {
    const { taskId, runId } = seedStoredTask();

    const list = await call<TasksListOutput>("list", { kind: "all" });
    expect(list.tasks.map((t) => t.id)).toContain(taskId);

    const status = await call<TasksStatusOutput>("status", { taskId });
    expect(status.task.model).toBeNull();
    expect(status.recentRuns.map((r) => r.id)).toEqual([runId]);

    const runs = await call<TasksRunsOutput>("runs", { taskId });
    expect(runs.runs[0]?.label).toBe("Succeeded");

    const result = await call<TasksRunResultOutput>("run_result", { runId, taskId });
    if (result.status !== "ended") throw new Error(`expected ended, got ${result.status}`);
    expect(result.result?.activityLog[0]?.name).toBe("inbox__list");

    const stats = await call<TasksStatsOutput>("stats", { taskId, since: "2000-01-01T00:00:00Z" });
    expect(stats.tasks[0]?.runs).toBe(1);

    await call("upcoming", {});
  });

  it("the views with nothing to show answer in their schema", async () => {
    await call("judges", {});
    await call("batches", {});
    await call("cancel", { runId: "run_ffffffffffff" });
  });
});
