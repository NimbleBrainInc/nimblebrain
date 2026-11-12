/**
 * The reads the Tasks panel's views are built on: what runs next
 * (`tasks__upcoming`), per-task figures (`tasks__stats`), the connected judge
 * servers (`tasks__judges`), and paging every task's runs back through the
 * archive months (`tasks__runs` without `taskId`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  type TasksJudgesOutput,
  type TasksListOutput,
  type TasksRunsOutput,
  type TasksStatsOutput,
  TasksUpcomingInput,
  type TasksUpcomingOutput,
} from "../../../../src/platform/schemas/tasks.ts";
import { effectiveVerdict } from "../../../../src/platform/tasks/assessment.ts";
import { taskRunIndexPath, taskRunSegmentPath } from "../../../../src/platform/tasks/paths.ts";
import type { QueueViewEntry } from "../../../../src/platform/tasks/scheduler.ts";
import {
  handleJudges,
  handleList,
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
  readRunsSince,
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
    readRunsSince: (id, since) => readRunsSince(TMP_DIR, WS, OWNER, id, since),
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

  test("shows a queued event run id without a run ticket", () => {
    seed(
      makeTask({
        id: "ev",
        name: "Event task",
        schedule: { type: "event", match: { source: "x" } },
      }),
    );
    const runId = "run_eeeeeeeeeeee";
    const out = handleUpcoming(
      {},
      makeCtx({
        queueView: () => [{ taskId: "ev", state: "queued", position: 1, runId }],
        readRunTicket: () => null,
      }),
    );

    expect(out.queued).toEqual([
      { taskId: "ev", taskName: "Event task", runId, state: "queued", position: 1 },
    ]);
  });

  test("lists fires within the window soonest first, skipping paused, retired and one-off tasks", () => {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    seed(
      makeTask({
        id: "every-6h",
        name: "Six-hourly",
        schedule: { type: "interval", intervalMs: 6 * 3_600_000 },
        nextRunAt: iso(base + 30 * 60_000),
      }),
      makeTask({
        id: "once",
        name: "Once",
        schedule: { type: "once", at: iso(base + 60_000) },
        nextRunAt: iso(base + 60_000),
      }),
      makeTask({
        id: "paused",
        name: "Paused",
        enabled: false,
        schedule: { type: "interval", intervalMs: 6 * 3_600_000 },
        nextRunAt: iso(base),
      }),
      makeTask({
        id: "retired",
        name: "Retired",
        schedule: { type: "once", at: iso(base) },
        nextRunAt: iso(base),
        onceDone: { at: iso(base), outcome: "ran" },
      }),
      makeTask({
        id: "adhoc",
        name: "Adhoc",
        kind: "oneoff",
        schedule: { type: "interval", intervalMs: 6 * 3_600_000 },
        nextRunAt: iso(base),
      }),
    );
    const out = handleUpcoming({ days: 1 }, makeCtx());
    expect(out.days).toBe(1);
    // 30 min, then every 6 h up to the window's end at 24 h: 4 fires.
    expect(out.scheduled.map((f) => [f.taskId, f.at])).toEqual([
      ["once", iso(base + 60_000)],
      ["every-6h", iso(base + 30 * 60_000)],
      ["every-6h", iso(base + 6.5 * 3_600_000)],
      ["every-6h", iso(base + 12.5 * 3_600_000)],
      ["every-6h", iso(base + 18.5 * 3_600_000)],
    ]);
    expect(out.frequent).toEqual([]);
    // A week holds 28 six-hourly fires: past the threshold, one frequent row.
    const week = handleUpcoming({}, makeCtx());
    expect(week.days).toBe(7);
    expect(week.scheduled.map((f) => f.taskId)).toEqual(["once"]);
    expect(week.frequent).toEqual([
      {
        taskId: "every-6h",
        taskName: "Six-hourly",
        schedule: week.frequent[0]?.schedule ?? "",
        scheduleType: "interval",
        count: 28,
        first: iso(base + 30 * 60_000),
        last: iso(base + 30 * 60_000 + 27 * 6 * 3_600_000),
      },
    ]);
  });

  test("a schedule whose next fire is past the window still shows, marked beyond it", () => {
    const next = new Date(Date.now() + 21 * 24 * 3_600_000).toISOString();
    seed(
      makeTask({
        id: "rare",
        name: "Rare",
        schedule: { type: "interval", intervalMs: 21 * 24 * 3_600_000 },
        nextRunAt: next,
      }),
    );
    const out = handleUpcoming({ days: 7 }, makeCtx());
    expect(out.scheduled).toEqual([
      {
        taskId: "rare",
        taskName: "Rare",
        at: next,
        schedule: out.scheduled[0]?.schedule ?? "",
        scheduleType: "interval",
        beyondWindow: true,
      },
    ]);
  });

  test("high-frequency interval and cron schedules collapse to one counted row", () => {
    const base = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    seed(
      makeTask({
        id: "five-min",
        name: "Five-minutely",
        schedule: { type: "interval", intervalMs: 5 * 60_000 },
        nextRunAt: new Date(base).toISOString(),
      }),
      makeTask({
        id: "cron-15",
        name: "Quarter-hourly",
        schedule: { type: "cron", expression: "*/15 * * * *", timezone: "UTC" },
        nextRunAt: new Date(base).toISOString(),
      }),
    );
    const out = handleUpcoming({ days: 1 }, makeCtx());
    expect(out.scheduled).toEqual([]);
    const byId = new Map(out.frequent.map((f) => [f.taskId, f]));
    const end = Date.parse(out.windowEnd);
    expect(byId.get("five-min")?.count).toBe(Math.floor((end - base) / 300_000) + 1);
    // A cron is counted only until it is known to be frequent: a floor.
    expect(byId.get("cron-15")).toMatchObject({ count: 25, countCapped: true });
    expect(byId.get("cron-15")?.last).toBeUndefined();
    expect(byId.get("cron-15")?.scheduleType).toBe("cron");
    expect(byId.get("five-min")?.countCapped).toBeUndefined();
    expect(byId.get("five-min")?.last).toBeString();
    expect(byId.get("five-min")?.first).toBe(new Date(base).toISOString());
  });

  test("a minute-scale cron over the longest window answers at once", () => {
    seed(
      makeTask({
        id: "every-minute",
        schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" },
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const started = performance.now();
    const out = handleUpcoming({ days: 30 }, makeCtx());
    // Stepping all 43,200 fires took about 20 seconds; counting stops at 25.
    expect(performance.now() - started).toBeLessThan(500);
    expect(out.frequent[0]).toMatchObject({ count: 25, countCapped: true });
  });

  test("days is bounded by the schema", () => {
    const check = (days: unknown) => Value.Check(TasksUpcomingInput, { days });
    expect(check(7)).toBe(true);
    expect(check(30)).toBe(true);
    expect(check(0)).toBe(false);
    expect(check(31)).toBe(false);
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
    expect(() => handleStats({ taskId: "nope" }, makeCtx())).toThrow("No task with id");
    expect(() => handleStats({ since: "yesterday" }, makeCtx())).toThrow("Invalid since");
  });
});

describe("tasks__stats reads each run index once", () => {
  const SINCE = "2026-03-10T00:00:00.000Z";
  const assessed = (verdict: "pass" | "fail" | "uncertain", human?: "pass" | "fail") => ({
    verdict,
    assessedAt: "2026-05-01T00:00:00.000Z",
    ...(human ? { human: { verdict: human, by: OWNER, via: "ui" as const, at: "x" } } : {}),
  });
  const run = (id: string, startedAt: string, costUsd: number, extra: Partial<TaskRun> = {}) =>
    makeRun({ id, taskId: "a", startedAt, completedAt: startedAt, costUsd, ...extra });

  /** Every run since `SINCE`, paged `limit` at a time from a `before` later than any run. */
  function pagedRuns(limit: number): TaskRun[] {
    const runs: TaskRun[] = [];
    let before: string | undefined = "9999-12-31T00:00:00.000Z";
    while (before) {
      const page = readRunsPage(TMP_DIR, WS, OWNER, "a", { since: SINCE, before, limit });
      runs.push(...page.runs);
      before = page.nextBefore;
    }
    return runs;
  }

  /** The figures a fold over `runs`, in their order, gives. */
  function figuresOf(runs: TaskRun[]) {
    const out = { runs: 0, pass: 0, fail: 0, uncertain: 0, costUsd: 0 };
    for (const r of runs) {
      out.runs++;
      out.costUsd += r.costUsd ?? 0;
      const verdict = effectiveVerdict(r.assessment);
      if (verdict === "pass" || verdict === "fail" || verdict === "uncertain") out[verdict]++;
    }
    const decided = out.pass + out.fail;
    return { ...out, passRate: decided > 0 ? out.pass / decided : null };
  }

  function seedHistory(): void {
    seed(makeTask({ id: "a" }));
    // Wholly before `since`: never read, so a line misfiled here is not counted.
    seedSegment("a", "2026-02", [
      run("run_feb", "2026-02-20T00:00:00.000Z", 7),
      run("run_misfiled", "2026-04-02T00:00:00.000Z", 11),
    ]);
    // The month `since` falls in.
    const march = [
      run("run_before", "2026-03-09T23:59:59.999Z", 5, { assessment: assessed("pass") }),
      run("run_at_since", SINCE, 0.1, { assessment: assessed("pass") }),
      // Four runs sharing one start time.
      run("run_tie_a", "2026-03-20T00:00:00.000Z", 0.2, { assessment: assessed("fail") }),
      run("run_tie_b", "2026-03-20T00:00:00.000Z", 0.3, { assessment: assessed("pass") }),
      run("run_tie_c", "2026-03-20T00:00:00.000Z", 0.07, { assessment: assessed("uncertain") }),
      run("run_tie_d", "2026-03-20T00:00:00.000Z", 0.011),
    ];
    seedSegment("a", "2026-03", march);
    // A crash between the archive append and the hot rewrite repeats lines:
    // `run_rolled` twice in the archive, `run_both` in the archive and the hot
    // index, where its record alone carries the person's verdict.
    const rolled = run("run_rolled", "2026-04-05T00:00:00.000Z", 0.13, {
      assessment: assessed("fail"),
    });
    const both = run("run_both", "2026-04-28T00:00:00.000Z", 0.17, {
      assessment: assessed("fail"),
    });
    seedSegment("a", "2026-04", [
      rolled,
      rolled,
      run("run_apr", "2026-04-10T00:00:00.000Z", 0.19, { assessment: assessed("pass") }),
      // Shares its start time with a run in the hot index.
      run("run_tie_archived", "2026-04-29T00:00:00.000Z", 0.23, { assessment: assessed("pass") }),
      both,
    ]);
    const path = taskRunIndexPath(TMP_DIR, WS, OWNER, "a");
    const hot = [
      { ...both, assessment: assessed("fail", "pass") },
      run("run_tie_hot", "2026-04-29T00:00:00.000Z", 0.29, { assessment: assessed("fail") }),
      run("run_may", "2026-05-02T00:00:00.000Z", 0.31, { assessment: assessed("uncertain") }),
      run("run_newest", "2026-05-03T00:00:00.000Z", 0.37),
    ];
    writeFileSync(path, `${hot.map((r) => JSON.stringify(r)).join("\n")}\nnot json\n`);
  }

  test("the runs and their order are the paged read's, whatever the page size", () => {
    seedHistory();
    const once = readRunsSince(TMP_DIR, WS, OWNER, "a", SINCE);
    expect(once.map((r) => r.id)).toEqual([
      "run_newest",
      "run_may",
      "run_tie_hot",
      "run_tie_archived",
      "run_both",
      "run_apr",
      "run_rolled",
      "run_tie_a",
      "run_tie_b",
      "run_tie_c",
      "run_tie_d",
      "run_at_since",
    ]);
    // The hot copy of a repeated run is the one counted.
    expect(effectiveVerdict(once.find((r) => r.id === "run_both")?.assessment)).toBe("pass");
    for (const limit of [1, 2, 3, 5, 5000]) expect(pagedRuns(limit)).toEqual(once);
  });

  test("the figures are those of counting the paged read", () => {
    seedHistory();
    const out = handleStats({ since: SINCE, taskId: "a" }, makeCtx());
    const { lastRun, taskId, ...figures } = out.tasks[0] ?? { taskId: "" };
    expect(taskId).toBe("a");
    expect(lastRun?.id).toBe("run_newest");
    for (const limit of [1, 3, 5000]) expect(figures).toEqual(figuresOf(pagedRuns(limit)));
    expect(figures).toMatchObject({ runs: 12, pass: 5, fail: 3, uncertain: 2, passRate: 5 / 8 });
  });

  test("`since` in a month with no archive, and a task with no runs", () => {
    seedHistory();
    seed(makeTask({ id: "empty" }));
    const late = "2026-05-02T00:00:00.000Z";
    expect(readRunsSince(TMP_DIR, WS, OWNER, "a", late).map((r) => r.id)).toEqual([
      "run_newest",
      "run_may",
    ]);
    expect(readRunsSince(TMP_DIR, WS, OWNER, "a", "2026-05-03T00:00:00.001Z")).toEqual([]);
    expect(readRunsSince(TMP_DIR, WS, OWNER, "empty", SINCE)).toEqual([]);
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

describe("tasks__list", () => {
  test("carries a task's input schema, and none for a task without one", () => {
    const schema = { type: "object", properties: { company: { type: "string" } } };
    seed(makeTask({ id: "typed", name: "Typed", inputSchema: schema }), makeTask({ id: "plain" }));
    const out: TasksListOutput = handleList({}, makeCtx());
    const byId = new Map(out.tasks.map((t) => [t.id, t]));
    expect(byId.get("typed")?.inputSchema).toEqual(schema);
    expect("inputSchema" in (byId.get("plain") ?? {})).toBe(false);
  });
});
