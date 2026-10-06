/**
 * `tasks__run` as a task: the tasks source's task surface over a
 * real scheduler and store. The task id is the run id, the run's ticket exists
 * before the handle is returned, a lookup reads the record on disk (so a new
 * process answers it), and only the (workspace, identity, source) that started
 * the run can read or cancel it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task as McpTask } from "@modelcontextprotocol/server";
import {
  type Executor,
  isOpenRun,
  type RunInput,
  Scheduler,
} from "../../../../src/platform/tasks/scheduler.ts";
import type { ToolContext } from "../../../../src/platform/tasks/server.ts";
import {
  loadOwnerTasks,
  readIdempotencyKey,
  readRunResult,
  readRuns,
  readRunTicket,
  saveRunTicket,
  saveTask,
} from "../../../../src/platform/tasks/store.ts";
import { createTaskRunSource, taskStatusOf } from "../../../../src/platform/tasks/task-source.ts";
import type {
  RunTicket,
  Task,
  TaskRun,
  TaskRunResult,
} from "../../../../src/platform/tasks/types.ts";
import { createRunAdmission, type RunAdmission } from "../../../../src/runtime/admission.ts";
import type { IdentityTaskSource } from "../../../../src/tools/identity-task-source.ts";
import { TaskNotFoundError, type TaskOwnerContext } from "../../../../src/tools/types.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const WS = "ws_00a1b2c3d4e5f607";
const OTHER_WS = "ws_00a1b2c3d4e5f608";
const OWNER = "usr_task_owner";
const STRANGER = "usr_task_stranger";

const OWNED: TaskOwnerContext = { workspaceId: WS, identityId: OWNER, originApp: "tasks" };

let workDir: string;

/** One executor call the test settles by hand. */
interface HeldRun {
  task: Task;
  runId: string | undefined;
  input: RunInput | undefined;
  signal: AbortSignal;
  finish: (output: string, status?: TaskRun["status"]) => void;
}

/** An executor whose runs stay in flight until the test finishes them; an abort ends one cancelled. */
function heldExecutor(): { executor: Executor; held: HeldRun[] } {
  const held: HeldRun[] = [];
  const executor: Executor = (task, signal, trigger, input, _lease, runId) =>
    new Promise((resolve) => {
      const startedAt = new Date().toISOString();
      const finish = (output: string, status: TaskRun["status"] = "success") => {
        const id = runId ?? `run_${crypto.randomUUID().slice(0, 12)}`;
        const run: TaskRun = {
          id,
          taskId: task.id,
          startedAt,
          completedAt: new Date().toISOString(),
          status,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: 0,
          iterations: 1,
          trigger,
          ...(output ? { resultPreview: output.slice(0, 280) } : {}),
          ...(status === "cancelled" ? { error: "Cancelled by user" } : {}),
        };
        const result: TaskRunResult = {
          runId: id,
          taskId: task.id,
          completedAt: run.completedAt!,
          output,
          activityLog: [],
          outputFiles: [],
          usage: { inputTokens: 10, outputTokens: 5, iterations: 1 },
        };
        resolve({ run, result });
      };
      signal.addEventListener("abort", () => finish("", "cancelled"), { once: true });
      held.push({ task, runId, input, signal, finish });
    });
  return { executor, held };
}

