/**
 * Batches: one task run over many inputs. The driver feeds items into runs
 * through the scheduler's ordinary run path, held to the batch's concurrency
 * and to the door's admission; a batch budget is one spend account every run
 * names; the stop rule pauses on a collapsed pass rate; a restart reconciles.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BatchDriver,
  batchAccountId,
  MAX_BATCH_ITEMS,
} from "../../../../src/platform/tasks/batch.ts";
import { listBatches, readBatchItems } from "../../../../src/platform/tasks/batch-store.ts";
import {
  handleBatch,
  handleBatchControl,
  handleBatches,
  handleRunBatch,
} from "../../../../src/platform/tasks/batch-tools.ts";
import { taskBatchesDir } from "../../../../src/platform/tasks/paths.ts";
import { type Executor, Scheduler } from "../../../../src/platform/tasks/scheduler.ts";
import type { ToolContext } from "../../../../src/platform/tasks/server.ts";
import { batchPausedEnvelope } from "../../../../src/platform/tasks/source.ts";
import {
  loadOwnerTasks,
  readRunResult,
  readRuns,
  readRunTicket,
  saveTask,
} from "../../../../src/platform/tasks/store.ts";
import type {
  Batch,
  RunAssessment,
  Task,
  TaskRun,
  TaskRunResult,
} from "../../../../src/platform/tasks/types.ts";
import { createRunAdmission, type RunAdmission } from "../../../../src/runtime/admission.ts";
import { createSpendBalances, type SpendBalances } from "../../../../src/runtime/spend.ts";
import { isTaskForbiddenIdentityTool } from "../../../../src/tools/identity-sources.ts";
import { ledgerCostOfTaskRuns } from "../../../../src/usage/aggregate.ts";
import { UsageLedger } from "../../../../src/usage/ledger.ts";
import type { UsageRates } from "../../../../src/usage/types.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_batch";

let workDir: string;
const toStop: Array<{ stop(): void }> = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "task-batch-"));
  seedWorkspaceRoot(workDir, WS);
});

afterEach(() => {
  for (const s of toStop.splice(0)) s.stop();
  rmSync(workDir, { recursive: true, force: true });
});

/** A dollar per thousand tokens, in and out, so the arithmetic reads plainly. */
const RATES: UsageRates = {
  input: 1000,
  output: 1000,
  cacheRead: 1000,
  cacheWrite5m: 1000,
  cacheWrite1h: 1000,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: "enrich",
    name: "Enrich",
    prompt: "SECRET-PROMPT: enrich the company.",
    enabled: true,
    source: "user",
    ownerId: OWNER,
    workspaceId: WS,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    criteria: [{ id: "cited", rule: "SECRET-RULE: every claim is cited.", type: "boolean" }],
    inputSchema: {
      type: "object",
      properties: { v: { type: "string" } },
      required: ["v"],
    },
    ...overrides,
  };
  saveTask(workDir, WS, OWNER, task);
  return task;
}

/** A held executor: each call waits for `release()` (or its abort) before it ends. */
interface Gate {
  release: () => void;
  input: unknown;
  runId?: string;
}

interface HarnessOptions {
  maxConcurrentRuns?: number;
  maxQueuedRuns?: number;
  /** Hold every run until the test releases it. */
  gated?: boolean;
  /** Emulate the door's spend accounts: each run makes `calls` model calls of 100 in / 100 out. */
  door?: { calls: number };
  /** The run's status for an input. */
  behave?: (input: unknown) => Partial<TaskRun>;
  spend?: SpendBalances;
  admission?: RunAdmission;
  /** Seed the batch account from the usage ledger, as the tasks source does. */
  ledger?: boolean;
}

interface Harness {
  scheduler: Scheduler;
  driver: BatchDriver;
  spend: SpendBalances;
  admission: RunAdmission;
  ctx: ToolContext;
  gates: Gate[];
  executing: () => number;
  maxExecuting: () => number;
  paused: Batch[];
  totalSpent: () => number;
}

function verdictFor(input: unknown): RunAssessment["verdict"] {
  const v = (input as { v?: string } | undefined)?.v ?? "pass";
  return v === "fail" || v === "uncertain" || v === "not_assessed" ? v : "pass";
}

