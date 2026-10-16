/**
 * A run that ends with no deliverable tells the task's owner, once per failing
 * stretch, and a failure that auto-disables the task tells them again. Without
 * it a scheduled job whose connector dropped fails day after day with nothing
 * raised (#1769).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TaskDomainContext, updateTask } from "../../../../src/platform/tasks/domain.ts";
import {
  MAX_CONSECUTIVE_ERRORS,
  type RequestedRun,
  type RunFailedNotice,
  Scheduler,
} from "../../../../src/platform/tasks/scheduler.ts";
import { runFailedEnvelope } from "../../../../src/platform/tasks/source.ts";
import { loadOwnerTasks, loadTask, saveTask } from "../../../../src/platform/tasks/store.ts";
import type { Task, TaskRun, TaskRunResult } from "../../../../src/platform/tasks/types.ts";
import { createRunAdmission } from "../../../../src/runtime/admission.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";
const TASK_ID = "crm-suppression-sync";

let workDir: string;
let scheduler: Scheduler | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "run-failed-notice-"));
  seedWorkspaceRoot(workDir, WS);
});
afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: TASK_ID,
    name: "CRM suppression sync",
    prompt: "Copy the do-not-email list.",
    enabled: true,
    source: "user",
    ownerId: OWNER,
    workspaceId: WS,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    ...overrides,
  };
  saveTask(workDir, WS, OWNER, task);
  return task;
}

type Outcome = "ok" | "failed" | "incomplete" | "throws";

const SHAPES: Record<Exclude<Outcome, "throws">, Partial<TaskRun>> = {
  ok: { status: "success", stopReason: "complete", resultPreview: "synced" },
  failed: { status: "failure", stopReason: "error", resultPreview: undefined },
  incomplete: { status: "timeout", resultPreview: "partial" },
};

/** An executor that plays `outcomes` in order, one per run. */
function executor(outcomes: Outcome[]): ConstructorParameters<typeof Scheduler>[0] {
  let n = 0;
  return async (task, _signal, trigger, _input, _lease, runId) => {
    const outcome = outcomes[n++] ?? "ok";
    if (outcome === "throws") {
      throw Object.assign(new Error("com-crm__search matches no tool this run can reach"), {
        code: "declared_tools_unavailable",
      });
    }
    const id = runId ?? `run_${String(n).padStart(12, "0")}`;
    const run: TaskRun = {
      id,
      taskId: task.id,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      inputTokens: 10,
      outputTokens: 5,
      toolCalls: 0,
      iterations: 1,
      trigger,
      status: "success",
      ...SHAPES[outcome],
    };
    const result: TaskRunResult = {
      runId: id,
      taskId: task.id,
      completedAt: run.completedAt ?? "",
      output: run.resultPreview ?? "",
      activityLog: [],
      outputFiles: [],
      usage: { inputTokens: 10, outputTokens: 5, iterations: 1 },
    };
    return { run, result };
  };
}

interface Notified {
  run: TaskRun;
  notice: RunFailedNotice;
}

function start(outcomes: Outcome[]): Notified[] {
  const notified: Notified[] = [];
  scheduler = new Scheduler(executor(outcomes), {
    workDir,
    admission: createRunAdmission({ maxConcurrentRuns: 4, maxQueuedRuns: 4 }),
    notifyRunFailed: (_task, run, notice) => notified.push({ run, notice }),
  });
  scheduler.start();
  return notified;
}

let seq = 0;
async function runOnce(): Promise<TaskRun> {
  const requested: RequestedRun = {
    runId: `run_${String(++seq).padStart(12, "a")}`,
    requestedAt: new Date().toISOString(),
  };
  const ticket = scheduler?.requestRunNow(WS, OWNER, TASK_ID, requested);
  if (!ticket || ticket.state === "refused") throw new Error("run was refused");
  return ticket.run;
}

async function runTimes(n: number): Promise<TaskRun[]> {
  const runs: TaskRun[] = [];
  for (let i = 0; i < n; i++) runs.push(await runOnce());
  return runs;
}

