/**
 * The retention sweep (`src/platform/tasks/retention.ts`): what it deletes
 * once a run is older than the window, and what it never deletes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { emptyCounts, saveBatch } from "../../../../src/platform/tasks/batch-store.ts";
import {
  ownerRunsRoot,
  taskArchivedRunResultPath,
  taskFilePath,
  taskRunArchiveDir,
  taskRunArchiveRoot,
  taskRunResultPath,
  taskRunSegmentPath,
  taskRunsDir,
  taskRunTicketPath,
} from "../../../../src/platform/tasks/paths.ts";
import {
  type RetentionDeps,
  type RetentionReport,
  startRetentionSweep,
  sweepRetention,
} from "../../../../src/platform/tasks/retention.ts";
import { type Executor, Scheduler } from "../../../../src/platform/tasks/scheduler.ts";
import {
  appendRun,
  listRunSegmentMonths,
  loadTask,
  readAllRuns,
  readIdempotencyKey,
  readRunResult,
  readRuns,
  readRunTicket,
  saveIdempotencyKey,
  saveRunResult,
  saveRunTicket,
  saveTask,
} from "../../../../src/platform/tasks/store.ts";
import type { Batch, Task, TaskRun, TaskRunResult } from "../../../../src/platform/tasks/types.ts";
import { createRunAdmission } from "../../../../src/runtime/admission.ts";
import { seedWorkspaceRoot, TEST_WORKSPACE_ID } from "../../../helpers/test-workspace.ts";

const WS = TEST_WORKSPACE_ID;
const OWNER = "usr_test";
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;
/** The sweep's clock. With a 90 day window, the cutoff is 2026-03-17T12:00Z. */
const NOW = Date.UTC(2026, 5, 15, 12);
const OLD = "2026-01-10T08:00:00.000Z";
const RECENT = "2026-06-01T08:00:00.000Z";

let workDir: string;

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    prompt: "Do something",
    enabled: true,
    source: "user",
    workspaceId: WS,
    ownerId: OWNER,
    createdAt: OLD,
    updatedAt: OLD,
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    ...overrides,
  };
}

function makeRun(
  taskId: string,
  id: string,
  at: string,
  overrides: Partial<TaskRun> = {},
): TaskRun {
  return {
    id,
    taskId,
    startedAt: at,
    completedAt: at,
    status: "success",
    inputTokens: 1,
    outputTokens: 1,
    toolCalls: 0,
    iterations: 1,
    trigger: "manual",
    ...overrides,
  };
}

function makeResult(run: TaskRun): TaskRunResult {
  return {
    runId: run.id,
    taskId: run.taskId,
    completedAt: run.completedAt ?? run.startedAt,
    output: "done",
    activityLog: [],
    outputFiles: [],
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1 },
  };
}

/** Record a run in the task's hot index, with its result sidecar. */
function recordRun(taskId: string, runId: string, at: string): TaskRun {
  const run = makeRun(taskId, runId, at);
  saveRunResult(workDir, WS, OWNER, taskId, makeResult(run));
  appendRun(workDir, WS, OWNER, taskId, run);
  return run;
}

/** Write one archive month for a task: its index and one result sidecar. */
function seedArchiveMonth(taskId: string, month: string, runId: string): void {
  const dir = taskRunArchiveDir(workDir, WS, OWNER, taskId, month);
  mkdirSync(dir, { recursive: true });
  const run = makeRun(taskId, runId, `${month}-15T00:00:00.000Z`);
  writeFileSync(taskRunSegmentPath(workDir, WS, OWNER, taskId, month), `${JSON.stringify(run)}\n`);
  writeFileSync(taskArchivedRunResultPath(workDir, WS, OWNER, taskId, month, runId), "{}\n");
}

/** Write a run's ticket, last modified when the run ended (as the scheduler leaves it). */
function seedTicket(run: TaskRun, modifiedAt: string = run.completedAt ?? run.startedAt): void {
  saveRunTicket(workDir, WS, OWNER, {
    runId: run.id,
    taskId: run.taskId,
    requestedAt: run.startedAt,
    run,
  });
  const when = new Date(modifiedAt);
  utimesSync(taskRunTicketPath(workDir, WS, OWNER, run.id), when, when);
}