function harness(opts: HarnessOptions = {}): Harness {
  const spend = opts.spend ?? createSpendBalances();
  const admission =
    opts.admission ??
    createRunAdmission({
      maxConcurrentRuns: opts.maxConcurrentRuns ?? 4,
      maxQueuedRuns: opts.maxQueuedRuns ?? 50,
    });
  const gates: Gate[] = [];
  let executing = 0;
  let maxExecuting = 0;
  let totalSpent = 0;
  const executor: Executor = async (task, signal, trigger, input, _lease, runId, extra) => {
    executing++;
    maxExecuting = Math.max(maxExecuting, executing);
    try {
      if (opts.gated) {
        await new Promise<void>((resolve, reject) => {
          gates.push({ release: resolve, input: input?.data, runId });
          signal.addEventListener("abort", () =>
            reject(new DOMException("The run was aborted", "AbortError")),
          );
        });
      }
      let costUsd = 0;
      let stop: string | undefined;
      if (opts.door) {
        // What the door does with the accounts a run names (`Runtime.startRun`).
        const hold = spend.open(extra ?? [], { model: "m", rates: RATES });
        try {
          for (let i = 0; i < opts.door.calls; i++) {
            const allowed = hold.check({
              inputTokens: 100,
              maxOutputTokens: 100,
              minOutputTokens: 100,
            });
            if ("accountId" in allowed) {
              stop = allowed.accountId;
              break;
            }
            await Bun.sleep(1);
            hold.debit({ inputTokens: 100, outputTokens: 100 });
            costUsd += 0.2;
            totalSpent += 0.2;
          }
        } finally {
          hold.release();
        }
      }
      const id = runId ?? `run_${Math.random().toString(16).slice(2, 14)}`;
      const now = new Date().toISOString();
      const run: TaskRun = {
        id,
        taskId: task.id,
        startedAt: now,
        completedAt: now,
        status: stop ? "failure" : "success",
        inputTokens: 100,
        outputTokens: 50,
        toolCalls: 0,
        iterations: 1,
        stopReason: stop ? "spend_limit" : "complete",
        ...(stop ? { spendAccountId: stop } : { resultPreview: "{}" }),
        trigger,
        costUsd: opts.door ? costUsd : 0.01,
        ...opts.behave?.(input?.data),
      };
      const result: TaskRunResult = {
        runId: id,
        taskId: task.id,
        completedAt: now,
        output: run.resultPreview ?? "",
        activityLog: [],
        outputFiles: [],
        usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
        structured: { company: `co-${JSON.stringify(input?.data)}`, score: 3, nested: { a: 1 } },
      };
      return { run, result };
    } finally {
      executing--;
    }
  };
  const scheduler = new Scheduler(executor, {
    workDir,
    admission,
    assess: async (_task, run) => ({
      verdict: verdictFor(run.input),
      assessedAt: new Date().toISOString(),
    }),
  });
  scheduler.start();
  const paused: Batch[] = [];
  const driver = new BatchDriver({
    workDir,
    scheduler,
    spend,
    notifyPaused: (batch) => paused.push(batch),
    retryDelayMs: 20,
    ...(opts.ledger
      ? {
          ledgerSpent: (batch: Batch, runIds: ReadonlySet<string>) =>
            ledgerCostOfTaskRuns(
              workDir,
              runIds,
              { from: batch.createdAt.slice(0, 10), to: new Date().toISOString().slice(0, 10) },
              batch.workspaceId,
            ),
        }
      : {}),
  });
  driver.start();
  toStop.push(driver, scheduler);
  const ctx: ToolContext = {
    definitions: () => loadOwnerTasks(workDir, WS, OWNER),
    save: (map) => {
      for (const t of map.values()) saveTask(workDir, WS, OWNER, t);
    },
    reloadScheduler: () => scheduler.reload(),
    runNow: (id, requested) => scheduler.requestRunNow(WS, OWNER, id, requested),
    cancelRun: (id) => scheduler.cancelRun(WS, OWNER, id),
    readRuns: (id, o) => readRuns(workDir, WS, OWNER, id, o),
    readRunsPage: () => ({ runs: [] }),
    readAllRuns: () => [],
    readRunResult: (id, runId) => readRunResult(workDir, WS, OWNER, id, runId),
    defaultTimezone: "UTC",
    currentUserId: OWNER,
    currentWorkspaceId: WS,
    batches: {
      create: (spec) => driver.create({ ...spec, wsId: WS, ownerId: OWNER, createdBy: OWNER }),
      get: (id) => driver.get(WS, OWNER, id),
      findByKey: (key) => {
        const found = listBatches(workDir, WS, OWNER).find((b) => b.idempotencyKey === key);
        return found ?? null;
      },
      control: (id, action, budget) => driver.control(WS, OWNER, id, action, budget),
      list: () => listBatches(workDir, WS, OWNER),
      maxConcurrentRuns: admission.limits.maxConcurrentRuns,
    },
  };
  return {
    scheduler,
    driver,
    spend,
    admission,
    ctx,
    gates,
    executing: () => executing,
    maxExecuting: () => maxExecuting,
    paused,
    totalSpent: () => totalSpent,
  };
}

