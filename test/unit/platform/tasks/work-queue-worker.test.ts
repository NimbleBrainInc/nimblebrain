/**
 * The scheduler on the work queue: the timer and Run now only enqueue, and the
 * worker claims an item when run admission has a free slot and decides from
 * the task's own records whether it runs. Every case runs the filesystem queue
 * in a temp directory; a later "process" opens the queue on a clock past the
 * lease, so it claims a dead process's item again (`attempt > 1`).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  mock,
  setSystemTime,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Executor,
  REQUESTED_RUN_KIND,
  type RequestedRun,
  requestedItemKey,
  SCHEDULED_RUN_KIND,
  Scheduler,
  scheduledItemKey,
} from "../../../../src/platform/tasks/scheduler.ts";
import {
  loadTask,
  readRuns,
  readRunTicket,
  saveRunTicket,
  saveTask,
} from "../../../../src/platform/tasks/store.ts";
import { ONCE_GRACE_MS, type Task, type TaskRun } from "../../../../src/platform/tasks/types.ts";
import { createFilesystemWorkQueue } from "../../../../src/providers/queue/filesystem.ts";
import type { WorkQueue } from "../../../../src/providers/queue/types.ts";
import { createRunAdmission } from "../../../../src/runtime/admission.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

const WS = "ws_00c0ffee00c0ffee";
const OWNER = "usr_worker";
const RUN_ID = "run_0123456789ab";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Past any lease the worker takes. */
const LEASE_EXPIRED_MS = 5 * 60_000;

let workDir: string;
const toStop: Array<() => unknown> = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "work-queue-worker-"));
  seedWorkspaceRoot(workDir, WS);
});

afterEach(async () => {
  for (const stop of toStop.splice(0).reverse()) await stop();
  rmSync(workDir, { recursive: true, force: true });
});

/** One process's view of the queue, on a clock `aheadMs` ahead of now. */
function openQueue(aheadMs = 0): WorkQueue {
  const queue = createFilesystemWorkQueue({
    dir: join(workDir, "queue"),
    now: () => Date.now() + aheadMs,
  });
  toStop.push(() => queue.close());
  return queue;
}

function seedTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: "digest",
    ownerId: OWNER,
    workspaceId: WS,
    name: "Digest",
    prompt: "Summarize.",
    schedule: { type: "interval", intervalMs: 3_600_000 },
    enabled: false,
    source: "user",
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    ...overrides,
  };
  saveTask(workDir, WS, OWNER, task);
  return task;
}

function successExecutor(): Mock<Executor> {
  return mock<Executor>(async (task, _signal, trigger, _input, _lease, runId) => {
    const at = new Date().toISOString();
    const run: TaskRun = {
      id: runId ?? "run_unnamed00000",
      taskId: task.id,
      startedAt: at,
      completedAt: at,
      status: "success",
      inputTokens: 1,
      outputTokens: 1,
      toolCalls: 0,
      iterations: 1,
      trigger,
    };
    return { run, result: null };
  });
}

/** An executor whose runs stay open until `release`. */
function heldExecutor(): { executor: Mock<Executor>; release: () => void } {
  const waiting: Array<() => void> = [];
  const inner = successExecutor();
  const executor = mock<Executor>(
    (...args) =>
      new Promise((resolve) => {
        waiting.push(() => resolve(inner(...args)));
      }),
  );
  return {
    executor,
    release: () => {
      for (const go of waiting.splice(0)) go();
    },
  };
}

function startScheduler(executor: Executor, queue: WorkQueue, maxConcurrentRuns = 2): Scheduler {
  const scheduler = new Scheduler(executor, {
    workDir,
    queue,
    admission: createRunAdmission({ maxConcurrentRuns }),
  });
  scheduler.start();
  toStop.push(() => scheduler.stop());
  return scheduler;
}

