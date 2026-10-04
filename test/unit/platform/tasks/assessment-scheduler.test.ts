/**
 * Assessment as the scheduler runs it: after a run is recorded, a run that
 * left a deliverable is assessed and the assessment written onto its record;
 * the record's execution never changes; a `fail` sets off the task's
 * `onPoorResult`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labelOf } from "../../../../src/platform/tasks/assessment.ts";
import { assessRun } from "../../../../src/platform/tasks/judge.ts";
import { type RequestedRun, Scheduler } from "../../../../src/platform/tasks/scheduler.ts";
import {
  loadTask,
  readRuns,
  readRunTicket,
  saveTask,
} from "../../../../src/platform/tasks/store.ts";
import type {
  RunAssessment,
  Task,
  TaskRun,
  TaskRunResult,
} from "../../../../src/platform/tasks/types.ts";
import { createRunAdmission } from "../../../../src/runtime/admission.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";

let workDir: string;
let scheduler: Scheduler | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "assessment-scheduler-"));
  seedWorkspaceRoot(workDir, WS);
});
afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: "judged",
    name: "Judged",
    prompt: "Write the report.",
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
    criteria: [{ id: "sourced", rule: "Every claim cites a source.", type: "boolean" }],
    ...overrides,
  };
  saveTask(workDir, WS, OWNER, task);
  return task;
}

let counter = 0;
interface ExecCall {
  prompt?: string;
  input?: unknown;
}

/** An executor that records what it was asked and returns `shape(n)` for the n-th run. */
function executor(
  calls: ExecCall[],
  shape: (n: number) => Partial<TaskRun> = () => ({}),
): ConstructorParameters<typeof Scheduler>[0] {
  return async (task, _signal, trigger, input, _lease, runId) => {
    calls.push({ prompt: input?.preamble, input: input?.data });
    const n = calls.length;
    const id = runId ?? `run_${String(++counter).padStart(12, "0")}`;
    const run: TaskRun = {
      id,
      taskId: task.id,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "success",
      inputTokens: 10,
      outputTokens: 5,
      toolCalls: 0,
      iterations: 1,
      stopReason: "complete",
      resultPreview: "the report",
      trigger,
      ...shape(n),
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

function verdict(v: RunAssessment["verdict"]): RunAssessment {
  return {
    verdict: v,
    assessedAt: new Date().toISOString(),
    criteria: [
      {
        id: "sourced",
        answer: v !== "fail",
        passed: v !== "fail",
        confidence: v === "uncertain" ? 0.4 : 0.95,
      },
    ],
    judge: { server: "judge", id: "stub", calibrated: true },
  };
}

function start(
  calls: ExecCall[],
  opts: {
    shape?: (n: number) => Partial<TaskRun>;
    assess?: (n: number) => RunAssessment;
    notified?: TaskRun[];
  } = {},
): { assessed: TaskRun[] } {
  const assessed: TaskRun[] = [];
  let n = 0;
  scheduler = new Scheduler(executor(calls, opts.shape), {
    workDir,
    admission: createRunAdmission({ maxConcurrentRuns: 4, maxQueuedRuns: 4 }),
    assess: async (_task, run) => {
      assessed.push(run);
      return opts.assess?.(++n) ?? verdict("pass");
    },
    notifyPoorResult: (_task, run) => opts.notified?.push(run),
  });
  scheduler.start();
  return { assessed };
}

function requested(runId: string): RequestedRun {
  return { runId, requestedAt: new Date().toISOString(), input: { company: "acme-corp" } };
}

async function runOnce(runId = "run_requested001"): Promise<TaskRun> {
  const ticket = scheduler?.requestRunNow(WS, OWNER, "judged", requested(runId));
  if (!ticket || ticket.state === "refused") throw new Error("run was refused");
  return ticket.run;
}

describe("assessment after a run", () => {
  it("records the assessment on the run's index line and ticket, and the awaited run carries it", async () => {
    makeTask();
    const calls: ExecCall[] = [];
    start(calls);
    const run = await runOnce();
    expect(run.assessment?.verdict).toBe("pass");
    const [indexed] = readRuns(workDir, WS, OWNER, "judged");
    expect(indexed?.assessment?.verdict).toBe("pass");
    expect(readRunTicket(workDir, WS, OWNER, run.id)?.run.assessment?.verdict).toBe("pass");
    expect(labelOf(run)).toBe("Succeeded");
  });

  it("never changes execution: a failing assessment leaves status and error accounting alone", async () => {
    makeTask({ onPoorResult: "record" });
    const calls: ExecCall[] = [];
    start(calls, { assess: () => verdict("fail") });
    const run = await runOnce();
    expect(run.status).toBe("success");
    expect(run.assessment?.verdict).toBe("fail");
    const task = loadTask(workDir, WS, OWNER, "judged");
    expect(task?.lastRunStatus).toBe("success");
    expect(task?.consecutiveErrors).toBe(0);
    expect(labelOf(run)).toBe("Poor result");
  });

  it("does not assess a run that left no deliverable", async () => {
    makeTask();
    const calls: ExecCall[] = [];
    const { assessed } = start(calls, {
      shape: () => ({ status: "failure", stopReason: "error", resultPreview: undefined }),
    });
    const run = await runOnce();
    expect(run.assessment).toBeUndefined();
    expect(assessed).toHaveLength(0);
  });

  it("assesses an incomplete run (stopped at a limit with a partial deliverable)", async () => {
    makeTask();
    const calls: ExecCall[] = [];
    const { assessed } = start(calls, {
      shape: () => ({ status: "failure", stopReason: "max_input_tokens", error: "cap" }),
    });
    const run = await runOnce();
    expect(assessed).toHaveLength(1);
    expect(run.status).toBe("failure");
    expect(run.assessment?.verdict).toBe("pass");
    expect(labelOf(run)).toBe("Needs review");
    // The error streak counts the stop as it always did.
    expect(loadTask(workDir, WS, OWNER, "judged")?.consecutiveErrors).toBe(1);
  });

  it("a scheduled run is recorded before it is judged", async () => {
    makeTask({ schedule: { type: "interval", intervalMs: 60_000 } });
    const calls: ExecCall[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    scheduler = new Scheduler(executor(calls), {
      workDir,
      admission: createRunAdmission({ maxConcurrentRuns: 4, maxQueuedRuns: 4 }),
      assess: async () => {
        await gate;
        return verdict("pass");
      },
    });
    scheduler.start();
    const task = loadTask(workDir, WS, OWNER, "judged");
    if (!task) throw new Error("task missing");
    task.nextRunAt = new Date(Date.now() - 1000).toISOString();
    saveTask(workDir, WS, OWNER, task);
    scheduler.reload();
    await scheduler.onTimer();
    // The timer is back while the judge has not answered.
    const [first] = readRuns(workDir, WS, OWNER, "judged");
    expect(first?.status).toBe("success");
    expect(first?.assessment).toBeUndefined();
    release();
    await scheduler.assessmentsSettled();
    expect(readRuns(workDir, WS, OWNER, "judged")[0]?.assessment?.verdict).toBe("pass");
  });
});

describe("onPoorResult", () => {
  it("record: nothing more", async () => {
    makeTask({ onPoorResult: "record" });
    const calls: ExecCall[] = [];
    const notified: TaskRun[] = [];
    start(calls, { assess: () => verdict("fail"), notified });
    await runOnce();
    await scheduler?.assessmentsSettled();
    expect(notified).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("notify (the default): the owner is told, naming the run", async () => {
    makeTask();
    const calls: ExecCall[] = [];
    const notified: TaskRun[] = [];
    start(calls, { assess: () => verdict("fail"), notified });
    const run = await runOnce();
    expect(notified.map((r) => r.id)).toEqual([run.id]);
    expect(notified[0]?.assessment?.verdict).toBe("fail");
  });

  it("uncertain sets off nothing", async () => {
    makeTask({ onPoorResult: "retry_once" });
    const calls: ExecCall[] = [];
    const notified: TaskRun[] = [];
    start(calls, { assess: () => verdict("uncertain"), notified });
    const run = await runOnce();
    await scheduler?.assessmentsSettled();
    expect(labelOf(run)).toBe("Needs review");
    expect(notified).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("retry_once: one retry, with retryOf, the same input, and the failed criteria as guidance", async () => {
    makeTask({ onPoorResult: "retry_once" });
    const calls: ExecCall[] = [];
    const notified: TaskRun[] = [];
    start(calls, { assess: (n) => verdict(n === 1 ? "fail" : "pass"), notified });
    const first = await runOnce();
    await scheduler?.assessmentsSettled();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input).toEqual({ company: "acme-corp" });
    expect(calls[1]?.prompt).toContain(first.id);
    expect(calls[1]?.prompt).toContain("Every claim cites a source.");
    const runs = readRuns(workDir, WS, OWNER, "judged");
    const retry = runs.find((r) => r.id !== first.id);
    expect(retry?.retryOf).toBe(first.id);
    expect(retry?.assessment?.verdict).toBe("pass");
    expect(notified).toHaveLength(0);
  });

  it("retry_once retries only once per original run: a failing retry notifies instead", async () => {
    makeTask({ onPoorResult: "retry_once" });
    const calls: ExecCall[] = [];
    const notified: TaskRun[] = [];
    start(calls, { assess: () => verdict("fail"), notified });
    const first = await runOnce();
    await scheduler?.assessmentsSettled();
    expect(calls).toHaveLength(2);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.retryOf).toBe(first.id);
  });

  it("retry_once falls back to notify when the retry is refused (token budget spent)", async () => {
    // The first run spends past the budget, so the task is disabled and Run now refuses the retry.
    makeTask({ onPoorResult: "retry_once", tokenBudget: { maxInputTokens: 5 } });
    const calls: ExecCall[] = [];
    const notified: TaskRun[] = [];
    start(calls, { assess: () => verdict("fail"), notified });
    const first = await runOnce();
    await scheduler?.assessmentsSettled();
    expect(calls).toHaveLength(1);
    expect(notified.map((r) => r.id)).toEqual([first.id]);
    const refused = readRuns(workDir, WS, OWNER, "judged").find((r) => r.id !== first.id);
    expect(refused?.status).toBe("skipped");
  });

  it("criteria the judge could not answer are uncertain: Needs review, and no policy fires", async () => {
    makeTask({ onPoorResult: "retry_once" });
    const calls: ExecCall[] = [];
    const notified: TaskRun[] = [];
    scheduler = new Scheduler(executor(calls), {
      workDir,
      admission: createRunAdmission({ maxConcurrentRuns: 4, maxQueuedRuns: 4 }),
      // No judge connected in the workspace.
      assess: (task, run, result) =>
        assessRun(task, run, result, {
          port: { sources: async () => [], call: async () => ({ outcome: "error" }) },
        }),
      notifyPoorResult: (_t, run) => notified.push(run),
    });
    scheduler.start();
    const run = await runOnce();
    await scheduler.assessmentsSettled();
    expect(run.assessment?.verdict).toBe("uncertain");
    expect(run.assessment?.reason?.code).toBe("no_judge");
    expect(labelOf(run)).toBe("Needs review");
    expect(calls).toHaveLength(1);
    expect(notified).toHaveLength(0);
  });

  it("a task with nothing to check is not_assessed and reads Succeeded", async () => {
    makeTask({ criteria: undefined });
    const calls: ExecCall[] = [];
    scheduler = new Scheduler(executor(calls), {
      workDir,
      admission: createRunAdmission({ maxConcurrentRuns: 4, maxQueuedRuns: 4 }),
      assess: (task, run, result) =>
        assessRun(task, run, result, {
          port: { sources: async () => [], call: async () => ({ outcome: "error" }) },
        }),
    });
    scheduler.start();
    const run = await runOnce();
    expect(run.assessment?.verdict).toBe("not_assessed");
    expect(labelOf(run)).toBe("Succeeded");
  });
});