describe("a run that ends with no deliverable", () => {
  it("test_failed_run_first_of_stretch_notifies_once", async () => {
    makeTask();
    const notified = start(["failed", "throws", "failed"]);
    const [first] = await runTimes(3);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.run.id).toBe(first?.id);
    expect(notified[0]?.notice.disabled).toBe(false);
    const task = loadTask(workDir, WS, OWNER, TASK_ID);
    expect(task?.consecutiveErrors).toBe(3);
    expect(task?.failureNoticeRunId).toBe(first?.id);
  });

  it("test_thrown_run_connector_unreachable_notifies", async () => {
    makeTask();
    const notified = start(["throws"]);
    const [run] = await runTimes(1);
    expect(run?.status).toBe("failure");
    expect(notified.map((n) => n.run.id)).toEqual([run?.id ?? ""]);
  });

  it("test_success_between_failures_notifies_each_stretch", async () => {
    makeTask();
    const notified = start(["failed", "ok", "failed"]);
    const [first, , third] = await runTimes(3);
    expect(notified.map((n) => n.run.id)).toEqual([first?.id ?? "", third?.id ?? ""]);
  });

  it("test_incomplete_run_starts_streak_without_claiming_notice", async () => {
    makeTask();
    const notified = start(["incomplete", "failed"]);
    const [, failed] = await runTimes(2);
    expect(notified.map((n) => n.run.id)).toEqual([failed?.id ?? ""]);
    expect(loadTask(workDir, WS, OWNER, TASK_ID)?.consecutiveErrors).toBe(2);
  });

  it("test_failure_that_auto_disables_notifies_disabled", async () => {
    makeTask({
      consecutiveErrors: MAX_CONSECUTIVE_ERRORS - 1,
      failureNoticeRunId: "run_earlier00001",
    });
    const notified = start(["failed"]);
    const [run] = await runTimes(1);
    expect(notified).toEqual([
      { run: expect.objectContaining({ id: run?.id }), notice: { disabled: true } },
    ]);
    expect(loadTask(workDir, WS, OWNER, TASK_ID)?.enabled).toBe(false);
  });

  it("test_successful_run_notifies_nothing", async () => {
    makeTask();
    const notified = start(["ok", "ok"]);
    await runTimes(2);
    expect(notified).toHaveLength(0);
  });
});

describe("an edit that resets the streak re-arms the notice", () => {
  const ctx: TaskDomainContext = {
    definitions: () => loadOwnerTasks(workDir, WS, OWNER),
    save: (map) => {
      for (const task of map.values()) saveTask(workDir, WS, OWNER, task);
    },
    reloadScheduler: () => {},
    defaultTimezone: "UTC",
  };

  it("test_reenable_clears_notice_next_failure_notifies", async () => {
    makeTask({
      enabled: false,
      consecutiveErrors: MAX_CONSECUTIVE_ERRORS,
      failureNoticeRunId: "run_earlier00001",
    });
    updateTask(TASK_ID, { enabled: true }, ctx);
    expect(loadTask(workDir, WS, OWNER, TASK_ID)?.failureNoticeRunId).toBeUndefined();
    const notified = start(["failed"]);
    const [run] = await runTimes(1);
    expect(notified.map((n) => n.run.id)).toEqual([run?.id ?? ""]);
  });

  it("test_once_rearm_clears_notice_next_failure_notifies", async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    makeTask({
      schedule: { type: "once", at: past },
      onceDone: { at: past, outcome: "ran" },
      consecutiveErrors: 1,
      failureNoticeRunId: "run_earlier00001",
    });
    const at = new Date(Date.now() + 3_600_000).toISOString();
    updateTask(TASK_ID, { schedule: { type: "once", at } }, ctx);
    expect(loadTask(workDir, WS, OWNER, TASK_ID)?.failureNoticeRunId).toBeUndefined();
    const notified = start(["failed"]);
    const [run] = await runTimes(1);
    expect(notified.map((n) => n.run.id)).toEqual([run?.id ?? ""]);
  });
});

describe("the run-failed notice is workspace-visible, so it is generic", () => {
  it("names the run, never the task or the run's error", () => {
    const task = makeTask();
    const run: TaskRun = {
      id: "run_cccccccccccc",
      taskId: TASK_ID,
      startedAt: new Date().toISOString(),
      status: "failure",
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      iterations: 0,
      error: "com-crm__search matches no tool this run can reach",
    };
    for (const disabled of [false, true]) {
      const envelope = runFailedEnvelope(task, run, { disabled });
      const visible = JSON.stringify(envelope);
      expect(envelope.name).toBe(disabled ? "task.disabled" : "task.run.failed");
      expect(visible).toContain("run_cccccccccccc");
      for (const secret of ["suppression", "CRM", TASK_ID, "com-crm", "matches no tool"]) {
        expect(visible).not.toContain(secret);
      }
    }
  });
});