/** Put a Run now on the queue as a stopped process left it, with its ticket `status`. */
async function leaveRequested(
  queue: WorkQueue,
  status: "queued" | "running" | null,
  opts: { claim?: boolean; notBefore?: string; claimToken?: number } = {},
): Promise<RequestedRun> {
  const requested: RequestedRun = { runId: RUN_ID, requestedAt: new Date().toISOString() };
  await queue.enqueue({
    scope: WS,
    kind: REQUESTED_RUN_KIND,
    payload: { workspaceId: WS, ownerId: OWNER, taskId: "digest", requested },
    idempotencyKey: requestedItemKey(OWNER, "digest", requested),
    ...(opts.notBefore ? { notBefore: opts.notBefore } : {}),
  });
  if (opts.claim) {
    await queue.claim({ workerId: "dead", leaseMs: 60_000, kinds: [REQUESTED_RUN_KIND] });
  }
  if (status) {
    saveRunTicket(workDir, WS, OWNER, {
      runId: RUN_ID,
      taskId: "digest",
      requestedAt: requested.requestedAt,
      claimToken: opts.claimToken ?? (opts.claim ? 1 : 0),
      run: {
        id: RUN_ID,
        taskId: "digest",
        startedAt: requested.requestedAt,
        status,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        iterations: 0,
        ...(status === "running" ? { trigger: "manual" as const } : {}),
      },
    });
  }
  return requested;
}

/** Put a due occurrence of `task` on the queue as a stopped process claimed it. */
async function leaveScheduledClaimed(queue: WorkQueue, task: Task): Promise<void> {
  const occurrence = task.nextRunAt!;
  await queue.enqueue({
    scope: WS,
    kind: SCHEDULED_RUN_KIND,
    payload: { workspaceId: WS, ownerId: OWNER, taskId: task.id, runId: RUN_ID, occurrence },
    idempotencyKey: scheduledItemKey(OWNER, task.id, occurrence),
  });
  await queue.claim({ workerId: "dead", leaseMs: 60_000, kinds: [SCHEDULED_RUN_KIND] });
}

