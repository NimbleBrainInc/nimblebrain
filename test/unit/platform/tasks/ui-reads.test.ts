/**
 * The reads the Tasks panel's views are built on: what runs next
 * (`tasks__upcoming`), per-task figures (`tasks__stats`), the connected judge
 * servers (`tasks__judges`), and paging every task's runs back through the
 * archive months (`tasks__runs` without `taskId`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  TasksJudgesOutput,
  TasksRunsOutput,
  TasksStatsOutput,
  TasksUpcomingOutput,
} from "../../../../src/platform/schemas/tasks.ts";
import { taskRunSegmentPath } from "../../../../src/platform/tasks/paths.ts";
import type { QueueViewEntry } from "../../../../src/platform/tasks/scheduler.ts";
import {
  handleJudges,
  handleRuns,
  handleStats,
  handleUpcoming,
  type ToolContext,
} from "../../../../src/platform/tasks/server.ts";
import {
  appendRun,
  loadOwnerTasks,
  readAllRuns,
  readRunResult,
  readRuns,
  readRunsPage,
  saveTask,
} from "../../../../src/platform/tasks/store.ts";
import type { RunTicket, Task, TaskRun } from "../../../../src/platform/tasks/types.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";
const TMP_DIR = join(import.meta.dir, ".tmp-task-ui-reads");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t",
    name: "T",
    prompt: "Do it",
    enabled: true,
    source: "user",
    workspaceId: WS,
    ownerId: OWNER,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    ...overrides,
  };
}

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: `run_${Math.random().toString(36).slice(2, 10)}`,
    taskId: "t",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "success",
    inputTokens: 1,
    outputTokens: 1,
    toolCalls: 0,
    iterations: 1,
    ...overrides,
  };
}

function seed(...tasks: Task[]): void {
  for (const t of tasks) saveTask(TMP_DIR, WS, OWNER, t);
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    definitions: () => loadOwnerTasks(TMP_DIR, WS, OWNER),
    save: () => {},
    reloadScheduler: () => {},
    runNow: () => null,
    cancelRun: () => false,
    readRuns: (id, opts) => readRuns(TMP_DIR, WS, OWNER, id, opts),
    readRunsPage: (id, opts) => readRunsPage(TMP_DIR, WS, OWNER, id, opts),
    readAllRuns: (opts) => readAllRuns(TMP_DIR, WS, OWNER, opts),
    readRunResult: (id, runId) => readRunResult(TMP_DIR, WS, OWNER, id, runId),
    defaultTimezone: "UTC",
    ...overrides,
  };
}

/** Write runs straight into one archive month of a task. */
function seedSegment(taskId: string, month: string, runs: TaskRun[]): void {
  const path = taskRunSegmentPath(TMP_DIR, WS, OWNER, taskId, month);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${runs.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
  seedWorkspaceRoot(TMP_DIR, WS);
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("tasks__upcoming", () => {
  test("reports the queue view, enriched from tickets and definitions", () => {
    seed(makeTask({ id: "a", name: "Alpha" }));
    const queue: QueueViewEntry[] = [
      { taskId: "a", state: "running", startedAt: "2026-01-01T00:00:00.000Z", trigger: "event" },
      { taskId: "a", state: "queued", position: 3, runId: "run_bbbbbbbbbbbb" },
      { taskId: "gone", state: "queued", position: 1, runId: "run_cccccccccccc" },
    ];
    const ticket: RunTicket = {
      runId: "run_bbbbbbbbbbbb",
      taskId: "a",
      requestedAt: "2026-01-01T00:01:00.000Z",
      run: makeRun({
        id: "run_bbbbbbbbbbbb",
        taskId: "a",
        status: "queued",
        batchId: "batch_aaaaaaaaaaaa",
        batchIndex: 7,
      }),
    };
    const out: TasksUpcomingOutput = handleUpcoming(
      {},
      makeCtx({
        queueView: () => queue,
        readRunTicket: (runId) => (runId === ticket.runId ? ticket : null),
      }),
    );
    expect(out.running).toEqual([
      {
        taskId: "a",
        taskName: "Alpha",
        state: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        trigger: "event",
      },
    ]);
    // Ordered by place in the queue; a deleted task has no name.
    expect(out.queued.map((q) => q.taskId)).toEqual(["gone", "a"]);
    expect(out.queued[0]?.taskName).toBeUndefined();
    expect(out.queued[1]).toEqual({
      taskId: "a",
      taskName: "Alpha",
      runId: "run_bbbbbbbbbbbb",
      state: "queued",
      position: 3,
      queuedAt: "2026-01-01T00:01:00.000Z",
      batchId: "batch_aaaaaaaaaaaa",
      batchIndex: 7,
    });
  });

  test("lists coming fires soonest first, cut to the limit, skipping paused, retired and one-off tasks", () => {
    const base = Date.parse("2030-01-01T00:00:00.000Z");
    seed(
      makeTask({
        id: "every-hour",
        name: "Hourly",
        schedule: { type: "interval", intervalMs: 3_600_000 },
        nextRunAt: new Date(base + 30 * 60_000).toISOString(),
      }),
      makeTask({
        id: "daily",
        name: "Daily",
        schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
        nextRunAt: new Date(base + 9 * 3_600_000).toISOString(),
      }),
      makeTask({
        id: "once",
        name: "Once",
        schedule: { type: "once", at: new Date(base + 60_000).toISOString() },
        nextRunAt: new Date(base + 60_000).toISOString(),
      }),
      makeTask({
        id: "paused",
        name: "Paused",
        enabled: false,
        schedule: { type: "interval", intervalMs: 60_000 },
        nextRunAt: new Date(base).toISOString(),
      }),
      makeTask({
        id: "retired",
        name: "Retired",
        schedule: { type: "once", at: new Date(base).toISOString() },
        nextRunAt: new Date(base).toISOString(),
        onceDone: { at: new Date(base).toISOString(), outcome: "ran" },
      }),
    );
    const out = handleUpcoming({ limit: 4 }, makeCtx());
    expect(out.scheduled.map((f) => [f.taskId, f.at])).toEqual([
      ["once", "2030-01-01T00:01:00.000Z"],
      ["every-hour", "2030-01-01T00:30:00.000Z"],
      ["every-hour", "2030-01-01T01:30:00.000Z"],
      ["every-hour", "2030-01-01T02:30:00.000Z"],
    ]);
    const all = handleUpcoming({ limit: 100 }, makeCtx());
    const daily = all.scheduled.filter((f) => f.taskId === "daily").map((f) => f.at);
    expect(daily.slice(0, 2)).toEqual(["2030-01-01T09:00:00.000Z", "2030-01-02T09:00:00.000Z"]);
    expect(all.scheduled.some((f) => f.taskId === "paused" || f.taskId === "retired")).toBe(false);
  });

  test("lists event tasks with their ceiling and the last hour's fires", () => {
    seed(
      makeTask({
        id: "inbound",
        name: "Inbound",
        schedule: { type: "event", match: { source: "mail" }, maxFiresPerHour: 5 },
      }),
    );
    appendRun(TMP_DIR, WS, OWNER, "inbound", makeRun({ taskId: "inbound", trigger: "event" }));
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "inbound",
      makeRun({ taskId: "inbound", trigger: "event", status: "skipped" }),
    );
    const out = handleUpcoming({}, makeCtx());
    expect(out.events).toEqual([
      {
        taskId: "inbound",
        taskName: "Inbound",
        schedule: out.events[0]?.schedule ?? "",
        enabled: true,
        maxFiresPerHour: 5,
        firesLastHour: 1,
      },
    ]);
    expect(out.scheduled).toEqual([]);
  });
});

describe("tasks__stats", () => {
  test("counts verdicts (a person's replacing the judge's), pass rate and cost since a time, archives included", () => {
    seed(makeTask({ id: "a" }), makeTask({ id: "one", kind: "oneoff" }));
    const assessed = (verdict: "pass" | "fail" | "uncertain", human?: "pass" | "fail") => ({
      verdict,
      assessedAt: new Date().toISOString(),
      ...(human ? { human: { verdict: human, by: OWNER, via: "ui" as const, at: "x" } } : {}),
    });
    seedSegment("a", "2026-01", [
      makeRun({
        taskId: "a",
        startedAt: "2026-01-10T00:00:00.000Z",
        costUsd: 0.5,
        assessment: assessed("pass"),
      }),
      // Before `since`: not counted.
      makeRun({ taskId: "a", startedAt: "2025-12-01T00:00:00.000Z", costUsd: 9 }),
    ]);
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "a",
      makeRun({
        taskId: "a",
        startedAt: "2026-02-01T00:00:00.000Z",
        costUsd: 0.25,
        assessment: assessed("pass", "fail"),
      }),
    );
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "a",
      makeRun({
        id: "run_newest00000",
        taskId: "a",
        startedAt: "2026-02-02T00:00:00.000Z",
        assessment: assessed("uncertain"),
      }),
    );
    const out: TasksStatsOutput = handleStats({ since: "2026-01-01T00:00:00.000Z" }, makeCtx());
    // One-offs are left out unless named.
    expect(out.tasks.map((t) => t.taskId)).toEqual(["a"]);
    const a = out.tasks[0];
    expect(a).toMatchObject({ runs: 3, pass: 1, fail: 1, uncertain: 1, passRate: 0.5 });
    expect(a?.costUsd).toBeCloseTo(0.75);
    expect(a?.lastRun).toEqual({
      id: "run_newest00000",
      startedAt: "2026-02-02T00:00:00.000Z",
      label: "Needs review",
    });
    expect(handleStats({ taskId: "one" }, makeCtx()).tasks).toEqual([
      { taskId: "one", runs: 0, pass: 0, fail: 0, uncertain: 0, passRate: null, costUsd: 0 },
    ]);
  });

  test("refuses an unknown task and a bad since", () => {
    expect(() => handleStats({ taskId: "nope" }, makeCtx())).toThrow("Task not found");
    expect(() => handleStats({ since: "yesterday" }, makeCtx())).toThrow("Invalid since");
  });
});