async function waitFor(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

function batchOf(h: Harness, id: string): Batch {
  const found = h.driver.get(WS, OWNER, id);
  if (!found) throw new Error(`no batch ${id}`);
  return found.batch;
}

function items(...vs: string[]): unknown[] {
  return vs.map((v) => ({ v }));
}

describe("tasks__run_batch validation", () => {
  it("refuses the whole batch when any item fails the input schema, naming the first bad indices, and creates nothing", () => {
    const h = harness();
    makeTask();
    expect(() =>
      handleRunBatch(
        { taskId: "enrich", items: [{ v: "a" }, { wrong: 1 }, { v: "b" }, 42] },
        h.ctx,
      ),
    ).toThrow(/2 of 4 items would be refused.*item 1:.*item 3:/);
    expect(existsSync(taskBatchesDir(workDir, WS, OWNER))).toBe(false);
  });

  it("refuses an inline batch with a bad item without creating its one-off", () => {
    const h = harness();
    const before = loadOwnerTasks(workDir, WS, OWNER).size;
    expect(() =>
      handleRunBatch(
        {
          prompt: "Do it",
          inputSchema: { type: "object", required: ["v"] },
          items: [{ v: "a" }, {}],
        },
        h.ctx,
      ),
    ).toThrow(/item 1:/);
    expect(loadOwnerTasks(workDir, WS, OWNER).size).toBe(before);
  });

  it(`refuses more than ${MAX_BATCH_ITEMS} items`, () => {
    const h = harness();
    makeTask({ inputSchema: undefined });
    const many = Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => 1);
    expect(() => handleRunBatch({ taskId: "enrich", items: many }, h.ctx)).toThrow(
      /at most 10000 items/,
    );
  });

  it("refuses a stop rule on a task whose runs are never assessed", () => {
    const h = harness();
    makeTask({ criteria: undefined, inputSchema: undefined });
    expect(() =>
      handleRunBatch(
        { taskId: "enrich", items: [1], stopWhen: { minPassRate: 0.5, afterItems: 1 } },
        h.ctx,
      ),
    ).toThrow(/no criteria and no outputSchema/);
  });

  it("holds concurrency to the runtime's concurrent-run limit", async () => {
    const h = harness({ maxConcurrentRuns: 2 });
    makeTask();
    const out = handleRunBatch({ taskId: "enrich", items: items("a"), concurrency: 9 }, h.ctx);
    expect(out.batch.concurrency).toBe(2);
    expect(out.message).toContain("held to 2");
    await waitFor(() => batchOf(h, out.batch.id).state === "completed", "completion");
  });
});

describe("idempotency", () => {
  it("returns the batch an earlier call with the same key made, and refuses the key for a different batch", async () => {
    const h = harness();
    makeTask();
    const first = handleRunBatch(
      { taskId: "enrich", items: items("a", "b"), idempotencyKey: "k1" },
      h.ctx,
    );
    const again = handleRunBatch(
      { taskId: "enrich", items: items("a", "b"), idempotencyKey: "k1" },
      h.ctx,
    );
    expect(again.existing).toBe(true);
    expect(again.batch.id).toBe(first.batch.id);
    expect(listBatches(workDir, WS, OWNER)).toHaveLength(1);
    expect(() =>
      handleRunBatch({ taskId: "enrich", items: items("a"), idempotencyKey: "k1" }, h.ctx),
    ).toThrow(/reused for a different batch/);
    await waitFor(() => batchOf(h, first.batch.id).state === "completed", "completion");
  });
});

