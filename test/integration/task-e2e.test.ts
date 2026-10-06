/**
 * End-to-end integration tests for the task lifecycle.
 *
 * Tests the full flow: create task -> trigger via `run` handler ->
 * verify run history shows success -> verify executor was called with
 * correct metadata structure.
 *
 * Uses the exported tool handler functions directly with a test harness
 * that wires up the workspace-owned store, the scheduler, and a mock executor.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TasksRunOutput } from "../../src/platform/schemas/tasks.ts";
import { Scheduler } from "../../src/platform/tasks/scheduler.ts";
import {
  handleCreate,
  handleRun,
  handleRuns,
  handleStatus,
  type ToolContext,
} from "../../src/platform/tasks/server.ts";
import {
  deleteTaskDefinition,
  loadOwnerTasks,
  readAllRuns,
  readRunResult,
  readRuns,
  readRunsPage,
  saveTask,
} from "../../src/platform/tasks/store.ts";
import type { Task, TaskRun, TaskRunResult } from "../../src/platform/tasks/types.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(tmpdir(), `task-e2e-${Date.now()}`);
// Tasks are workspace-owned: stored at
// `{workDir}/workspaces/<wsId>/tasks/<ownerId>/`, the scheduler scans
// `{workDir}/workspaces/*`. The harness acts as one workspace + owner.
const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";

/** Records of what the mock executor received. */
let executorCalls: Array<{ task: Task; signal: AbortSignal; trigger: string }>;

/** Configurable executor result. */
let executorResult: (auto: Task) => TaskRun;

function defaultExecutorResult(auto: Task): TaskRun {
  return {
    id: `run_${crypto.randomUUID().slice(0, 12)}`,
    taskId: auto.id,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "success",
    inputTokens: 150,
    outputTokens: 80,
    toolCalls: 3,
    iterations: 2,
    resultPreview: "Task completed successfully.",
    stopReason: "complete",
  };
}

let scheduler: Scheduler;

/**
 * `handleRun` returns a discriminated union — see `TasksRunOutput`.
 * Integration tests using the fast in-process executor always expect
 * the synchronous `{ run }` shape; this helper narrows + asserts that
 * explicitly so a future test with a slow executor doesn't silently
 * drop into the "dispatched" branch and pass on undefined dereferences.
 */
function expectSyncRun(result: TasksRunOutput): TaskRun {
  if ("run" in result) return result.run;
  throw new Error(
    `expected handleRun to return synchronously with { run }, got ${JSON.stringify(result)}`,
  );
}

function loadDefs(): Map<string, Task> {
  return loadOwnerTasks(TMP_DIR, WS, OWNER);
}

function saveDefs(map: Map<string, Task>): void {
  const onDisk = loadOwnerTasks(TMP_DIR, WS, OWNER);
  for (const auto of map.values()) {
    if (!auto.workspaceId) auto.workspaceId = WS;
    if (!auto.ownerId) auto.ownerId = OWNER;
    saveTask(TMP_DIR, WS, OWNER, auto);
  }
  for (const id of onDisk.keys()) {
    if (!map.has(id)) deleteTaskDefinition(TMP_DIR, WS, OWNER, id);
  }
}

function createHarness(): ToolContext {
  executorCalls = [];
  executorResult = defaultExecutorResult;

  const executor = async (
    task: Task,
    signal: AbortSignal,
    trigger: string,
  ): Promise<{ run: TaskRun; result: TaskRunResult | null }> => {
    executorCalls.push({ task, signal, trigger });
    const run = executorResult(task);
    const result: TaskRunResult = {
      runId: run.id,
      taskId: task.id,
      completedAt: run.completedAt ?? new Date().toISOString(),
      output: run.resultPreview ?? "",
      activityLog: [],
      outputFiles: [],
      usage: {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        iterations: run.iterations,
      },
      stopReason: run.stopReason,
    };
    // The scheduler (updateAfterRun) persists the run summary + result sidecar.
    return { run, result };
  };

  scheduler = new Scheduler(executor, {
    workDir: TMP_DIR,
    defaultTimezone: "Pacific/Honolulu",
  });
  scheduler.start();

  return {
    definitions: () => loadDefs(),
    save: (defs) => saveDefs(defs),
    reloadScheduler: () => scheduler.reload(),
    runNow: (id) => scheduler.requestRunNow(WS, OWNER, id),
    cancelRun: (id) => scheduler.cancelRun(WS, OWNER, id),
    readRuns: (id, opts) => readRuns(TMP_DIR, WS, OWNER, id, opts),
    readRunsPage: (id, opts) => readRunsPage(TMP_DIR, WS, OWNER, id, opts),
    readAllRuns: (opts) => readAllRuns(TMP_DIR, WS, OWNER, opts),
    readRunResult: (id, runId) => readRunResult(TMP_DIR, WS, OWNER, id, runId),
    defaultTimezone: "Pacific/Honolulu",
    currentUserId: OWNER,
    currentWorkspaceId: WS,
  };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  // The tasks store creates `tasks/<ownerId>/` on first write, but
  // only inside a live workspace root — so the harness stands one up.
  seedWorkspaceRoot(TMP_DIR, WS);
});