/** The scheduler, tool context and task surface the tasks source wires, for one owner. */
function harness(opts: { executor: Executor; admission?: RunAdmission }) {
  const scheduler = new Scheduler(opts.executor, {
    workDir,
    admission: opts.admission ?? createRunAdmission(),
  });
  scheduler.start();

  const currentTicket = (wsId: string, owner: string, runId: string): RunTicket | null => {
    const ticket = readRunTicket(workDir, wsId, owner, runId);
    if (!ticket || !isOpenRun(ticket.run) || scheduler.isRunOpen(runId)) return ticket;
    return scheduler.settleLostRun(wsId, owner, ticket);
  };

  const ctx = (wsId = WS, owner = OWNER): ToolContext => ({
    definitions: () => loadOwnerTasks(workDir, wsId, owner),
    save: (map) => {
      for (const auto of map.values()) {
        auto.workspaceId ??= wsId;
        auto.ownerId ??= owner;
        saveTask(workDir, wsId, owner, auto);
      }
    },
    reloadScheduler: () => scheduler.reload(),
    runNow: (id, requested) => scheduler.requestRunNow(wsId, owner, id, requested),
    readRunTicket: (runId) => currentTicket(wsId, owner, runId),
    findRunByKey: (id, key) => {
      const runId = readIdempotencyKey(workDir, wsId, owner, id, key);
      return runId ? currentTicket(wsId, owner, runId) : null;
    },
    cancelRun: (runId) => scheduler.cancelRunById(wsId, owner, runId),
    readRuns: (id, o) => readRuns(workDir, wsId, owner, id, o),
    readRunsPage: () => ({ runs: [] }),
    readAllRuns: () => [],
    readRunResult: (id, runId) => readRunResult(workDir, wsId, owner, id, runId),
    defaultTimezone: "UTC",
    currentUserId: owner,
    currentWorkspaceId: wsId,
  });

  let unattended = false;
  const source = createTaskRunSource({
    toolContext: () => ctx(),
    readTicket: currentTicket,
    readResult: (wsId, owner, id, runId) => readRunResult(workDir, wsId, owner, id, runId),
    runEnded: (runId) => scheduler.runEnded(runId),
    cancelRun: (wsId, owner, runId) => scheduler.cancelRunById(wsId, owner, runId),
    unattendedRefusal: () => (unattended ? "not inside an unattended run" : null),
  });
  return {
    scheduler,
    source,
    setUnattended: (value: boolean) => {
      unattended = value;
    },
  };
}

function seed(id: string, extra: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const auto: Task = {
    id,
    name: id,
    prompt: `Do the ${id} thing.`,
    enabled: true,
    source: "agent",
    ownerId: OWNER,
    workspaceId: WS,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    ...extra,
  };
  saveTask(workDir, WS, OWNER, auto);
  return auto;
}

async function startTask(
  source: IdentityTaskSource,
  args: Record<string, unknown>,
): Promise<McpTask> {
  const started = await source.startToolAsTask("run", args, { ownerContext: OWNED });
  if (!("task" in started)) throw new Error(`expected a task, got ${JSON.stringify(started)}`);
  return started.task;
}