describe("the driver", () => {
  it("runs every item, at most `concurrency` at once, and completes with counts and cost", async () => {
    const h = harness({ gated: true, maxConcurrentRuns: 4 });
    makeTask();
    const out = handleRunBatch(
      {
        taskId: "enrich",
        items: items("pass", "fail", "uncertain", "pass", "pass"),
        concurrency: 2,
      },
      h.ctx,
    );
    for (let released = 0; released < 5; released++) {
      await waitFor(() => h.gates.length > released, `run ${released}`);
      expect(h.executing()).toBeLessThanOrEqual(2);
      h.gates[released]!.release();
    }
    await waitFor(() => batchOf(h, out.batch.id).state === "completed", "completion");
    expect(h.maxExecuting()).toBe(2);
    const batch = batchOf(h, out.batch.id);
    expect(batch.counts).toMatchObject({ pass: 3, fail: 1, uncertain: 1, pending: 0, running: 0 });
    expect(batch.costUsd).toBeCloseTo(0.05, 6);
  });

  it("stays under the door's admission: beyond its slots, the batch's runs wait queued", async () => {
    const h = harness({ gated: true, maxConcurrentRuns: 1 });
    makeTask();
    h.scheduler.reload();
    const created = h.driver.create({
      wsId: WS,
      ownerId: OWNER,
      task: makeTask(),
      inputs: items("a", "b", "c"),
      concurrency: 2,
      createdBy: OWNER,
    });
    await waitFor(() => h.gates.length === 1, "first run");
    const state = () => readBatchItems(workDir, WS, OWNER, created.id).map((i) => i.state);
    expect(state()).toEqual(["running", "queued", "pending"]);
    expect(h.admission.inFlight()).toBe(1);
    h.gates[0]!.release();
    await waitFor(() => h.gates.length === 2, "second run");
    expect(h.executing()).toBe(1);
    h.gates[1]!.release();
    await waitFor(() => h.gates.length === 3, "third run");
    h.gates[2]!.release();
    await waitFor(() => batchOf(h, created.id).state === "completed", "completion");
    expect(h.maxExecuting()).toBe(1);
  });

  it("stamps each run with its batch id and item index, on the run record and its ticket", async () => {
    const h = harness();
    makeTask();
    const out = handleRunBatch({ taskId: "enrich", items: items("a", "b") }, h.ctx);
    await waitFor(() => batchOf(h, out.batch.id).state === "completed", "completion");
    const runs = readRuns(workDir, WS, OWNER, "enrich");
    expect(runs.map((r) => [r.batchId, r.batchIndex]).sort()).toEqual([
      [out.batch.id, 0],
      [out.batch.id, 1],
    ]);
    const [item] = readBatchItems(workDir, WS, OWNER, out.batch.id);
    const ticket = readRunTicket(workDir, WS, OWNER, item!.runId!);
    expect(ticket?.run.batchId).toBe(out.batch.id);
    expect(ticket?.run.batchIndex).toBe(0);
  });

  it("sets off no per-run poor-result notice for a batch item", async () => {
    const notified: TaskRun[] = [];
    const admission = createRunAdmission({ maxConcurrentRuns: 2 });
    const scheduler = new Scheduler(
      async (task, _s, trigger, input, _l, runId) => ({
        run: {
          id: runId ?? "run_x",
          taskId: task.id,
          startedAt: new Date().toISOString(),
          status: "success",
          inputTokens: 1,
          outputTokens: 1,
          toolCalls: 0,
          iterations: 1,
          resultPreview: "x",
          trigger,
          input: input?.data,
        },
        result: null,
      }),
      {
        workDir,
        admission,
        assess: async () => ({ verdict: "fail", assessedAt: new Date().toISOString() }),
        notifyPoorResult: (_t, run) => notified.push(run),
      },
    );
    const task = makeTask({ onPoorResult: "notify" });
    scheduler.start();
    const driver = new BatchDriver({ workDir, scheduler });
    toStop.push(driver, scheduler);
    const batch = driver.create({
      wsId: WS,
      ownerId: OWNER,
      task,
      inputs: items("a", "b"),
      concurrency: 2,
      createdBy: OWNER,
    });
    await waitFor(() => driver.get(WS, OWNER, batch.id)?.batch.state === "completed", "done");
    expect(driver.get(WS, OWNER, batch.id)?.batch.counts.fail).toBe(2);
    expect(notified).toHaveLength(0);
  });
});