function seedBatch(id: string, taskId: string, overrides: Partial<Batch> = {}): void {
  saveBatch(workDir, {
    id,
    taskId,
    workspaceId: WS,
    ownerId: OWNER,
    items: 1,
    concurrency: 1,
    state: "completed",
    counts: emptyCounts(),
    costUsd: 0,
    createdAt: OLD,
    updatedAt: OLD,
    createdBy: OWNER,
    ...overrides,
  });
}

function deps(overrides: Partial<RetentionDeps> = {}): RetentionDeps {
  return {
    workDir,
    retentionDays: RETENTION_DAYS,
    now: () => NOW,
    isTaskBusy: () => false,
    forgetTask: () => {},
    ...overrides,
  };
}

const sweep = (overrides: Partial<RetentionDeps> = {}): Promise<RetentionReport> =>
  sweepRetention(deps(overrides));

const hasTicket = (runId: string) => readRunTicket(workDir, WS, OWNER, runId) !== null;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-tasks-retention-"));
  seedWorkspaceRoot(workDir, WS);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("archived runs", () => {
  test("a month goes once it ended more than the window ago, and no sooner", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    seedArchiveMonth("digest", "2026-01", "run_january00001");
    seedArchiveMonth("digest", "2026-02", "run_february0001");
    seedArchiveMonth("digest", "2026-03", "run_march0000001");

    const report = await sweep();

    // February ended on 1 March, before the 17 March cutoff. March ended on
    // 1 April, after it, though most of its runs are older than the window.
    expect(report.archiveMonths).toBe(2);
    expect(listRunSegmentMonths(workDir, WS, OWNER, "digest")).toEqual(["2026-03"]);
    expect(readRunResult(workDir, WS, OWNER, "digest", "run_march0000001")).not.toBeNull();
    expect(readRunResult(workDir, WS, OWNER, "digest", "run_february0001")).toBeNull();
    expect(readdirSync(taskRunArchiveRoot(workDir, WS, OWNER, "digest"))).toEqual(["2026-03"]);
  });

  test("the boundary is the month's end plus the window, to the millisecond", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    seedArchiveMonth("digest", "2026-02", "run_february0001");
    const expiresAt = Date.UTC(2026, 2, 1) + RETENTION_DAYS * DAY_MS;

    expect((await sweep({ now: () => expiresAt - 1 })).archiveMonths).toBe(0);
    expect(listRunSegmentMonths(workDir, WS, OWNER, "digest")).toEqual(["2026-02"]);

    expect((await sweep({ now: () => expiresAt })).archiveMonths).toBe(1);
    expect(listRunSegmentMonths(workDir, WS, OWNER, "digest")).toEqual([]);
  });

  test("the hot window is never touched, however old its runs", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    recordRun("digest", "run_ancient00001", "2024-02-01T00:00:00.000Z");
    recordRun("digest", "run_ancient00002", OLD);
    seedArchiveMonth("digest", "2025-11", "run_archived0001");

    await sweep();

    expect(readRuns(workDir, WS, OWNER, "digest").map((r) => r.id)).toEqual([
      "run_ancient00002",
      "run_ancient00001",
    ]);
    expect(existsSync(taskRunResultPath(workDir, WS, OWNER, "digest", "run_ancient00001"))).toBe(
      true,
    );
    expect(loadTask(workDir, WS, OWNER, "digest")).not.toBeNull();
  });

  test("a task whose definition is gone still has its archive expired", async () => {
    seedArchiveMonth("deleted-task", "2025-12", "run_orphan000001");

    expect((await sweep()).archiveMonths).toBe(1);
    expect(listRunSegmentMonths(workDir, WS, OWNER, "deleted-task")).toEqual([]);
  });

  test("a task an unsettled batch runs keeps its archive", async () => {
    saveTask(workDir, WS, OWNER, makeTask("extract"));
    seedArchiveMonth("extract", "2025-12", "run_batchrun0001");
    seedBatch("batch_0000000000a1", "extract", { state: "paused" });

    expect((await sweep()).archiveMonths).toBe(0);
    expect(listRunSegmentMonths(workDir, WS, OWNER, "extract")).toEqual(["2025-12"]);
  });
});