/** Let the scheduler record what a settled executor returned. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-tasks-task-"));
  seedWorkspaceRoot(workDir, WS);
  seedWorkspaceRoot(workDir, OTHER_WS);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("taskStatusOf", () => {
  const run = (status: TaskRun["status"], extra: Partial<TaskRun> = {}) =>
    ({ status, ...extra }) as TaskRun;

  test("maps each run state to a task status", () => {
    expect(taskStatusOf(run("queued"))).toBe("working");
    expect(taskStatusOf(run("running"))).toBe("working");
    expect(taskStatusOf(run("success"))).toBe("completed");
    expect(taskStatusOf(run("degraded"))).toBe("completed");
    // Ended at a limit with a partial deliverable: incomplete, which completes.
    expect(taskStatusOf(run("timeout", { resultPreview: "half" }))).toBe("completed");
    expect(taskStatusOf(run("timeout"))).toBe("failed");
    expect(taskStatusOf(run("failure"))).toBe("failed");
    expect(taskStatusOf(run("skipped"))).toBe("failed");
    expect(taskStatusOf(run("cancelled"))).toBe("cancelled");
  });
});

describe("tasks__run as a task", () => {
  test("returns a working task named by the run id, whose ticket exists before the handle", async () => {
    const { executor, held } = heldExecutor();
    const { scheduler, source } = harness({ executor });
    seed("digest");

    const task = await startTask(source, { taskId: "digest" });

    expect(task.status).toBe("working");
    expect(task.ttl).toBeNull();
    // The run is still in flight, and its record is already on disk.
    const ticket = readRunTicket(workDir, WS, OWNER, task.taskId);
    expect(ticket?.run.status).toBe("running");
    expect(ticket?.taskId).toBe("digest");
    // The task id is the run id the runtime is handed.
    expect(held[0]?.runId).toBe(task.taskId);

    held[0]?.finish("the digest");
    await flush();
    scheduler.stop();
  });

  test("tasks/get reads a completed run with its deliverable and record", async () => {
    const { executor, held } = heldExecutor();
    const { scheduler, source } = harness({ executor });
    seed("digest");
    const task = await startTask(source, { taskId: "digest", input: { topic: "news" } });

    held[0]?.finish("the digest");
    const result = await source.awaitToolTaskResult(task.taskId, { ownerContext: OWNED });
    expect((await source.getTaskStatus(task.taskId, { ownerContext: OWNED })).status).toBe(
      "completed",
    );
    expect(result.content).toEqual([{ type: "text", text: "the digest" }]);
    const { run, result: deliverable } = result.structuredContent as {
      run: TaskRun;
      result: TaskRunResult;
    };
    expect(run.id).toBe(task.taskId);
    expect(run.status).toBe("success");
    expect(run.input).toEqual({ topic: "news" });
    expect(deliverable.output).toBe("the digest");
    // The index holds the same run, under the same id.
    expect(readRuns(workDir, WS, OWNER, "digest")[0]?.id).toBe(task.taskId);
    scheduler.stop();
  });

  test("a run refused at the door is a failed task carrying the reason", async () => {
    const { executor, held } = heldExecutor();
    const { scheduler, source } = harness({ executor });
    seed("digest");
    await startTask(source, { taskId: "digest" });

    const second = await startTask(source, { taskId: "digest" });
    expect(second.status).toBe("failed");
    expect(second.statusMessage).toContain("Already running");
    await expect(
      source.awaitToolTaskResult(second.taskId, { ownerContext: OWNED }),
    ).rejects.toThrow("Already running");

    held[0]?.finish("done");
    await flush();
    scheduler.stop();
  });

  test("tasks/cancel cancels a queued run and a running one", async () => {
    const { executor, held } = heldExecutor();
    const admission = createRunAdmission({ maxConcurrentRuns: 1 });
    const { scheduler, source } = harness({ executor, admission });
    seed("first");
    seed("second");

    const running = await startTask(source, { taskId: "first" });
    const queued = await startTask(source, { taskId: "second" });
    expect(readRunTicket(workDir, WS, OWNER, queued.taskId)?.run.status).toBe("queued");

    const cancelledQueued = await source.cancelTask(queued.taskId, { ownerContext: OWNED });
    expect(cancelledQueued.status).toBe("cancelled");
    expect(held).toHaveLength(1);

    const cancelledRunning = await source.cancelTask(running.taskId, { ownerContext: OWNED });
    expect(held[0]?.signal.aborted).toBe(true);
    expect(cancelledRunning.status).toBe("cancelled");

    // A cancel of an ended task is refused as terminal.
    await expect(source.cancelTask(running.taskId, { ownerContext: OWNED })).rejects.toThrow(
      "already terminal",
    );
    scheduler.stop();
  });

  test("another identity, workspace, or source finds no such task", async () => {
    const { executor, held } = heldExecutor();
    const { scheduler, source } = harness({ executor });
    seed("digest");
    const task = await startTask(source, { taskId: "digest" });

    const strangers: TaskOwnerContext[] = [
      { ...OWNED, identityId: STRANGER },
      { ...OWNED, workspaceId: OTHER_WS },
      { ...OWNED, originApp: "files" },
      { workspaceId: WS, originApp: "tasks" },
    ];
    for (const ownerContext of strangers) {
      await expect(source.getTaskStatus(task.taskId, { ownerContext })).rejects.toBeInstanceOf(
        TaskNotFoundError,
      );
      await expect(source.cancelTask(task.taskId, { ownerContext })).rejects.toBeInstanceOf(
        TaskNotFoundError,
      );
    }
    await expect(
      source.getTaskStatus("run_doesnotexist", { ownerContext: OWNED }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(held[0]?.signal.aborted).toBe(false);

    held[0]?.finish("done");
    await flush();
    scheduler.stop();
  });

  test("a new process answers a handle from the record on disk", async () => {
    const first = heldExecutor();
    const before = harness({ executor: first.executor });
    seed("digest");
    const task = await startTask(before.source, { taskId: "digest" });
    first.held[0]?.finish("kept");
    await flush();
    before.scheduler.stop();

    const after = harness({ executor: heldExecutor().executor });
    const got = await after.source.getTaskStatus(task.taskId, { ownerContext: OWNED });
    expect(got.status).toBe("completed");
    const result = await after.source.awaitToolTaskResult(task.taskId, { ownerContext: OWNED });
    expect(result.content).toEqual([{ type: "text", text: "kept" }]);
    after.scheduler.stop();
  });

  test("a run left open by a process that stopped is settled as not finished", async () => {
    const auto = seed("digest");
    const now = new Date().toISOString();
    saveRunTicket(workDir, WS, OWNER, {
      runId: "run_leftbehind1",
      taskId: auto.id,
      requestedAt: now,
      run: {
        id: "run_leftbehind1",
        taskId: auto.id,
        startedAt: now,
        status: "running",
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        iterations: 0,
      },
    });

    const { scheduler, source } = harness({ executor: heldExecutor().executor });
    const got = await source.getTaskStatus("run_leftbehind1", { ownerContext: OWNED });
    expect(got.status).toBe("failed");
    expect(got.statusMessage).toContain("runtime stopped");
    expect(readRuns(workDir, WS, OWNER, "digest")[0]?.id).toBe("run_leftbehind1");
    scheduler.stop();
  });

  test("a repeated idempotency key returns the run the first call started", async () => {
    const { executor, held } = heldExecutor();
    const { scheduler, source } = harness({ executor });
    seed("digest");

    const first = await startTask(source, { taskId: "digest", idempotencyKey: "item-42" });
    const again = await startTask(source, { taskId: "digest", idempotencyKey: "item-42" });
    expect(again.taskId).toBe(first.taskId);
    expect(held).toHaveLength(1);
    expect(readRunTicket(workDir, WS, OWNER, first.taskId)?.run.idempotencyKey).toBe("item-42");

    held[0]?.finish("done");
    await flush();
    const afterEnd = await startTask(source, { taskId: "digest", idempotencyKey: "item-42" });
    expect(afterEnd.taskId).toBe(first.taskId);
    expect(afterEnd.status).toBe("completed");
    scheduler.stop();
  });

  test("an inline definition creates a oneoff and runs it once; its key finds it again", async () => {
    const { executor, held } = heldExecutor();
    const { scheduler, source } = harness({ executor });

    const task = await startTask(source, {
      definition: { body: "Summarize the input." },
      input: { text: "hello" },
      idempotencyKey: "batch-1/item-1",
    });
    const oneoffs = [...loadOwnerTasks(workDir, WS, OWNER).values()];
    expect(oneoffs).toHaveLength(1);
    expect(oneoffs[0]?.kind).toBe("oneoff");
    expect(oneoffs[0]?.schedule).toBeUndefined();
    expect(oneoffs[0]?.prompt).toBe("Summarize the input.");
    expect(held[0]?.input).toEqual({ data: { text: "hello" } });

    const again = await startTask(source, {
      definition: { body: "Summarize the input." },
      input: { text: "hello" },
      idempotencyKey: "batch-1/item-1",
    });
    expect(again.taskId).toBe(task.taskId);
    expect(loadOwnerTasks(workDir, WS, OWNER).size).toBe(1);

    held[0]?.finish("summary");
    await flush();
    scheduler.stop();
  });

  test("an input that does not match the inputSchema is refused before any run", async () => {
    const { executor, held } = heldExecutor();
    const { scheduler, source } = harness({ executor });
    seed("typed", {
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    });

    const refused = await source.startToolAsTask(
      "run",
      { taskId: "typed", input: { link: "x" } },
      { ownerContext: OWNED },
    );
    expect("result" in refused && refused.result.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("does not match the inputSchema");
    expect(held).toHaveLength(0);
    expect(readRuns(workDir, WS, OWNER, "typed")).toHaveLength(0);

    const ok = await startTask(source, { taskId: "typed", input: { url: "https://example.com" } });
    expect(ok.status).toBe("working");
    held[0]?.finish("done");
    await flush();
    scheduler.stop();
  });

  test("a refused run leaves its idempotency key free, so a retry runs", async () => {
    const { executor, held } = heldExecutor();
    const { scheduler, source } = harness({ executor });
    seed("digest");
    await startTask(source, { taskId: "digest" });

    // Already running: refused, and the key is not claimed.
    const refused = await startTask(source, { taskId: "digest", idempotencyKey: "retry-me" });
    expect(refused.status).toBe("failed");
    expect(readIdempotencyKey(workDir, WS, OWNER, "digest", "retry-me")).toBeNull();

    held[0]?.finish("first");
    await flush();
    const retried = await startTask(source, { taskId: "digest", idempotencyKey: "retry-me" });
    expect(retried.taskId).not.toBe(refused.taskId);
    expect(retried.status).toBe("working");
    expect(held).toHaveLength(2);

    // Admitted, so the key now names this run.
    const repeat = await startTask(source, { taskId: "digest", idempotencyKey: "retry-me" });
    expect(repeat.taskId).toBe(retried.taskId);
    expect(held).toHaveLength(2);

    held[1]?.finish("second");
    await flush();
    scheduler.stop();
  });

  test("an inline run whose input is refused creates no one-off, and a corrected retry runs", async () => {
    const { executor, held } = heldExecutor();
    const { scheduler, source } = harness({ executor });
    const definition = {
      definition: {
        body: "Fetch the page.",
        manifest: {
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      },
      idempotencyKey: "page-1",
    };

    const refused = await source.startToolAsTask(
      "run",
      { ...definition, input: { link: "x" } },
      { ownerContext: OWNED },
    );
    expect("result" in refused && refused.result.isError).toBe(true);
    expect(loadOwnerTasks(workDir, WS, OWNER).size).toBe(0);

    const ok = await startTask(source, { ...definition, input: { url: "https://example.com" } });
    expect(ok.status).toBe("working");
    expect(loadOwnerTasks(workDir, WS, OWNER).size).toBe(1);

    held[0]?.finish("page");
    await flush();
    scheduler.stop();
  });

  test("a key reused with a different inline definition is refused", async () => {
    const { executor, held } = heldExecutor();
    const { scheduler, source } = harness({ executor });
    await startTask(source, { definition: { body: "Version one." }, idempotencyKey: "shared" });

    const changed = await source.startToolAsTask(
      "run",
      { definition: { body: "Version two." }, idempotencyKey: "shared" },
      { ownerContext: OWNED },
    );
    expect("result" in changed && changed.result.isError).toBe(true);
    expect(JSON.stringify(changed)).toContain("idempotencyKey reused with a different definition");
    expect(held).toHaveLength(1);

    held[0]?.finish("one");
    await flush();
    scheduler.stop();
  });

  test("is refused inside an unattended run", async () => {
    const { executor, held } = heldExecutor();
    const { scheduler, source, setUnattended } = harness({ executor });
    seed("digest");
    setUnattended(true);
    const refused = await source.startToolAsTask(
      "run",
      { taskId: "digest" },
      { ownerContext: OWNED },
    );
    expect("result" in refused && refused.result.isError).toBe(true);
    expect(held).toHaveLength(0);
    scheduler.stop();
  });
});