describe("tasks__judges", () => {
  const judge = { name: "judge-a", toolNames: ["judge", "list_judges"] };
  test("names the judge servers, with no warning for exactly one", async () => {
    const ctx = makeCtx({
      judgeSources: async () => [judge, { name: "mail", toolNames: ["send"] }],
    });
    const out: TasksJudgesOutput = await handleJudges({}, ctx);
    expect(out).toEqual({ servers: ["judge-a"] });
  });

  test("warns when none is connected, and when several are", async () => {
    const none = await handleJudges({}, makeCtx({ judgeSources: async () => [] }));
    expect(none.servers).toEqual([]);
    expect(none.warning?.code).toBe("no_judge");
    const two = await handleJudges(
      {},
      makeCtx({ judgeSources: async () => [judge, { ...judge, name: "judge-b" }] }),
    );
    expect(two.servers).toEqual(["judge-a", "judge-b"]);
    expect(two.warning?.code).toBe("judge_ambiguous");
  });
});

describe("tasks__runs across every task", () => {
  test("pages every task's runs back through the archive months with nextBefore", () => {
    seed(makeTask({ id: "a" }), makeTask({ id: "b" }));
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "a",
      makeRun({ id: "run_a3", taskId: "a", startedAt: "2026-03-03T00:00:00.000Z" }),
    );
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "b",
      makeRun({ id: "run_b2", taskId: "b", startedAt: "2026-03-02T00:00:00.000Z" }),
    );
    seedSegment("a", "2026-01", [
      makeRun({ id: "run_a1", taskId: "a", startedAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    seedSegment("b", "2026-02", [
      makeRun({ id: "run_b1", taskId: "b", startedAt: "2026-02-01T00:00:00.000Z" }),
    ]);

    const seen: string[] = [];
    let before: string | undefined = "2099-01-01T00:00:00.000Z";
    let pages = 0;
    while (before && pages < 10) {
      const page: TasksRunsOutput = handleRuns({ limit: 2, before }, makeCtx());
      seen.push(...page.runs.map((r) => r.id));
      before = page.nextBefore;
      pages++;
    }
    expect(seen).toEqual(["run_a3", "run_b2", "run_b1", "run_a1"]);
    expect(pages).toBe(2);
  });

  test("does not split runs sharing a start time across pages", () => {
    seed(makeTask({ id: "a" }), makeTask({ id: "b" }));
    const t = "2026-03-01T00:00:00.000Z";
    appendRun(TMP_DIR, WS, OWNER, "a", makeRun({ id: "run_x", taskId: "a", startedAt: t }));
    appendRun(TMP_DIR, WS, OWNER, "b", makeRun({ id: "run_y", taskId: "b", startedAt: t }));
    appendRun(
      TMP_DIR,
      WS,
      OWNER,
      "b",
      makeRun({ id: "run_z", taskId: "b", startedAt: "2026-02-01T00:00:00.000Z" }),
    );
    const page = handleRuns({ limit: 1 }, makeCtx());
    expect(page.runs.map((r) => r.id).sort()).toEqual(["run_x", "run_y"]);
    expect(page.nextBefore).toBe(t);
  });
});