describe("run tickets", () => {
  test("an ended run's ticket goes with the key that names it; a recent one stays", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    const old = makeRun("digest", "run_old000000001", OLD, { idempotencyKey: "key-old" });
    const recent = makeRun("digest", "run_recent000001", RECENT, { idempotencyKey: "key-new" });
    seedTicket(old);
    seedTicket(recent);
    saveIdempotencyKey(workDir, WS, OWNER, "digest", "key-old", old.id);
    saveIdempotencyKey(workDir, WS, OWNER, "digest", "key-new", recent.id);

    const report = await sweep();

    expect(report.tickets).toBe(1);
    expect(hasTicket(old.id)).toBe(false);
    expect(readIdempotencyKey(workDir, WS, OWNER, "digest", "key-old")).toBeNull();
    expect(hasTicket(recent.id)).toBe(true);
    expect(readIdempotencyKey(workDir, WS, OWNER, "digest", "key-new")).toBe(recent.id);
  });

  test("an open ticket is never deleted, however old", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    const queued = makeRun("digest", "run_queued000001", OLD, {
      status: "queued",
      completedAt: undefined,
    });
    const running = makeRun("digest", "run_running00001", OLD, {
      status: "running",
      completedAt: undefined,
    });
    seedTicket(queued, OLD);
    seedTicket(running, OLD);

    expect((await sweep()).tickets).toBe(0);
    expect(readRunTicket(workDir, WS, OWNER, queued.id)?.run.status).toBe("queued");
    expect(readRunTicket(workDir, WS, OWNER, running.id)?.run.status).toBe("running");
  });

  test("a ticket rewritten inside the window stays, though its run ended before it", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    const run = makeRun("digest", "run_reassessed01", OLD);
    seedTicket(run, RECENT);

    expect((await sweep()).tickets).toBe(0);
    expect(hasTicket(run.id)).toBe(true);
  });

  test("a key that names another run is left for that run", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    const old = makeRun("digest", "run_old000000001", OLD, { idempotencyKey: "shared" });
    seedTicket(old);
    saveIdempotencyKey(workDir, WS, OWNER, "digest", "shared", "run_later0000001");

    await sweep();

    expect(hasTicket(old.id)).toBe(false);
    expect(readIdempotencyKey(workDir, WS, OWNER, "digest", "shared")).toBe("run_later0000001");
  });

  test("an unsettled batch keeps its runs' tickets; a settled one does not", async () => {
    saveTask(workDir, WS, OWNER, makeTask("extract"));
    seedBatch("batch_0000000000a1", "extract", { state: "paused" });
    seedBatch("batch_0000000000b2", "extract", {
      state: "cancelled",
      counts: { ...emptyCounts(), running: 1 },
    });
    seedBatch("batch_0000000000c3", "extract", { state: "completed" });
    const paused = makeRun("extract", "run_paused000001", OLD, { batchId: "batch_0000000000a1" });
    const unsettled = makeRun("extract", "run_unsettled001", OLD, {
      batchId: "batch_0000000000b2",
    });
    const done = makeRun("extract", "run_done00000001", OLD, { batchId: "batch_0000000000c3" });
    for (const run of [paused, unsettled, done]) seedTicket(run);

    expect((await sweep()).tickets).toBe(1);
    expect(hasTicket(paused.id)).toBe(true);
    expect(hasTicket(unsettled.id)).toBe(true);
    expect(hasTicket(done.id)).toBe(false);
  });

  test("a ticket file no reader can parse goes once it is past the window", async () => {
    const file = taskRunTicketPath(workDir, WS, OWNER, "run_torn00000001");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{ torn");
    utimesSync(file, new Date(OLD), new Date(OLD));

    expect((await sweep()).tickets).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
});

describe("one-off tasks", () => {
  function seedOneoff(id: string, ranAt: string, overrides: Partial<Task> = {}): void {
    saveTask(
      workDir,
      WS,
      OWNER,
      makeTask(id, { kind: "oneoff", createdAt: ranAt, updatedAt: ranAt, ...overrides }),
    );
    recordRun(id, `run_${id.replaceAll("-", "").padEnd(12, "0").slice(0, 12)}`, ranAt);
  }

  test("goes, definition and runs, once its newest run is past the window", async () => {
    seedOneoff("oneoff-old", OLD);
    seedOneoff("oneoff-recent", RECENT);
    const forgotten: string[] = [];
    const changed: string[] = [];

    const report = await sweep({
      forgetTask: (wsId, ownerId, id) => forgotten.push(`${wsId}/${ownerId}/${id}`),
      onOwnerChanged: (ownerId) => changed.push(ownerId),
    });

    expect(report.oneoffs).toBe(1);
    expect(loadTask(workDir, WS, OWNER, "oneoff-old")).toBeNull();
    expect(existsSync(taskRunsDir(workDir, WS, OWNER, "oneoff-old"))).toBe(false);
    expect(loadTask(workDir, WS, OWNER, "oneoff-recent")).not.toBeNull();
    expect(readRuns(workDir, WS, OWNER, "oneoff-recent")).toHaveLength(1);
    expect(forgotten).toEqual([`${WS}/${OWNER}/oneoff-old`]);
    expect(changed).toEqual([OWNER]);
    // Nothing is left beside the surviving one-off's runs.
    expect(readdirSync(ownerRunsRoot(workDir, WS, OWNER))).toEqual(["oneoff-recent"]);
  });

  test("an old one-off run again inside the window stays", async () => {
    seedOneoff("oneoff-rerun", OLD);
    recordRun("oneoff-rerun", "run_again0000001", RECENT);

    expect((await sweep()).oneoffs).toBe(0);
    expect(readRuns(workDir, WS, OWNER, "oneoff-rerun")).toHaveLength(2);
  });

  test("a saved task is never deleted, however long it has been idle", async () => {
    saveTask(workDir, WS, OWNER, makeTask("idle-saved"));
    saveTask(workDir, WS, OWNER, makeTask("idle-absent-kind", { kind: undefined }));
    recordRun("idle-saved", "run_idle00000001", OLD);

    expect((await sweep()).oneoffs).toBe(0);
    expect(loadTask(workDir, WS, OWNER, "idle-saved")).not.toBeNull();
    expect(loadTask(workDir, WS, OWNER, "idle-absent-kind")).not.toBeNull();
    expect(readRuns(workDir, WS, OWNER, "idle-saved")).toHaveLength(1);
  });

  test("one with a run in flight stays", async () => {
    seedOneoff("oneoff-busy", OLD);

    const report = await sweep({ isTaskBusy: (_ws, _owner, id) => id === "oneoff-busy" });

    expect(report.oneoffs).toBe(0);
    expect(loadTask(workDir, WS, OWNER, "oneoff-busy")).not.toBeNull();
    expect(readRuns(workDir, WS, OWNER, "oneoff-busy")).toHaveLength(1);
  });

  test("one marked with a scheduled run in flight, or given a schedule, stays", async () => {
    seedOneoff("oneoff-marked", OLD, {
      scheduledRunInFlight: { runId: "run_inflight0001", startedAt: OLD },
    });
    seedOneoff("oneoff-scheduled", OLD, { schedule: { type: "interval", intervalMs: 60_000 } });

    expect((await sweep()).oneoffs).toBe(0);
    expect(loadTask(workDir, WS, OWNER, "oneoff-marked")).not.toBeNull();
    expect(loadTask(workDir, WS, OWNER, "oneoff-scheduled")).not.toBeNull();
  });

  test("one a batch record names stays, whatever the batch's state", async () => {
    seedOneoff("oneoff-paused", OLD);
    seedOneoff("oneoff-finished", OLD);
    seedBatch("batch_0000000000a1", "oneoff-paused", { state: "paused" });
    seedBatch("batch_0000000000c3", "oneoff-finished", { state: "completed" });

    expect((await sweep()).oneoffs).toBe(0);
    expect(readRuns(workDir, WS, OWNER, "oneoff-paused")).toHaveLength(1);
    expect(readRuns(workDir, WS, OWNER, "oneoff-finished")).toHaveLength(1);
  });

  test("a real scheduler reports a one-off's requested run, and forgets a deleted one", async () => {
    saveTask(workDir, WS, OWNER, makeTask("oneoff-live", { kind: "oneoff", enabled: false }));
    const finishers: (() => void)[] = [];
    const executor: Executor = (task, _signal, trigger, _input, _lease, runId) =>
      new Promise((resolve) => {
        finishers.push(() => {
          const run = makeRun(task.id, runId ?? "run_unnamed00001", OLD, { trigger });
          resolve({ run, result: makeResult(run) });
        });
      });
    const scheduler = new Scheduler(executor, { workDir, admission: createRunAdmission() });
    scheduler.start();
    const schedulerDeps = {
      isTaskBusy: (ws: string, owner: string, id: string) => scheduler.isTaskBusy(ws, owner, id),
      forgetTask: (ws: string, owner: string, id: string) => scheduler.forgetTask(ws, owner, id),
    };
    try {
      const ticket = scheduler.requestRunNow(WS, OWNER, "oneoff-live", {
        runId: "run_requested001",
        requestedAt: OLD,
      });
      if (!ticket || ticket.state === "refused") throw new Error("the run was not admitted");

      // In flight: the definition is old and has no recorded run, yet it stays.
      expect((await sweep(schedulerDeps)).oneoffs).toBe(0);
      expect(loadTask(workDir, WS, OWNER, "oneoff-live")).not.toBeNull();

      finishers[0]?.();
      await ticket.run;
      await scheduler.assessmentsSettled();

      // Recording the run stamped the definition with the real clock, so the
      // one-off is inside the window again until that much time has passed.
      expect(scheduler.isTaskBusy(WS, OWNER, "oneoff-live")).toBe(false);
      expect((await sweep(schedulerDeps)).oneoffs).toBe(0);
      const later = { ...schedulerDeps, now: () => Date.now() + (RETENTION_DAYS + 1) * DAY_MS };
      expect((await sweep(later)).oneoffs).toBe(1);
      expect(loadTask(workDir, WS, OWNER, "oneoff-live")).toBeNull();
      expect(scheduler.getDefinitions().has(`${WS}/${OWNER}/oneoff-live`)).toBe(false);
    } finally {
      scheduler.stop();
    }
  });
});

describe("repeat and interruption", () => {
  test("a second sweep over a swept tree removes nothing", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    seedArchiveMonth("digest", "2025-12", "run_december0001");
    seedArchiveMonth("digest", "2026-05", "run_may000000001");
    recordRun("digest", "run_hot000000001", RECENT);
    seedTicket(makeRun("digest", "run_old000000001", OLD));
    saveTask(workDir, WS, OWNER, makeTask("oneoff-old", { kind: "oneoff" }));
    recordRun("oneoff-old", "run_oneoff000001", OLD);

    expect(await sweep()).toEqual({ archiveMonths: 1, tickets: 1, oneoffs: 1 });
    const after = readdirSync(workDir, { recursive: true }).sort();

    expect(await sweep()).toEqual({ archiveMonths: 0, tickets: 0, oneoffs: 0 });
    expect(readdirSync(workDir, { recursive: true }).sort()).toEqual(after);
  });

  test("a removal cut off after its rename is invisible to readers and finished by the next sweep", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    recordRun("digest", "run_hot000000001", RECENT);
    seedArchiveMonth("digest", "2026-05", "run_may000000001");
    // What a stopped sweep leaves: a month and a one-off's runs dir, each
    // renamed out of use with its files still in it.
    const archiveRoot = taskRunArchiveRoot(workDir, WS, OWNER, "digest");
    const deadMonth = join(archiveRoot, ".expired-2025-12-0a1b2c3d");
    mkdirSync(deadMonth, { recursive: true });
    writeFileSync(
      join(deadMonth, "index.jsonl"),
      `${JSON.stringify(makeRun("digest", "run_december0001", "2025-12-15T00:00:00.000Z"))}\n`,
    );
    const runsRoot = ownerRunsRoot(workDir, WS, OWNER);
    const deadRuns = join(runsRoot, ".expired-oneoff-old-0a1b2c3d");
    mkdirSync(deadRuns, { recursive: true });
    writeFileSync(
      join(deadRuns, "index.jsonl"),
      `${JSON.stringify(makeRun("oneoff-old", "run_oneoff000001", OLD))}\n`,
    );

    expect(listRunSegmentMonths(workDir, WS, OWNER, "digest")).toEqual(["2026-05"]);
    expect(readAllRuns(workDir, WS, OWNER).map((r) => r.id)).toEqual(["run_hot000000001"]);

    await sweep();

    expect(existsSync(deadMonth)).toBe(false);
    expect(existsSync(deadRuns)).toBe(false);
    expect(listRunSegmentMonths(workDir, WS, OWNER, "digest")).toEqual(["2026-05"]);
  });

  test("a one-off whose runs went before a crash loses its definition on the next sweep", async () => {
    // The runs dir is removed first, so a crash leaves a definition with no
    // runs: still a one-off past the window, never a runs dir with no task.
    saveTask(workDir, WS, OWNER, makeTask("oneoff-half", { kind: "oneoff" }));

    expect((await sweep()).oneoffs).toBe(1);
    expect(existsSync(taskFilePath(workDir, WS, OWNER, "oneoff-half"))).toBe(false);
  });

  test("a ticket whose key went before a crash is deleted on the next sweep", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    const run = makeRun("digest", "run_old000000001", OLD, { idempotencyKey: "key-old" });
    seedTicket(run);
    // The key is removed first, so a crash leaves a ticket with no key (still
    // expired), never a key naming a run whose ticket is gone.
    expect(readIdempotencyKey(workDir, WS, OWNER, "digest", "key-old")).toBeNull();

    expect((await sweep()).tickets).toBe(1);
    expect(hasTicket(run.id)).toBe(false);
  });

  test("a stopped sweep removes nothing more", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    seedArchiveMonth("digest", "2025-12", "run_december0001");
    seedTicket(makeRun("digest", "run_old000000001", OLD));

    expect(await sweep({ stopped: () => true })).toEqual({
      archiveMonths: 0,
      tickets: 0,
      oneoffs: 0,
    });
    expect(listRunSegmentMonths(workDir, WS, OWNER, "digest")).toEqual(["2025-12"]);
  });
});

describe("startRetentionSweep", () => {
  test("sweeps after its first delay, and not once stopped", async () => {
    saveTask(workDir, WS, OWNER, makeTask("digest"));
    seedArchiveMonth("digest", "2025-12", "run_december0001");
    const { stopped: _stopped, ...scheduleDeps } = deps();

    const idle = startRetentionSweep(scheduleDeps, { firstDelayMs: 5, intervalMs: 60_000 });
    idle.stop();
    await Bun.sleep(30);
    expect(listRunSegmentMonths(workDir, WS, OWNER, "digest")).toEqual(["2025-12"]);

    const schedule = startRetentionSweep(scheduleDeps, { firstDelayMs: 5, intervalMs: 60_000 });
    try {
      for (let i = 0; i < 100 && listRunSegmentMonths(workDir, WS, OWNER, "digest").length; i++) {
        await Bun.sleep(10);
      }
      expect(listRunSegmentMonths(workDir, WS, OWNER, "digest")).toEqual([]);
    } finally {
      schedule.stop();
    }
  });
});