describe("the batch budget", () => {
  it("is one shared balance: concurrent runs cannot together pass it, and the batch pauses with the rest pending", async () => {
    const h = harness({ door: { calls: 3 }, maxConcurrentRuns: 4 });
    makeTask();
    // Each run would spend $0.60 (three calls of $0.20); $1.00 covers five calls.
    const out = handleRunBatch(
      {
        taskId: "enrich",
        items: items("a", "b", "c", "d", "e", "f"),
        concurrency: 3,
        budgetUsd: 1,
      },
      h.ctx,
    );
    await waitFor(() => batchOf(h, out.batch.id).state === "paused", "budget pause");
    await waitFor(() => batchOf(h, out.batch.id).counts.running === 0, "runs to end");
    const batch = batchOf(h, out.batch.id);
    expect(batch.pause?.reason).toBe("budget");
    expect(h.totalSpent()).toBeLessThanOrEqual(1 + 1e-9);
    expect(batch.costUsd).toBeLessThanOrEqual(1 + 1e-9);
    expect(batch.counts.pending).toBeGreaterThan(0);
    expect(h.paused.map((b) => b.pause?.reason)).toContain("budget");
    // The balance is released once nothing holds it.
    expect(h.spend.balance(batchAccountId(batch))).toBeUndefined();
  });

  it("resumes under a raised budget and runs the items the budget stopped", async () => {
    const h = harness({ door: { calls: 1 }, maxConcurrentRuns: 1 });
    makeTask();
    const out = handleRunBatch(
      { taskId: "enrich", items: items("a", "b", "c"), concurrency: 1, budgetUsd: 0.3 },
      h.ctx,
    );
    await waitFor(() => batchOf(h, out.batch.id).state === "paused", "budget pause");
    await waitFor(() => batchOf(h, out.batch.id).counts.running === 0, "runs to end");
    expect(() =>
      handleBatchControl({ batchId: out.batch.id, action: "resume", budgetUsd: 0.1 }, h.ctx),
    ).toThrow(/more than/);
    handleBatchControl({ batchId: out.batch.id, action: "resume", budgetUsd: 5 }, h.ctx);
    await waitFor(() => batchOf(h, out.batch.id).state === "completed", "completion");
    const batch = batchOf(h, out.batch.id);
    expect(batch.counts.pass).toBe(3);
    expect(batch.budgetUsd).toBe(5);
  });
});

describe("the stop rule", () => {
  it("pauses when pass / (pass + fail) falls below minPassRate after afterItems assessed runs, and notifies with counts only", async () => {
    const h = harness();
    makeTask();
    const out = handleRunBatch(
      {
        taskId: "enrich",
        items: items("fail", "fail", "uncertain", "pass", "pass", "pass"),
        concurrency: 1,
        stopWhen: { minPassRate: 0.5, afterItems: 3 },
      },
      h.ctx,
    );
    await waitFor(() => batchOf(h, out.batch.id).state === "paused", "pass-rate pause");
    const batch = batchOf(h, out.batch.id);
    expect(batch.pause?.reason).toBe("pass_rate");
    expect(batch.counts).toMatchObject({ fail: 2, uncertain: 1, pass: 0, pending: 3 });
    expect(h.paused).toHaveLength(1);

    const envelope = JSON.stringify(batchPausedEnvelope(h.paused[0]!));
    expect(envelope).toContain(batch.id);
    expect(envelope).not.toContain("Enrich");
    expect(envelope).not.toContain("enrich");
    expect(envelope).not.toContain("SECRET");
    expect(envelope).not.toContain("minPassRate");

    // A resume disarms the rule: the rest runs.
    handleBatchControl({ batchId: out.batch.id, action: "resume" }, h.ctx);
    await waitFor(() => batchOf(h, out.batch.id).state === "completed", "completion");
  });

  it("excludes uncertain: judge doubt alone never pauses a batch", async () => {
    const h = harness();
    makeTask();
    const out = handleRunBatch(
      {
        taskId: "enrich",
        items: items("uncertain", "uncertain", "uncertain", "pass", "uncertain", "fail"),
        concurrency: 1,
        stopWhen: { minPassRate: 0.5, afterItems: 3 },
      },
      h.ctx,
    );
    await waitFor(() => batchOf(h, out.batch.id).state === "completed", "completion");
    // pass 1, fail 1: a rate of exactly 0.5 is not below it.
    expect(batchOf(h, out.batch.id).counts).toMatchObject({ uncertain: 4, pass: 1, fail: 1 });
    expect(h.paused).toHaveLength(0);
  });
});