afterEach(() => {
  scheduler?.stop();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// E2E: create -> run -> verify run history
// ---------------------------------------------------------------------------

describe("task e2e: create -> run -> verify", () => {
  test("create task, trigger via run handler, run history shows success", async () => {
    const ctx = createHarness();

    const createResult = handleCreate(
      {
        manifest: {
          name: "Daily Summary",
          schedule: { type: "cron", expression: "0 8 * * *", timezone: "Pacific/Honolulu" },
          description: "Generates a daily activity summary",
        },
        body: "Summarize today's activity",
      },
      ctx,
    );

    expect(createResult.task.id).toBe("daily-summary");

    const run = expectSyncRun(await handleRun({ taskId: "daily-summary" }, ctx));
    expect(run.status).toBe("success");
    expect(run.taskId).toBe("daily-summary");

    const runsResult = handleRuns({ taskId: "daily-summary" }, ctx) as {
      runs: TaskRun[];
      total: number;
    };

    expect(runsResult.total).toBeGreaterThanOrEqual(1);
    const latestRun = runsResult.runs[0]!;
    expect(latestRun.status).toBe("success");
    expect(latestRun.toolCalls).toBe(3);
    expect(latestRun.iterations).toBe(2);
    // A run is no longer a conversation — it leaves a result sidecar instead.
    const result = ctx.readRunResult("daily-summary", latestRun.id);
    expect(result).not.toBeNull();
    expect(result!.usage.iterations).toBe(2);
  });

  test("create task, trigger, executor receives correct metadata structure", async () => {
    const ctx = createHarness();

    handleCreate(
      {
        manifest: {
          name: "Weekly Report",
          schedule: { type: "interval", intervalMs: 3_600_000 },
          description: "Compiles weekly metrics",
          skill: "reporting",
          maxIterations: 8,
          maxInputTokens: 100_000,
          model: "claude-sonnet-4-5-20250929",
        },
        body: "Generate the weekly report",
      },
      ctx,
    );

    await handleRun({ taskId: "weekly-report" }, ctx);

    expect(executorCalls.length).toBe(1);
    const received = executorCalls[0]!.task;
    expect(received.id).toBe("weekly-report");
    expect(received.name).toBe("Weekly Report");
    expect(received.prompt).toBe("Generate the weekly report");
    expect(received.skill).toBe("reporting");
    expect(received.maxIterations).toBe(8);
    expect(received.maxInputTokens).toBe(100_000);
    expect(received.model).toBe("claude-sonnet-4-5-20250929");
    expect(received.schedule.type).toBe("interval");
    expect(received.schedule.intervalMs).toBe(3_600_000);

    expect(executorCalls[0]!.signal.aborted).toBe(false);

    // The `run` tool is a user-triggered (manual) dispatch.
    expect(executorCalls[0]!.trigger).toBe("manual");
  });

  test("allowedTools passed through to executor when set on the stored task", async () => {
    const ctx = createHarness();

    handleCreate(
      {
        manifest: {
          name: "Scoped Task",
          schedule: { type: "interval", intervalMs: 120_000 },
        },
        body: "Do scoped work",
      },
      ctx,
    );
    const defs = ctx.definitions();
    defs.get("scoped-task")!.allowedTools = ["files__*", "reports__generate", "analytics__*"];
    ctx.save(defs);

    await handleRun({ taskId: "scoped-task" }, ctx);

    expect(executorCalls.length).toBe(1);
    const received = executorCalls[0]!.task;
    expect(received.allowedTools).toEqual(["files__*", "reports__generate", "analytics__*"]);
  });
});

// ---------------------------------------------------------------------------
// E2E: run records tool count and iterations
// ---------------------------------------------------------------------------

describe("task e2e: run records metrics", () => {
  test("run records tool count and iterations from executor result", async () => {
    const ctx = createHarness();

    executorResult = (auto: Task): TaskRun => ({
      id: `run_${crypto.randomUUID().slice(0, 12)}`,
      taskId: auto.id,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "success",
      inputTokens: 500,
      outputTokens: 200,
      toolCalls: 7,
      iterations: 4,
      resultPreview: "Used 7 tools across 4 iterations.",
      stopReason: "complete",
    });

    handleCreate(
      {
        manifest: {
          name: "Multi Tool Job",
          schedule: { type: "interval", intervalMs: 60_000 },
        },
        body: "Use many tools",
      },
      ctx,
    );

    const run = expectSyncRun(await handleRun({ taskId: "multi-tool-job" }, ctx));

    expect(run.toolCalls).toBe(7);
    expect(run.iterations).toBe(4);
    expect(run.inputTokens).toBe(500);
    expect(run.outputTokens).toBe(200);
  });

  test("status shows updated runCount and lastRunStatus after run", async () => {
    const ctx = createHarness();

    handleCreate(
      {
        manifest: {
          name: "Status Check",
          schedule: { type: "interval", intervalMs: 60_000 },
        },
        body: "Check status",
      },
      ctx,
    );

    const beforeStatus = handleStatus({ taskId: "status-check" }, ctx) as {
      task: Task;
    };
    expect(beforeStatus.task.runCount).toBe(0);
    expect(beforeStatus.task.lastRunStatus).toBeUndefined();

    await handleRun({ taskId: "status-check" }, ctx);

    // After run: scheduler.updateAfterRun updates the definition on disk.
    const updated = loadDefs().get("status-check")!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastRunStatus).toBe("success");
    expect(updated.consecutiveErrors).toBe(0);
  });
});