describe("the timer only enqueues", () => {
  it("a due occurrence waits on the queue while no slot is free, then runs once", async () => {
    seedTask({ id: "blocker" });
    const due = seedTask({
      enabled: true,
      nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { executor, release } = heldExecutor();
    const scheduler = startScheduler(executor, openQueue(), 1);

    // A Run now holds the one slot; then the task comes due.
    scheduler.requestRunNow(WS, OWNER, "blocker");
    await scheduler.drain();
    const past = new Date(Date.now() - 1000).toISOString();
    scheduler.getDefinitions().get(`${WS}/${OWNER}/${due.id}`)!.nextRunAt = past;
    saveTask(workDir, WS, OWNER, { ...due, nextRunAt: past });

    // Each tick finds it due; it is enqueued once and waits for the slot.
    await scheduler.onTimer();
    await scheduler.onTimer();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(scheduler.queueView(WS, OWNER).map((e) => [e.taskId, e.state])).toEqual([
      ["blocker", "running"],
      [due.id, "queued"],
    ]);

    // The slot frees: the worker claims the occurrence at once, with no tick.
    release();
    await sleep(20);
    expect(executor).toHaveBeenCalledTimes(2);
    release();
    await sleep(20);
    await scheduler.onTimer();
    expect(executor.mock.calls.map(([task, , trigger]) => [task.id, trigger])).toEqual([
      ["blocker", "manual"],
      [due.id, "scheduled"],
    ]);
    const runs = readRuns(workDir, WS, OWNER, due.id);
    expect(runs.map((r) => [r.status, r.trigger])).toEqual([["success", "scheduled"]]);
    expect(new Date(loadTask(workDir, WS, OWNER, due.id)!.nextRunAt!).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("a Run now answers at once and starts when the worker claims it", async () => {
    seedTask();
    const queue = openQueue();
    const executor = successExecutor();
    const scheduler = startScheduler(executor, queue);
    const ticket = scheduler.requestRunNow(WS, OWNER, "digest", {
      runId: RUN_ID,
      requestedAt: new Date().toISOString(),
    });
    expect(ticket?.state).toBe("started");
    // The ticket is written with the item, before any claim.
    expect(readRunTicket(workDir, WS, OWNER, RUN_ID)?.run.status).toBe("queued");
    expect(executor).toHaveBeenCalledTimes(0);
    if (ticket?.state !== "started") throw new Error("expected started");
    const run = await ticket.run;
    expect(run.id).toBe(RUN_ID);
    expect(readRunTicket(workDir, WS, OWNER, RUN_ID)?.run.status).toBe("success");
  });
});

describe("a claim after the holder stopped (attempt > 1)", () => {
  it("runs a requested run whose ticket says it never started", async () => {
    seedTask();
    const dead = openQueue();
    await leaveRequested(dead, "queued", { claim: true });
    await dead.close();

    const executor = successExecutor();
    const scheduler = startScheduler(executor, openQueue(LEASE_EXPIRED_MS));
    await scheduler.drain();
    await scheduler.runEnded(RUN_ID);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]?.[5]).toBe(RUN_ID);
    expect(readRunTicket(workDir, WS, OWNER, RUN_ID)?.run.status).toBe("success");
  });

  it("runs a requested run whose ticket was never written", async () => {
    seedTask();
    const dead = openQueue();
    await leaveRequested(dead, null, { claim: true });
    await dead.close();

    const executor = successExecutor();
    const scheduler = startScheduler(executor, openQueue(LEASE_EXPIRED_MS));
    await scheduler.drain();
    await scheduler.runEnded(RUN_ID);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(readRuns(workDir, WS, OWNER, "digest").map((r) => r.id)).toEqual([RUN_ID]);
  });

  it("records a requested run that had started as lost, and never runs it again", async () => {
    seedTask();
    const dead = openQueue();
    await leaveRequested(dead, "running", { claim: true });
    await dead.close();

    const executor = successExecutor();
    const next = openQueue(LEASE_EXPIRED_MS);
    const scheduler = startScheduler(executor, next);
    await scheduler.drain();
    expect(executor).not.toHaveBeenCalled();
    const runs = readRuns(workDir, WS, OWNER, "digest");
    expect(runs.map((r) => [r.id, r.status])).toEqual([[RUN_ID, "failure"]]);
    expect(runs[0]?.error).toContain("runtime stopped while this run was in flight");
    expect(readRunTicket(workDir, WS, OWNER, RUN_ID)?.run.status).toBe("failure");

    // The item is settled: no later claim finds it.
    expect(await next.claim({ workerId: "w", leaseMs: 1000, kinds: [REQUESTED_RUN_KIND] })).toBe(
      null,
    );
  });

  it("runs a scheduled occurrence the holder claimed but never started", async () => {
    const task = seedTask({ enabled: true, nextRunAt: new Date(Date.now() - 1000).toISOString() });
    const dead = openQueue();
    await leaveScheduledClaimed(dead, task);
    await dead.close();

    const executor = successExecutor();
    const scheduler = startScheduler(executor, openQueue(LEASE_EXPIRED_MS));
    await scheduler.onTimer();

    expect(executor).toHaveBeenCalledTimes(1);
    expect(readRuns(workDir, WS, OWNER, task.id).map((r) => [r.id, r.status])).toEqual([
      [RUN_ID, "success"],
    ]);
  });

  it("records a scheduled occurrence that had started as interrupted, and never runs it again", async () => {
    const task = seedTask({
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
      scheduledRunInFlight: { runId: RUN_ID, startedAt: new Date().toISOString() },
    });
    const dead = openQueue();
    await leaveScheduledClaimed(dead, task);
    await dead.close();

    const executor = successExecutor();
    const next = openQueue(LEASE_EXPIRED_MS);
    const scheduler = startScheduler(executor, next);
    await scheduler.onTimer();
    await scheduler.drain();

    expect(executor).not.toHaveBeenCalled();
    const runs = readRuns(workDir, WS, OWNER, task.id);
    expect(runs.map((r) => [r.id, r.status])).toEqual([[RUN_ID, "failure"]]);
    const stored = loadTask(workDir, WS, OWNER, task.id)!;
    expect(stored.scheduledRunInFlight).toBeUndefined();
    expect(new Date(stored.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(await next.claim({ workerId: "w", leaseMs: 1000, kinds: [SCHEDULED_RUN_KIND] })).toBe(
      null,
    );
  });

  it("leaves a ticket a newer claim wrote alone (fencing)", async () => {
    seedTask();
    const dead = openQueue();
    await leaveRequested(dead, "queued", { claim: true, claimToken: 9 });
    await dead.close();

    const executor = successExecutor();
    const scheduler = startScheduler(executor, openQueue(LEASE_EXPIRED_MS));
    await scheduler.drain();

    expect(executor).not.toHaveBeenCalled();
    const ticket = readRunTicket(workDir, WS, OWNER, RUN_ID);
    expect(ticket?.claimToken).toBe(9);
    expect(ticket?.run.status).toBe("queued");
  });
});

describe("cancel, pause, and delete are read at claim", () => {
  it("a queued run a stopped process left is cancelled by id, and its claim does not run it", async () => {
    seedTask();
    const dead = openQueue();
    // Due in an hour, so nothing claims it before the cancel.
    await leaveRequested(dead, "queued", {
      notBefore: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await dead.close();

    const executor = successExecutor();
    const queue = openQueue();
    const scheduler = startScheduler(executor, queue);
    expect(scheduler.cancelRunById(WS, OWNER, RUN_ID)).toBe(true);
    expect(readRunTicket(workDir, WS, OWNER, RUN_ID)?.run.status).toBe("cancelled");
    expect(readRuns(workDir, WS, OWNER, "digest").map((r) => r.status)).toEqual(["cancelled"]);
    expect(scheduler.cancelRunById(WS, OWNER, RUN_ID)).toBe(false);
    scheduler.stop();
    await queue.close();

    const later = startScheduler(executor, openQueue(2 * 3_600_000));
    await later.drain();
    expect(executor).not.toHaveBeenCalled();
    expect(readRuns(workDir, WS, OWNER, "digest")).toHaveLength(1);
  });

  it("a due occurrence whose task was disabled while it waited is recorded skipped and moves on", async () => {
    const task = seedTask({ enabled: true, nextRunAt: new Date(Date.now() - 1000).toISOString() });
    const dead = openQueue();
    await leaveScheduledClaimed(dead, task);
    await dead.close();
    saveTask(workDir, WS, OWNER, { ...task, enabled: false });

    const executor = successExecutor();
    const scheduler = startScheduler(executor, openQueue(LEASE_EXPIRED_MS));
    await scheduler.drain();

    expect(executor).not.toHaveBeenCalled();
    const runs = readRuns(workDir, WS, OWNER, task.id);
    expect(runs.map((r) => [r.status, r.error, r.trigger])).toEqual([
      ["skipped", "Disabled while waiting for a run slot", undefined],
    ]);
    expect(new Date(loadTask(workDir, WS, OWNER, task.id)!.nextRunAt!).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("a queued run whose task was deleted settles without running", async () => {
    const dead = openQueue();
    await leaveRequested(dead, "queued");
    await dead.close();

    const executor = successExecutor();
    const scheduler = startScheduler(executor, openQueue());
    await scheduler.drain();

    expect(executor).not.toHaveBeenCalled();
    const ticket = readRunTicket(workDir, WS, OWNER, RUN_ID);
    expect(ticket?.run.status).toBe("skipped");
    expect(ticket?.run.error).toBe("the task was deleted while queued");
  });
});

describe("one run per task, checked at claim", () => {
  it("a Run now claimed while the task's run is in flight is recorded skipped", async () => {
    seedTask();
    const { executor, release } = heldExecutor();
    const queue = openQueue();
    const scheduler = startScheduler(executor, queue);
    scheduler.requestRunNow(WS, OWNER, "digest");
    await scheduler.drain();
    expect(executor).toHaveBeenCalledTimes(1);

    // A second request for the task reached the queue (a restart's), past the
    // request-time check.
    await leaveRequested(queue, "queued");
    await scheduler.drain();
    expect(executor).toHaveBeenCalledTimes(1);
    const second = readRunTicket(workDir, WS, OWNER, RUN_ID)?.run;
    expect([second?.status, second?.error]).toEqual(["skipped", "Already running (runNow)"]);

    release();
    await scheduler.assessmentsSettled();
  });
});

describe("queue position", () => {
  it("numbers the runs waiting in this process, and a run that starts leaves the line", async () => {
    for (const id of ["a", "b", "c"]) seedTask({ id });
    const { executor, release } = heldExecutor();
    const scheduler = startScheduler(executor, openQueue(), 1);

    expect(scheduler.requestRunNow(WS, OWNER, "a")?.state).toBe("started");
    expect(scheduler.requestRunNow(WS, OWNER, "b")).toMatchObject({ state: "queued", position: 1 });
    expect(scheduler.requestRunNow(WS, OWNER, "c")).toMatchObject({ state: "queued", position: 2 });
    await scheduler.drain();
    expect(
      scheduler
        .queueView(WS, OWNER)
        .map((e) => [e.taskId, e.state, e.position])
        .sort(),
    ).toEqual([
      ["a", "running", undefined],
      ["b", "queued", 1],
      ["c", "queued", 2],
    ]);

    release();
    await sleep(20);
    expect(scheduler.queueView(WS, OWNER).find((e) => e.taskId === "c")?.position).toBe(1);
    release();
    await sleep(20);
    release();
    await scheduler.assessmentsSettled();
  });
});

describe("a once at restart", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("whose occurrence was on the queue runs once after a restart past its grace, and retires ran", async () => {
    const at = new Date(Date.now() - 1000).toISOString();
    seedTask({ id: "blocker" });
    const once = seedTask({ enabled: true, schedule: { type: "once", at }, nextRunAt: at });
    const admission = createRunAdmission({ maxConcurrentRuns: 1 });
    const queue = openQueue();
    const first = new Scheduler(successExecutor(), { workDir, queue, admission });
    first.start();
    // Another source holds the one slot, so the occurrence fires and waits.
    const hold = admission.request({ workspaceId: WS, key: "test:hold" });
    if (hold.state !== "admitted") throw new Error("expected the slot");
    await first.onTimer();
    expect(loadTask(workDir, WS, OWNER, once.id)?.onceQueuedAt).toBe(at);
    expect(readRuns(workDir, WS, OWNER, once.id)).toEqual([]);
    first.stop();
    await queue.close();

    // The runtime comes back after the grace window.
    setSystemTime(new Date(Date.now() + ONCE_GRACE_MS + 60_000));
    const executor = successExecutor();
    const second = startScheduler(executor, openQueue());
    await second.onTimer();
    await second.drain();

    expect(executor).toHaveBeenCalledTimes(1);
    const runs = readRuns(workDir, WS, OWNER, once.id);
    expect(runs.map((r) => [r.status, r.trigger])).toEqual([["success", "scheduled"]]);
    const stored = loadTask(workDir, WS, OWNER, once.id)!;
    expect(stored.onceDone?.outcome).toBe("ran");
    expect(stored.enabled).toBe(false);
    expect(stored.onceQueuedAt).toBeUndefined();
  });

  it("whose occurrence was never enqueued is still retired missed", async () => {
    const at = new Date(Date.now() - ONCE_GRACE_MS - 60_000).toISOString();
    const once = seedTask({ enabled: true, schedule: { type: "once", at }, nextRunAt: at });
    const executor = successExecutor();
    const scheduler = startScheduler(executor, openQueue());
    await scheduler.onTimer();
    await scheduler.drain();

    expect(executor).not.toHaveBeenCalled();
    const stored = loadTask(workDir, WS, OWNER, once.id)!;
    expect(stored.onceDone?.outcome).toBe("missed");
    expect(readRuns(workDir, WS, OWNER, once.id).map((r) => r.status)).toEqual(["skipped"]);
  });
});