describe("tasks__batch reads", () => {
  it("returns status, pages item results by cursor, filters by verdict, and carries structured fields", async () => {
    const h = harness();
    makeTask();
    const out = handleRunBatch(
      { taskId: "enrich", items: items("pass", "fail", "pass", "fail", "uncertain") },
      h.ctx,
    );
    await waitFor(() => batchOf(h, out.batch.id).state === "completed", "completion");

    const status = handleBatch({ batchId: out.batch.id }, h.ctx);
    expect(status.results).toBeUndefined();
    expect(status.batch.done).toBe(5);
    expect(status.batch.passRate).toBeCloseTo(0.5);

    const first = handleBatch({ batchId: out.batch.id, results: true, limit: 2 }, h.ctx);
    expect(first.results?.map((r) => r.index)).toEqual([0, 1]);
    expect(first.nextCursor).toBe(2);
    const second = handleBatch(
      { batchId: out.batch.id, results: true, limit: 2, cursor: first.nextCursor },
      h.ctx,
    );
    expect(second.results?.map((r) => r.index)).toEqual([2, 3]);
    const last = handleBatch(
      { batchId: out.batch.id, results: true, limit: 2, cursor: second.nextCursor },
      h.ctx,
    );
    expect(last.results?.map((r) => r.index)).toEqual([4]);
    expect(last.nextCursor).toBeUndefined();

    const failing = handleBatch({ batchId: out.batch.id, verdict: "fail" }, h.ctx);
    expect(failing.results?.map((r) => r.index)).toEqual([1, 3]);
    expect(failing.results?.[0]?.label).toBe("Poor result");
    expect(failing.results?.[0]?.inputSummary).toBe('{"v":"fail"}');
    expect(failing.results?.[0]?.output).toEqual({ company: 'co-{"v":"fail"}', score: 3 });
    expect(failing.results?.[0]?.runId).toMatch(/^run_/);

    expect(() => handleBatch({ batchId: "batch_000000000000" }, h.ctx)).toThrow(/not found/);
    expect(handleBatches({}, h.ctx).batches.map((b) => b.id)).toEqual([out.batch.id]);
  });
});

describe("tasks__batch_control", () => {
  it("pause stops new items; resume starts them again", async () => {
    const h = harness({ gated: true });
    makeTask();
    const out = handleRunBatch(
      { taskId: "enrich", items: items("a", "b", "c"), concurrency: 1 },
      h.ctx,
    );
    await waitFor(() => h.gates.length === 1, "first run");
    const paused = handleBatchControl({ batchId: out.batch.id, action: "pause" }, h.ctx);
    expect(paused.batch.state).toBe("paused");
    h.gates[0]!.release();
    await waitFor(() => batchOf(h, out.batch.id).counts.running === 0, "first run to end");
    await Bun.sleep(30);
    expect(h.gates).toHaveLength(1);
    expect(() => handleBatchControl({ batchId: out.batch.id, action: "pause" }, h.ctx)).toThrow(
      /only a running batch/,
    );
    handleBatchControl({ batchId: out.batch.id, action: "resume" }, h.ctx);
    await waitFor(() => h.gates.length === 2, "second run");
    h.gates[1]!.release();
    await waitFor(() => h.gates.length === 3, "third run");
    h.gates[2]!.release();
    await waitFor(() => batchOf(h, out.batch.id).state === "completed", "completion");
  });

  it("pause takes the batch's runs still queued at the door back to pending; resume asks for them again", async () => {
    const h = harness({ gated: true, maxConcurrentRuns: 1 });
    makeTask();
    h.scheduler.reload();
    const created = h.driver.create({
      wsId: WS,
      ownerId: OWNER,
      task: makeTask(),
      inputs: items("a", "b", "c"),
      concurrency: 2,
      createdBy: OWNER,
    });
    await waitFor(() => h.gates.length === 1, "first run");
    const queued = readBatchItems(workDir, WS, OWNER, created.id)[1]!;
    expect(queued.state).toBe("queued");

    handleBatchControl({ batchId: created.id, action: "pause" }, h.ctx);
    expect(h.admission.queued()).toHaveLength(0);
    await waitFor(
      () => readBatchItems(workDir, WS, OWNER, created.id)[1]?.state === "pending",
      "the queued item back to pending",
    );
    const back = readBatchItems(workDir, WS, OWNER, created.id)[1]!;
    expect(back.previousRunIds).toEqual([queued.runId!]);
    const withdrawn = readRuns(workDir, WS, OWNER, "enrich").find((r) => r.id === queued.runId);
    expect(withdrawn?.status).toBe("skipped");
    expect(withdrawn?.error).toContain("batch paused");

    // The running run finishes; nothing new starts while paused.
    h.gates[0]!.release();
    await waitFor(() => batchOf(h, created.id).counts.running === 0, "running run to end");
    await Bun.sleep(30);
    expect(h.gates).toHaveLength(1);
    expect(batchOf(h, created.id).counts).toMatchObject({ pass: 1, pending: 2 });

    handleBatchControl({ batchId: created.id, action: "resume" }, h.ctx);
    await waitFor(() => h.gates.length === 2, "second run");
    h.gates[1]!.release();
    await waitFor(() => h.gates.length === 3, "third run");
    h.gates[2]!.release();
    await waitFor(() => batchOf(h, created.id).state === "completed", "completion");
    expect(batchOf(h, created.id).counts.pass).toBe(3);
  });

  it("cancel cancels the queued and the running runs and every pending item", async () => {
    const h = harness({ gated: true, maxConcurrentRuns: 1 });
    makeTask();
    const out = handleRunBatch(
      { taskId: "enrich", items: items("a", "b", "c", "d"), concurrency: 1 },
      h.ctx,
    );
    // Concurrency is held to the one slot; ask for a second through the driver.
    h.scheduler.reload();
    const created = h.driver.create({
      wsId: WS,
      ownerId: OWNER,
      task: makeTask(),
      inputs: items("x", "y", "z"),
      concurrency: 2,
      createdBy: OWNER,
    });
    await waitFor(() => h.gates.length === 1, "first run");
    await waitFor(
      () => readBatchItems(workDir, WS, OWNER, created.id).some((i) => i.state === "queued"),
      "a queued run",
    );
    const result = handleBatchControl({ batchId: created.id, action: "cancel" }, h.ctx);
    expect(result.batch.state).toBe("cancelled");
    expect(result.affected).toBeGreaterThanOrEqual(2);
    // Release whatever of the other batch is held so it can end.
    const drain = setInterval(() => {
      for (const g of h.gates) g.release();
    }, 5);
    try {
      await waitFor(
        () =>
          readBatchItems(workDir, WS, OWNER, created.id).every(
            (i) => i.state === "done" && i.execution === "cancelled",
          ),
        "every item cancelled",
      );
      const batch = batchOf(h, created.id);
      expect(batch.counts.cancelled).toBe(3);
      expect(batch.state).toBe("cancelled");
      await waitFor(() => batchOf(h, out.batch.id).state === "completed", "other batch");
    } finally {
      clearInterval(drain);
    }
    expect(() => handleBatchControl({ batchId: created.id, action: "resume" }, h.ctx)).toThrow(
      /cancelled/,
    );
  });

  it("rerun_failed runs every failed or fail-judged item again as a new, linked run", async () => {
    const h = harness({
      behave: (input) =>
        (input as { v: string }).v === "boom"
          ? { status: "failure", stopReason: "error", resultPreview: undefined, error: "boom" }
          : {},
    });
    makeTask();
    const out = handleRunBatch(
      { taskId: "enrich", items: items("pass", "boom", "fail"), concurrency: 1 },
      h.ctx,
    );
    await waitFor(() => batchOf(h, out.batch.id).state === "completed", "completion");
    expect(batchOf(h, out.batch.id).counts).toMatchObject({ pass: 1, failed: 1, fail: 1 });
    const before = readBatchItems(workDir, WS, OWNER, out.batch.id);

    const rerun = handleBatchControl({ batchId: out.batch.id, action: "rerun_failed" }, h.ctx);
    expect(rerun.affected).toBe(2);
    await waitFor(
      () =>
        batchOf(h, out.batch.id).state === "completed" &&
        readBatchItems(workDir, WS, OWNER, out.batch.id).every((i) => i.state === "done"),
      "rerun completion",
    );
    const after = readBatchItems(workDir, WS, OWNER, out.batch.id);
    expect(after[0]?.runId).toBe(before[0]?.runId);
    for (const i of [1, 2]) {
      expect(after[i]?.previousRunIds).toEqual([before[i]!.runId!]);
      expect(after[i]?.runId).not.toBe(before[i]?.runId);
    }
    expect(readRuns(workDir, WS, OWNER, "enrich")).toHaveLength(5);
    // Each rerun's cost adds to its item's.
    expect(after[1]?.costUsd).toBeCloseTo(0.02, 6);
  });
});

describe("restart", () => {
  it("records a running item's run failed, re-asks for queued and pending items, and rebuilds the counts", async () => {
    // First process: one slot, two of the batch's runs asked for.
    const admission = createRunAdmission({ maxConcurrentRuns: 1 });
    const first = harness({ gated: true, admission });
    makeTask();
    first.scheduler.reload();
    const created = first.driver.create({
      wsId: WS,
      ownerId: OWNER,
      task: makeTask(),
      inputs: items("a", "b", "c"),
      concurrency: 2,
      createdBy: OWNER,
    });
    await waitFor(() => first.gates.length === 1, "first run");
    const atCrash = readBatchItems(workDir, WS, OWNER, created.id);
    expect(atCrash.map((i) => i.state)).toEqual(["running", "queued", "pending"]);
    // The process dies: nothing more of it is written, and its runs never end.
    toStop.splice(0);

    const second = harness();
    await waitFor(() => batchOf(second, created.id).state === "completed", "completion");
    const after = readBatchItems(workDir, WS, OWNER, created.id);
    expect(after[0]).toMatchObject({ state: "done", execution: "failed" });
    expect(after[0]?.runId).toBe(atCrash[0]?.runId);
    expect(after[1]?.state).toBe("done");
    expect(after[1]?.previousRunIds).toEqual([atCrash[1]!.runId!]);
    expect(after[2]?.state).toBe("done");
    const batch = batchOf(second, created.id);
    expect(batch.counts).toMatchObject({ failed: 1, pass: 2, queued: 0, running: 0, pending: 0 });
    // The lost runs' records say so.
    const runs = readRuns(workDir, WS, OWNER, "enrich");
    expect(runs.find((r) => r.id === atCrash[0]?.runId)?.status).toBe("failure");
    expect(runs.find((r) => r.id === atCrash[1]?.runId)?.status).toBe("skipped");
    // The failed item is eligible for rerun_failed.
    expect(
      handleBatchControl({ batchId: created.id, action: "rerun_failed" }, second.ctx).affected,
    ).toBe(1);
    await waitFor(() => batchOf(second, created.id).counts.pass === 3, "rerun of the lost item");
    for (const g of first.gates) g.release();
  });

  it("seeds the batch budget from the usage ledger, so spend by a run lost in a crash still counts", async () => {
    const first = harness({ gated: true, ledger: true });
    makeTask();
    first.scheduler.reload();
    const created = first.driver.create({
      wsId: WS,
      ownerId: OWNER,
      task: makeTask(),
      inputs: items("a", "b"),
      concurrency: 1,
      budgetUsd: 1,
      createdBy: OWNER,
    });
    await waitFor(() => first.gates.length === 1, "first run");
    const lost = readBatchItems(workDir, WS, OWNER, created.id)[0]!;
    // The run's model calls reach the ledger as they complete ($0.60), then
    // the process dies before the run's record is written.
    new UsageLedger(workDir, "crashed").append({
      ts: new Date().toISOString(),
      source: "main",
      origin: "task",
      model: "m",
      usage: { inputTokens: 300, outputTokens: 300 },
      llmMs: 1,
      workspaceId: WS,
      taskRunId: lost.runId!,
      rates: RATES,
    });
    // Another batch's run in the same ledger is not this batch's spend.
    new UsageLedger(workDir, "other").append({
      ts: new Date().toISOString(),
      source: "main",
      origin: "task",
      model: "m",
      usage: { inputTokens: 5000, outputTokens: 0 },
      llmMs: 1,
      workspaceId: WS,
      taskRunId: "run_unrelated00",
      rates: RATES,
    });
    toStop.splice(0);

    const second = harness({ gated: true, ledger: true });
    await waitFor(() => second.gates.length === 1, "the pending item's run");
    const batch = batchOf(second, created.id);
    // Recorded cost knows nothing of the lost run; the ledger does.
    expect(batch.costUsd).toBe(0);
    expect(second.spend.balance(batchAccountId(batch))).toBeCloseTo(0.4, 9);
    expect(readBatchItems(workDir, WS, OWNER, created.id)[0]?.execution).toBe("failed");
    // A new budget is held above the ledger's spend too.
    handleBatchControl({ batchId: created.id, action: "pause" }, second.ctx);
    second.gates[0]!.release();
    await waitFor(() => batchOf(second, created.id).counts.running === 0, "run to end");
    expect(() =>
      handleBatchControl({ batchId: created.id, action: "resume", budgetUsd: 0.5 }, second.ctx),
    ).toThrow(/more than the \$0\.6/);
    for (const g of first.gates) g.release();
  });

  it("compacts the items file to one line per item at boot", async () => {
    const h = harness();
    makeTask();
    const out = handleRunBatch({ taskId: "enrich", items: items("a", "b") }, h.ctx);
    await waitFor(() => batchOf(h, out.batch.id).state === "completed", "completion");
    const file = join(taskBatchesDir(workDir, WS, OWNER), `${out.batch.id}.items.jsonl`);
    expect(readFileSync(file, "utf-8").trim().split("\n")).toHaveLength(2);
  });
});

describe("the in-run allowlist", () => {
  it("lets a run read a batch, and refuses starting or controlling one", () => {
    expect(isTaskForbiddenIdentityTool("tasks__batch")).toBe(false);
    expect(isTaskForbiddenIdentityTool("tasks__batches")).toBe(false);
    expect(isTaskForbiddenIdentityTool("tasks__run_batch")).toBe(true);
    expect(isTaskForbiddenIdentityTool("tasks__batch_control")).toBe(true);
  });
});
