import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticToolRouter } from "../../../../src/adapters/static-router.ts";
import { taskRunsTotal } from "../../../../src/api/metrics.ts";
import { resolveTasksConfig } from "../../../../src/config/tasks.ts";
import { textContent } from "../../../../src/engine/content-helpers.ts";
import { AgentEngine } from "../../../../src/engine/engine.ts";
import type { ToolResult, ToolSchema } from "../../../../src/engine/types.ts";
import { createDirectExecutor, type TaskFn } from "../../../../src/platform/tasks/executor.ts";
import { taskRunIndexPath } from "../../../../src/platform/tasks/paths.ts";
import {
  backoffDelay,
  budgetSpendAccounts,
  computeBudgetResetAt,
  computeNextRunAt,
  countsAsEventFire,
  type Executor,
  INTERRUPTED_RUN_ERROR,
  isDue,
  isInBackoff,
  isTransientError,
  Scheduler,
  type TaskRunTrigger,
} from "../../../../src/platform/tasks/scheduler.ts";
import {
  appendRun,
  loadOwnerTasks,
  readRunResult,
  readRuns,
  saveTask,
} from "../../../../src/platform/tasks/store.ts";
import type { Task, TaskRun } from "../../../../src/platform/tasks/types.ts";
import { createRunAdmission } from "../../../../src/runtime/admission.ts";
import {
  getRequestContext,
  runWithRequestContext,
} from "../../../../src/runtime/request-context.ts";
import { createSpendBalances } from "../../../../src/runtime/spend.ts";
import { createMockModel } from "../../../helpers/mock-model.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Tasks are workspace-owned: the scheduler scans
// `{workDir}/workspaces/<wsId>/tasks/<ownerId>/`. Tests seed ONE workspace
// + owner; `makeTmpDir` returns the workDir root handed straight to the
// Scheduler, and `seedDefs`/`loadDefs` write/read the per-task store.
const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-test-"));
  seedWorkspaceRoot(dir, WS);
  return dir;
}

/** Persist a definitions map to the per-task store (one file per task). */
function seedDefs(workDir: string, defs: Map<string, Task>, owner = OWNER, ws = WS): void {
  seedWorkspaceRoot(workDir, ws);
  for (const auto of defs.values()) {
    if (!auto.workspaceId) auto.workspaceId = ws;
    if (!auto.ownerId) auto.ownerId = owner;
    saveTask(workDir, ws, owner, auto);
  }
}

function loadDefs(workDir: string, owner = OWNER, ws = WS): Map<string, Task> {
  return loadOwnerTasks(workDir, ws, owner);
}

/** Look up a seeded task in the scheduler's composite-keyed map. */
function defOf(scheduler: Scheduler, id: string, owner = OWNER, ws = WS): Task | undefined {
  return scheduler.getDefinitions().get(`${ws}/${owner}/${id}`);
}

/** Wrap a run in the executor's `{ run, result }` return shape. */
function execOk(run: TaskRun): { run: TaskRun; result: null } {
  return { run, result: null };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test-auto",
    ownerId: OWNER,
    workspaceId: WS,
    name: "Test Task",
    prompt: "Do the thing",
    schedule: { type: "interval", intervalMs: 60_000 },
    enabled: true,
    source: "user",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    ...overrides,
  };
}

function makeSuccessRun(taskId: string): TaskRun {
  return {
    id: `run_${Date.now()}`,
    taskId,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "success",
    inputTokens: 100,
    outputTokens: 50,
    toolCalls: 1,
    iterations: 1,
  };
}

function makeFailureRun(taskId: string, error = "Something broke"): TaskRun {
  return {
    id: `run_${Date.now()}`,
    taskId,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "failure",
    inputTokens: 100,
    outputTokens: 0,
    toolCalls: 0,
    iterations: 1,
    error,
    transient: isTransientError(error),
  };
}

function createMockExecutor(result?: TaskRun): Executor {
  return mock(async (auto: Task, _signal: AbortSignal) => {
    return execOk(result ?? makeSuccessRun(auto.id));
  }) as Executor;
}

/** Executor that throws — exercises `dispatchRun`'s catch/classification path. */
function createThrowingExecutor(err: unknown): Executor {
  return mock(async () => {
    throw err;
  }) as Executor;
}

/** Create a delayed executor that resolves after a given delay (or never, until signaled). */
function createBlockingExecutor(): {
  executor: Executor;
  resolve: (run: TaskRun) => void;
  promise: Promise<{ run: TaskRun; result: null }>;
} {
  let resolve!: (run: TaskRun) => void;
  const promise = new Promise<{ run: TaskRun; result: null }>((r) => {
    resolve = (run: TaskRun) => r(execOk(run));
  });
  const executor: Executor = mock(async (_auto: Task, _signal: AbortSignal) => {
    return promise;
  }) as Executor;
  return { executor, resolve, promise };
}

// ---------------------------------------------------------------------------
// Tests: isTransientError
// ---------------------------------------------------------------------------

describe("isTransientError", () => {
  it("detects rate limit", () => {
    expect(isTransientError("rate limit exceeded")).toBe(true);
    expect(isTransientError("Rate_Limit hit")).toBe(true);
    expect(isTransientError("ratelimit")).toBe(true);
  });

  it("detects overloaded", () => {
    expect(isTransientError("Server overloaded")).toBe(true);
  });

  it("detects timeout", () => {
    expect(isTransientError("Request timeout")).toBe(true);
  });

  it("detects network errors", () => {
    expect(isTransientError("network error occurred")).toBe(true);
  });

  it("detects ECONNREFUSED", () => {
    expect(isTransientError("connect ECONNREFUSED 127.0.0.1:3000")).toBe(true);
  });

  it("detects 5xx status codes", () => {
    expect(isTransientError("HTTP 500 Internal Server Error")).toBe(true);
    expect(isTransientError("503 Service Unavailable")).toBe(true);
  });

  it("returns false for non-transient errors", () => {
    expect(isTransientError("invalid prompt")).toBe(false);
    expect(isTransientError("authentication failed")).toBe(false);
    expect(isTransientError("permission denied")).toBe(false);
    expect(isTransientError("HTTP 400 Bad Request")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: backoffDelay
// ---------------------------------------------------------------------------

describe("backoffDelay", () => {
  it("returns 0 for 0 errors", () => {
    expect(backoffDelay(0)).toBe(0);
  });

  it("returns 30s for 1 error", () => {
    expect(backoffDelay(1)).toBe(30_000);
  });

  it("returns 60s for 2 errors", () => {
    expect(backoffDelay(2)).toBe(60_000);
  });

  it("returns 5m for 3 errors", () => {
    expect(backoffDelay(3)).toBe(300_000);
  });

  it("returns 15m for 4 errors", () => {
    expect(backoffDelay(4)).toBe(900_000);
  });

  it("returns 1h for 5 errors", () => {
    expect(backoffDelay(5)).toBe(3_600_000);
  });

  it("caps at 1h for 6+ errors", () => {
    expect(backoffDelay(6)).toBe(3_600_000);
    expect(backoffDelay(100)).toBe(3_600_000);
  });
});

// ---------------------------------------------------------------------------
// Tests: isInBackoff
// ---------------------------------------------------------------------------

describe("isInBackoff", () => {
  it("returns false when no errors", () => {
    const auto = makeTask({ consecutiveErrors: 0 });
    expect(isInBackoff(auto, Date.now())).toBe(false);
  });

  it("returns true when in backoff period", () => {
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    const auto = makeTask({
      consecutiveErrors: 1,
      nextRunAt: futureTime,
    });
    expect(isInBackoff(auto, Date.now())).toBe(true);
  });

  it("returns false when backoff period has passed", () => {
    const pastTime = new Date(Date.now() - 1000).toISOString();
    const auto = makeTask({
      consecutiveErrors: 1,
      nextRunAt: pastTime,
    });
    expect(isInBackoff(auto, Date.now())).toBe(false);
  });

  it("returns false when no nextRunAt set", () => {
    const auto = makeTask({
      consecutiveErrors: 2,
      nextRunAt: undefined,
    });
    expect(isInBackoff(auto, Date.now())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: computeNextRunAt
// ---------------------------------------------------------------------------

describe("computeNextRunAt", () => {
  it("computes interval next run after lastRunAt", () => {
    const lastRun = Date.now() - 30_000; // 30s ago
    const auto = makeTask({
      schedule: { type: "interval", intervalMs: 60_000 },
      lastRunAt: new Date(lastRun).toISOString(),
    });
    const next = computeNextRunAt(auto, Date.now());
    expect(next).toBe(lastRun + 60_000);
  });

  it("interval fires immediately when no lastRunAt", () => {
    const now = Date.now();
    const auto = makeTask({
      schedule: { type: "interval", intervalMs: 60_000 },
      lastRunAt: undefined,
    });
    const next = computeNextRunAt(auto, now);
    expect(next).toBe(now);
  });

  it("computes cron next run", () => {
    const now = Date.now();
    const auto = makeTask({
      schedule: { type: "cron", expression: "* * * * *" }, // every minute
    });
    const next = computeNextRunAt(auto, now);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now);
    // Should be within 60s
    expect(next! - now).toBeLessThanOrEqual(60_000);
  });

  it("computes cron with timezone", () => {
    // "0 8 * * *" in Pacific/Honolulu should produce a valid next run
    const now = Date.now();
    const auto = makeTask({
      schedule: {
        type: "cron",
        expression: "0 8 * * *",
        timezone: "Pacific/Honolulu",
      },
    });
    const next = computeNextRunAt(auto, now);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now);

    // Verify the hour in Honolulu timezone is 8
    const nextDate = new Date(next!);
    const honoluluHour = Number(
      nextDate.toLocaleString("en-US", {
        timeZone: "Pacific/Honolulu",
        hour: "numeric",
        hour12: false,
      }),
    );
    expect(honoluluHour).toBe(8);
  });

  it("returns null for invalid schedule", () => {
    const auto = makeTask({
      schedule: { type: "interval" }, // missing intervalMs
    });
    const next = computeNextRunAt(auto, Date.now());
    expect(next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: isDue
// ---------------------------------------------------------------------------

describe("isDue", () => {
  it("returns false when disabled", () => {
    const auto = makeTask({ enabled: false });
    expect(isDue(auto, Date.now())).toBe(false);
  });

  it("returns true when no nextRunAt (first interval run)", () => {
    const auto = makeTask({ nextRunAt: undefined });
    expect(isDue(auto, Date.now())).toBe(true);
  });

  it("returns true when past nextRunAt", () => {
    const auto = makeTask({
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(isDue(auto, Date.now())).toBe(true);
  });

  it("returns false when before nextRunAt", () => {
    const auto = makeTask({
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(isDue(auto, Date.now())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — timer arming
// ---------------------------------------------------------------------------

describe("Scheduler — timer arming", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("arms timer to exact next-due time when < 60s", () => {
    const delayMs = 15_000; // 15s from now
    const nextRunAt = new Date(Date.now() + delayMs).toISOString();

    const auto = makeTask({ nextRunAt });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });

    // Spy on setTimeout
    const originalSetTimeout = globalThis.setTimeout;
    let capturedDelay = -1;
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      capturedDelay = delay ?? 0;
      return originalSetTimeout(fn, delay);
    }) as typeof globalThis.setTimeout;

    try {
      scheduler.start();
      // The timer delay should be approximately delayMs (within a small tolerance)
      expect(capturedDelay).toBeGreaterThanOrEqual(0);
      expect(capturedDelay).toBeLessThanOrEqual(delayMs + 100);
      expect(capturedDelay).toBeLessThan(60_000);
    } finally {
      scheduler.stop();
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("arms the timer outside the request that triggered a reload", () => {
    const auto = makeTask({ nextRunAt: new Date(Date.now() + 30_000).toISOString() });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    const scheduler = new Scheduler(createMockExecutor(), { workDir: tmpDir });

    // The context a timer captures is the one active when it is created.
    const originalSetTimeout = globalThis.setTimeout;
    const armedIn: unknown[] = [];
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      armedIn.push(getRequestContext());
      return originalSetTimeout(fn, delay);
    }) as typeof globalThis.setTimeout;

    try {
      scheduler.start();
      runWithRequestContext({ identity: { id: "usr_caller" } as never, workspaceId: WS }, () =>
        scheduler.reload(),
      );
      expect(armedIn.length).toBeGreaterThanOrEqual(2);
      expect(armedIn.every((ctx) => ctx === undefined)).toBe(true);
    } finally {
      scheduler.stop();
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("arms timer to 60s when next-due > 60s", () => {
    const nextRunAt = new Date(Date.now() + 120_000).toISOString(); // 2 minutes out

    const auto = makeTask({ nextRunAt });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });

    const originalSetTimeout = globalThis.setTimeout;
    let capturedDelay = -1;
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      capturedDelay = delay ?? 0;
      return originalSetTimeout(fn, delay);
    }) as typeof globalThis.setTimeout;

    try {
      scheduler.start();
      expect(capturedDelay).toBe(60_000);
    } finally {
      scheduler.stop();
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("arms timer to 60s when no tasks are due", () => {
    // No tasks at all
    const defs = new Map<string, Task>();
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });

    const originalSetTimeout = globalThis.setTimeout;
    let capturedDelay = -1;
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      capturedDelay = delay ?? 0;
      return originalSetTimeout(fn, delay);
    }) as typeof globalThis.setTimeout;

    try {
      scheduler.start();
      expect(capturedDelay).toBe(60_000);
    } finally {
      scheduler.stop();
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — interval scheduling
// ---------------------------------------------------------------------------

describe("Scheduler — interval scheduling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("interval fires after intervalMs", async () => {
    const now = Date.now();
    const auto = makeTask({
      schedule: { type: "interval", intervalMs: 60_000 },
      lastRunAt: new Date(now - 60_001).toISOString(), // Just past due
      nextRunAt: new Date(now - 1).toISOString(), // Due now
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });

    scheduler.start();
    // Manually trigger the timer callback
    await scheduler.onTimer();
    scheduler.stop();

    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("interval with no lastRunAt fires immediately", async () => {
    const auto = makeTask({
      schedule: { type: "interval", intervalMs: 60_000 },
      lastRunAt: undefined,
      nextRunAt: undefined, // Will be computed as "now" on start
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });

    scheduler.start();
    // After start(), nextRunAt should be set to approximately now
    const loaded = defOf(scheduler, auto.id)!;
    const nextMs = new Date(loaded.nextRunAt!).getTime();
    expect(nextMs).toBeLessThanOrEqual(Date.now() + 100);

    // Timer callback should fire it
    await scheduler.onTimer();
    scheduler.stop();

    expect(executor).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — cron scheduling
// ---------------------------------------------------------------------------

describe("Scheduler — cron scheduling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cron 0 8 * * * with timezone Pacific/Honolulu fires at correct UTC time", () => {
    const auto = makeTask({
      schedule: {
        type: "cron",
        expression: "0 8 * * *",
        timezone: "Pacific/Honolulu",
      },
    });

    const now = Date.now();
    const next = computeNextRunAt(auto, now, "UTC");
    expect(next).not.toBeNull();

    // The next run should be at 8:00 AM HST
    const nextDate = new Date(next!);
    const hstHour = Number(
      nextDate.toLocaleString("en-US", {
        timeZone: "Pacific/Honolulu",
        hour: "numeric",
        hour12: false,
      }),
    );
    expect(hstHour).toBe(8);

    const hstMinute = Number(
      nextDate.toLocaleString("en-US", {
        timeZone: "Pacific/Honolulu",
        minute: "numeric",
      }),
    );
    expect(hstMinute).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — a cron schedule with no next run
// ---------------------------------------------------------------------------

describe("Scheduler — cron schedule with no next run", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const FEB_31 = { type: "cron" as const, expression: "0 9 31 2 *" };
  const PAST_YEAR = { type: "cron" as const, expression: "0 0 9 1 1 * 2020" };

  it("isDue is false for a cron schedule with no nextRunAt", () => {
    const auto = makeTask({ schedule: FEB_31, nextRunAt: undefined });
    expect(isDue(auto, Date.now())).toBe(false);
  });

  it("never runs a stored task with no nextRunAt", async () => {
    const auto = makeTask({ schedule: FEB_31, nextRunAt: undefined });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    const originalSetTimeout = globalThis.setTimeout;
    let capturedDelay = -1;
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      capturedDelay = delay ?? 0;
      return originalSetTimeout(fn, delay);
    }) as typeof globalThis.setTimeout;

    try {
      scheduler.start();
      expect(capturedDelay).toBe(60_000);
      await scheduler.onTimer();
      await scheduler.onTimer();
      expect(executor).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("clears a stale past nextRunAt on start and never runs it", async () => {
    const auto = makeTask({
      schedule: FEB_31,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();
    scheduler.stop();

    expect(executor).not.toHaveBeenCalled();
    expect(defOf(scheduler, auto.id)?.nextRunAt).toBeUndefined();
    expect(loadDefs(tmpDir).get(auto.id)?.nextRunAt).toBeUndefined();
  });

  it("runs a cron whose last date has passed once, then never again", async () => {
    const auto = makeTask({
      schedule: { type: "cron", expression: "* * * * *" },
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    // The schedule runs out of dates between reconciles: the stored file
    // now has a year that has passed while the timer still holds a due run.
    const stored = loadDefs(tmpDir).get(auto.id)!;
    saveTask(tmpDir, WS, OWNER, { ...stored, schedule: PAST_YEAR });
    defOf(scheduler, auto.id)!.nextRunAt = new Date(Date.now() - 1000).toISOString();

    await scheduler.onTimer();
    await scheduler.onTimer();
    scheduler.stop();

    expect(executor).toHaveBeenCalledTimes(1);
    expect(defOf(scheduler, auto.id)?.nextRunAt).toBeUndefined();
  });

  it("clears nextRunAt on a skipped run whose cron has no next run", async () => {
    const auto = makeTask({
      schedule: { type: "cron", expression: "* * * * *" },
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    const { executor, resolve } = createBlockingExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));

    // While the first run is still active, the schedule runs out of dates
    // and the timer still holds a due run, so the next tick skips it.
    const stored = loadDefs(tmpDir).get(auto.id)!;
    saveTask(tmpDir, WS, OWNER, { ...stored, schedule: PAST_YEAR });
    defOf(scheduler, auto.id)!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await scheduler.onTimer();

    expect(executor).toHaveBeenCalledTimes(1);
    expect(defOf(scheduler, auto.id)?.nextRunAt).toBeUndefined();

    resolve(makeSuccessRun(auto.id));
    scheduler.stop();
  });

  it("still runs a normal cron and advances nextRunAt", async () => {
    const auto = makeTask({
      schedule: { type: "cron", expression: "* * * * *" },
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();
    await scheduler.onTimer();
    scheduler.stop();

    expect(executor).toHaveBeenCalledTimes(1);
    const next = defOf(scheduler, auto.id)?.nextRunAt;
    expect(next).toBeDefined();
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — concurrency
// ---------------------------------------------------------------------------

describe("Scheduler — concurrency", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips second run while first is active (per-task guard)", async () => {
    const auto = makeTask({
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const { executor, resolve } = createBlockingExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    // Fire onTimer (don't await — executor blocks forever)
    scheduler.onTimer();
    // Yield to let microtasks settle (dispatch is sync, executor is async)
    await new Promise((r) => setTimeout(r, 50));

    // The executor is running (blocking). Now trigger again.
    scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));

    // Executor should only have been called once
    expect(executor).toHaveBeenCalledTimes(1);

    // Resolve the blocking executor
    resolve(makeSuccessRun(auto.id));
    scheduler.stop();
  });

  /** Three tasks due at staggered past moments, each run held open until resolved. */
  function seedThreeDue(workDir: string, schedule?: Task["schedule"]): Task[] {
    const autos = [3000, 2000, 1000].map((ago, i) =>
      makeTask({
        id: `auto-${i + 1}`,
        name: `Auto ${i + 1}`,
        ...(schedule ? { schedule } : {}),
        nextRunAt: new Date(Date.now() - ago).toISOString(),
      }),
    );
    // Seed newest first, so load order is the reverse of due order.
    seedDefs(workDir, new Map([...autos].reverse().map((a) => [a.id, a])));
    return autos;
  }

  function createHeldExecutor(): {
    executor: Executor;
    callLog: string[];
    release: () => void;
  } {
    const pending: Array<(run: TaskRun) => void> = [];
    const callLog: string[] = [];
    const executor: Executor = mock(async (auto: Task, _signal: AbortSignal) => {
      callLog.push(auto.id);
      return new Promise<{ run: TaskRun; result: null }>((resolve) => {
        pending.push((run) => resolve(execOk(run)));
      });
    }) as Executor;
    const release = () => {
      for (const r of pending.splice(0)) r(makeSuccessRun("any"));
    };
    return { executor, callLog, release };
  }

  it("test_global_limit_reached_defers_the_run_instead_of_skipping_it", async () => {
    const [, , auto3] = seedThreeDue(tmpDir);
    const { executor, callLog, release } = createHeldExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 2 }),
    });
    scheduler.start();

    const tick = scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));

    expect(callLog).toEqual(["auto-1", "auto-2"]);
    expect(scheduler.getActiveRunIds().length).toBe(2);
    // Deferred: no run recorded, and still due at the moment it was scheduled for.
    expect(readRuns(tmpDir, WS, OWNER, auto3.id)).toEqual([]);
    expect(defOf(scheduler, auto3.id)?.nextRunAt).toBe(auto3.nextRunAt);
    expect(loadDefs(tmpDir).get(auto3.id)?.nextRunAt).toBe(auto3.nextRunAt);

    // The slots free; the next tick runs the deferred task.
    release();
    await tick;
    // The settled tick re-arms at zero delay for the run it deferred.
    await new Promise((r) => setTimeout(r, 50));
    expect(callLog).toEqual(["auto-1", "auto-2", "auto-3"]);

    release();
    scheduler.stop();
  });

  it("test_global_limit_deferred_one_shot_cron_survives_reload_and_runs", async () => {
    // A cron with one date, already passed: its only run is the one deferred.
    const at = new Date(Date.now() - 60_000);
    at.setUTCSeconds(0, 0);
    const oneShot = {
      type: "cron" as const,
      expression: `0 ${at.getUTCMinutes()} ${at.getUTCHours()} ${at.getUTCDate()} ${at.getUTCMonth() + 1} * ${at.getUTCFullYear()}`,
      timezone: "UTC",
    };
    // Two runs due before it hold both slots.
    const busy = ["busy-1", "busy-2"].map((id, i) =>
      makeTask({ id, nextRunAt: new Date(at.getTime() - (2 - i) * 60_000).toISOString() }),
    );
    const send = makeTask({ id: "send-01", schedule: oneShot, nextRunAt: at.toISOString() });
    seedDefs(tmpDir, new Map([...busy, send].map((a) => [a.id, a])));

    const { executor, callLog, release } = createHeldExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 2 }),
    });
    scheduler.start();
    const tick = scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    // send-01 is deferred behind the two older due runs.
    expect(callLog).toEqual(busy.map((a) => a.id));

    // Any task mutation reloads; the deferred one-shot must keep its run.
    scheduler.reload();
    expect(defOf(scheduler, send.id)?.nextRunAt).toBe(at.toISOString());

    release();
    await tick;
    // The settled tick re-arms at zero delay for the run it deferred.
    await new Promise((r) => setTimeout(r, 50));
    expect(callLog).toContain("send-01");
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(readRuns(tmpDir, WS, OWNER, send.id).map((r) => r.status)).toEqual(["success"]);
    expect(defOf(scheduler, send.id)?.nextRunAt).toBeUndefined();

    scheduler.stop();
  });

  it("test_global_limit_reached_arms_the_heartbeat_not_a_zero_delay_tick", async () => {
    seedThreeDue(tmpDir);
    const { executor, release } = createHeldExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 2 }),
    });
    scheduler.start();
    const tick = scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));

    const originalSetTimeout = globalThis.setTimeout;
    let capturedDelay = -1;
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      capturedDelay = delay ?? 0;
      return originalSetTimeout(fn, delay);
    }) as typeof globalThis.setTimeout;
    try {
      // A reload mid-batch re-arms while auto-3 is due and both slots are held.
      scheduler.reload();
      expect(capturedDelay).toBe(60_000);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    release();
    await tick;
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — backoff
// ---------------------------------------------------------------------------

describe("Scheduler — backoff", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a membership-revoked run as skipped, not a failure (self-heals)", async () => {
    // The runtime denies a task whose owner was removed from its
    // provenance workspace by throwing an error with this stable code. The
    // scheduler must classify it as SKIPPED, so it does NOT increment
    // consecutiveErrors or trip the auto-disable — the task resumes the
    // moment the owner is re-added.
    const auto = makeTask({
      consecutiveErrors: 3,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const revoked = Object.assign(new Error("owner removed from workspace"), {
      code: "workspace_membership_revoked",
    });
    const scheduler = new Scheduler(createThrowingExecutor(revoked), { workDir: tmpDir });
    scheduler.start();
    const run = await scheduler.runNow(WS, OWNER, auto.id);
    scheduler.stop();

    expect(run?.status).toBe("skipped");
    const updated = defOf(scheduler, auto.id)!;
    // consecutiveErrors unchanged (not bumped to 4), task still enabled.
    expect(updated.consecutiveErrors).toBe(3);
    expect(updated.enabled).toBe(true);
  });

  it("records a run refused for unavailable declared tools as a failure", async () => {
    // Unlike a revoked membership, a missing connector is the task's own
    // problem to surface: it counts toward the streak, so a connector that
    // stays gone backs the task off and disables it.
    const auto = makeTask({
      consecutiveErrors: 3,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const refused = Object.assign(
      new Error("Declared tool unavailable: crm__search. The run did not start."),
      { code: "declared_tools_unavailable" },
    );
    const scheduler = new Scheduler(createThrowingExecutor(refused), { workDir: tmpDir });
    scheduler.start();
    const run = await scheduler.runNow(WS, OWNER, auto.id);
    scheduler.stop();

    expect(run?.status).toBe("failure");
    expect(run?.error).toContain("crm__search");
    expect(run?.transient).toBe(false);
    expect(defOf(scheduler, auto.id)!.consecutiveErrors).toBe(4);
  });

  it("after 1 failure, next run delayed by 30s", async () => {
    const auto = makeTask({
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const failRun = makeFailureRun(auto.id);
    const executor = createMockExecutor(failRun);
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(1);
    const nextRunMs = new Date(updated.nextRunAt!).getTime();
    const expectedMin = Date.now() + 30_000 - 2000; // 2s tolerance
    expect(nextRunMs).toBeGreaterThanOrEqual(expectedMin);

    scheduler.stop();
  });

  it("after 3 failures, next run delayed by 5m", async () => {
    const auto = makeTask({
      consecutiveErrors: 2, // Already has 2 errors
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const failRun = makeFailureRun(auto.id);
    const executor = createMockExecutor(failRun);
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(3);
    const nextRunMs = new Date(updated.nextRunAt!).getTime();
    const expectedMin = Date.now() + 300_000 - 2000;
    expect(nextRunMs).toBeGreaterThanOrEqual(expectedMin);

    scheduler.stop();
  });

  it("backoff resets to 0 on successful run", async () => {
    const auto = makeTask({
      consecutiveErrors: 3,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const successRun = makeSuccessRun(auto.id);
    const executor = createMockExecutor(successRun);
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(0);

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — reload
// ---------------------------------------------------------------------------

describe("Scheduler — reload", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reload() picks up new definitions and re-arms timer", () => {
    // Start with empty definitions
    seedDefs(tmpDir, new Map());

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    expect(scheduler.getDefinitions().size).toBe(0);

    // Add a new task to the store externally
    const auto = makeTask({ id: "new-auto" });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    // Reload should pick it up
    scheduler.reload();
    expect(scheduler.getDefinitions().size).toBe(1);
    expect(defOf(scheduler, "new-auto") !== undefined).toBe(true);

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — runNow
// ---------------------------------------------------------------------------

describe("Scheduler — onRunRecorded", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedOne(): Task {
    const auto = makeTask({ nextRunAt: new Date(Date.now() - 1000).toISOString() });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    return auto;
  }

  it("reports a completed run's owner", async () => {
    const auto = seedOne();
    const recorded: string[] = [];
    const scheduler = new Scheduler(createMockExecutor(), {
      workDir: tmpDir,
      onRunRecorded: (owner) => recorded.push(owner),
    });
    scheduler.start();

    await scheduler.runNow(WS, OWNER, auto.id);

    expect(recorded).toEqual([OWNER]);
    scheduler.stop();
  });

  it("reports a failed run's owner", async () => {
    const auto = seedOne();
    const recorded: string[] = [];
    const scheduler = new Scheduler(createThrowingExecutor(new Error("boom")), {
      workDir: tmpDir,
      onRunRecorded: (owner) => recorded.push(owner),
    });
    scheduler.start();

    const run = await scheduler.runNow(WS, OWNER, auto.id);

    expect(run!.status).not.toBe("success");
    expect(recorded).toEqual([OWNER]);
    scheduler.stop();
  });

  it("reports a skipped run's owner", async () => {
    const auto = seedOne();
    const recorded: string[] = [];
    const { executor, resolve } = createBlockingExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      onRunRecorded: (owner) => recorded.push(owner),
    });
    scheduler.start();
    scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));

    // The armed timer may also record its own skip while the first run
    // blocks, so count only what this call records.
    const before = recorded.length;
    const run = await scheduler.runNow(WS, OWNER, auto.id);

    expect(run!.status).toBe("skipped");
    expect(recorded.slice(before)).toEqual([OWNER]);
    resolve(makeSuccessRun(auto.id));
    scheduler.stop();
  });
});

describe("Scheduler — runNow", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runNow() bypasses schedule and backoff", async () => {
    const futureTime = new Date(Date.now() + 999_999_999).toISOString();
    const auto = makeTask({
      consecutiveErrors: 5, // In heavy backoff
      nextRunAt: futureTime,
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    const run = await scheduler.runNow(WS, OWNER, auto.id);

    expect(run).not.toBeNull();
    expect(run!.status).toBe("success");
    expect(executor).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("runNow() runs a disabled task that an event would skip", async () => {
    // One rule for `enabled`: it gates unattended triggers, and Run now is
    // the attended one. Both triggers against the same disabled task.
    const auto = makeTask({ enabled: false });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    const fromEvent = await scheduler.runFromEvent(WS, OWNER, auto.id, { preamble: "x" });
    expect(fromEvent).toEqual({ skipped: "the task is disabled" });
    expect(executor).not.toHaveBeenCalled();

    const run = await scheduler.runNow(WS, OWNER, auto.id);
    expect(run!.status).toBe("success");
    expect(executor).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("runNow() returns null for unknown task", async () => {
    seedDefs(tmpDir, new Map());

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    const run = await scheduler.runNow(WS, OWNER, "nonexistent");
    expect(run).toBeNull();

    scheduler.stop();
  });

  it("runNow() skips if task is already running", async () => {
    const auto = makeTask({
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const { executor, resolve } = createBlockingExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    // Start a run via onTimer (don't await — executor blocks)
    scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(scheduler.getActiveRunIds()).toContain(`${WS}/${OWNER}/${auto.id}`);

    // runNow should skip
    const run = await scheduler.runNow(WS, OWNER, auto.id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("skipped");

    // Clean up
    resolve(makeSuccessRun(auto.id));
    scheduler.stop();
  });

  it("failure record carries real dispatch time, not the catch-clause instant", async () => {
    // Regression for the production diagnostic gap: when the executor
    // hung for 300s, the synthesized failure record had
    // startedAt == completedAt to the millisecond — operators couldn't
    // tell a 5-minute hang from a 5-millisecond setup crash.
    const auto = makeTask({
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const SLEEP_MS = 50;
    const executor: Executor = mock(async (_auto: Task, _signal: AbortSignal): Promise<never> => {
      await new Promise((r) => setTimeout(r, SLEEP_MS));
      throw new Error("Task slow timed out after 1s");
    });
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    const run = await scheduler.runNow(WS, OWNER, auto.id);

    expect(run).not.toBeNull();
    expect(run!.status).toBe("timeout");
    const elapsedMs = new Date(run!.completedAt!).getTime() - new Date(run!.startedAt).getTime();
    expect(elapsedMs).toBeGreaterThanOrEqual(SLEEP_MS - 5); // tolerance for clock granularity

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — stop
// ---------------------------------------------------------------------------

describe("Scheduler — stop", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stop() aborts active runs", async () => {
    const auto = makeTask({
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    let receivedSignal: AbortSignal | null = null;
    const executor: Executor = mock(async (_auto: Task, signal: AbortSignal) => {
      receivedSignal = signal;
      // Block forever
      return new Promise<never>(() => {});
    });

    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    // Dispatch a run (don't await — executor blocks)
    scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    expect(scheduler.getActiveRunIds().length).toBe(1);

    // Stop should abort it
    scheduler.stop();
    expect(receivedSignal).not.toBeNull();
    expect(receivedSignal!.aborted).toBe(true);
    expect(scheduler.getActiveRunIds().length).toBe(0);
    expect(scheduler.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — a scheduled run the process stops under
// ---------------------------------------------------------------------------

describe("Scheduler — interrupted scheduled runs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("test_scheduledRun_inFlight_marksTaskUntilRecorded", async () => {
    const auto = makeTask({ nextRunAt: new Date(Date.now() - 1000).toISOString() });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    const { executor, resolve } = createBlockingExecutor();

    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));

    const marked = loadDefs(tmpDir).get(auto.id)!.scheduledRunInFlight;
    expect(marked?.runId).toBe(scheduler.queueView(WS, OWNER)[0]!.runId!);

    resolve(makeSuccessRun(auto.id));
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();

    expect(loadDefs(tmpDir).get(auto.id)!.scheduledRunInFlight).toBeUndefined();
  });

  it("test_scheduledRun_processStopsMidRun_nextProcessRecordsItAndDoesNotRunItAgain", async () => {
    const auto = makeTask({
      schedule: { type: "interval", intervalMs: 3_600_000 },
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    // The first process starts the run (start() arms its timer at zero delay)
    // and dies under it: no stop(), no record.
    const first = new Scheduler(createBlockingExecutor().executor, { workDir: tmpDir });
    first.start();
    await new Promise((r) => setTimeout(r, 20));
    const runId = loadDefs(tmpDir).get(auto.id)!.scheduledRunInFlight!.runId;
    expect(readRuns(tmpDir, WS, OWNER, auto.id)).toHaveLength(0);

    const executor = createMockExecutor();
    const second = new Scheduler(executor, { workDir: tmpDir });
    second.start();
    await second.onTimer();
    second.stop();

    expect(executor).not.toHaveBeenCalled();
    const runs = readRuns(tmpDir, WS, OWNER, auto.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
    expect(runs[0]!.status).toBe("failure");
    expect(runs[0]!.trigger).toBe("scheduled");
    expect(runs[0]!.error).toBe(INTERRUPTED_RUN_ERROR);
    const stored = loadDefs(tmpDir).get(auto.id)!;
    expect(stored.scheduledRunInFlight).toBeUndefined();
    expect(new Date(stored.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(stored.runCount).toBe(1);
  });

  it("test_onceRun_interrupted_retiredAsRanNotMissed", async () => {
    const at = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const auto = makeTask({
      schedule: { type: "once", at },
      nextRunAt: at,
      scheduledRunInFlight: { runId: "run_abc123abc123", startedAt: at, onceAt: at },
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();
    scheduler.stop();

    expect(executor).not.toHaveBeenCalled();
    const stored = loadDefs(tmpDir).get(auto.id)!;
    expect(stored.onceDone?.outcome).toBe("ran");
    expect(stored.enabled).toBe(false);
    const runs = readRuns(tmpDir, WS, OWNER, auto.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.error).toBe(INTERRUPTED_RUN_ERROR);
  });

  it("test_scheduledRun_recordedOnShutdownAbort_notSettledAgainAtStart", async () => {
    const auto = makeTask({ nextRunAt: new Date(Date.now() - 1000).toISOString() });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    const executor: Executor = mock(
      async (_auto: Task, signal: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );

    const first = new Scheduler(executor, { workDir: tmpDir });
    first.start();
    await new Promise((r) => setTimeout(r, 20));
    first.stop();
    await new Promise((r) => setTimeout(r, 20));

    const second = new Scheduler(createMockExecutor(), { workDir: tmpDir });
    second.start();
    second.stop();

    const runs = readRuns(tmpDir, WS, OWNER, auto.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("cancelled");
    expect(loadDefs(tmpDir).get(auto.id)!.scheduledRunInFlight).toBeUndefined();
  });

  it("test_restartSameScheduler_runStillRecording_notSettledAsInterrupted", async () => {
    const auto = makeTask({ nextRunAt: new Date(Date.now() - 1000).toISOString() });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    // An aborted run that takes a while to wind down and record itself.
    const executor: Executor = mock(
      async (_auto: Task, signal: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () =>
            setTimeout(() => reject(new DOMException("aborted", "AbortError")), 30),
          );
        }),
    );

    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
    scheduler.start();
    await new Promise((r) => setTimeout(r, 60));
    scheduler.stop();

    // The run records itself once; the restart never settles it as interrupted.
    const runs = readRuns(tmpDir, WS, OWNER, auto.id);
    expect(runs.filter((r) => r.status === "cancelled")).toHaveLength(1);
    expect(runs.some((r) => r.error === INTERRUPTED_RUN_ERROR)).toBe(false);
  });

  it("test_interruptedRun_recordAppendedBeforeTaskSaved_notRecordedTwice", async () => {
    const auto = makeTask({
      schedule: { type: "interval", intervalMs: 3_600_000 },
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
      scheduledRunInFlight: {
        runId: "run_0123456789ab",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    // The process stopped after appending the run's record, before saving the task.
    appendRun(tmpDir, WS, OWNER, auto.id, {
      ...makeSuccessRun(auto.id),
      id: "run_0123456789ab",
      trigger: "scheduled",
    });

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();
    scheduler.stop();

    expect(executor).not.toHaveBeenCalled();
    const runs = readRuns(tmpDir, WS, OWNER, auto.id);
    expect(runs.map((r) => [r.id, r.status])).toEqual([["run_0123456789ab", "success"]]);
    const stored = loadDefs(tmpDir).get(auto.id)!;
    expect(stored.scheduledRunInFlight).toBeUndefined();
    expect(stored.runCount).toBe(1);
    expect(new Date(stored.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("test_interruptedRun_runIndexUnreadable_startStillSucceeds", () => {
    const auto = makeTask({
      scheduledRunInFlight: {
        runId: "run_0123456789ab",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    // A directory where the run index belongs: reading it throws (EISDIR).
    mkdirSync(taskRunIndexPath(tmpDir, WS, OWNER, auto.id), { recursive: true });

    const scheduler = new Scheduler(createMockExecutor(), { workDir: tmpDir });
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it("test_anotherRunRecorded_whileScheduledRunInFlight_markKept", () => {
    const inFlight = { runId: "run_0123456789ab", startedAt: new Date().toISOString() };
    const auto = makeTask({ scheduledRunInFlight: inFlight });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    // A record for a different run of the same task (a skip, a batch item)
    // lands while the scheduled run is still going.
    const scheduler = new Scheduler(createMockExecutor(), { workDir: tmpDir });
    scheduler.updateAfterRun(auto, { ...makeSuccessRun(auto.id), id: "run_ffffffffffff" });

    expect(loadDefs(tmpDir).get(auto.id)!.scheduledRunInFlight).toEqual(inFlight);
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — updateAfterRun
// ---------------------------------------------------------------------------

describe("Scheduler — updateAfterRun", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("increments runCount on each run", async () => {
    const auto = makeTask({
      runCount: 5,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.runCount).toBe(6);

    scheduler.stop();
  });

  it("updates lastRunAt and lastRunStatus", async () => {
    const auto = makeTask({
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.lastRunAt).toBeDefined();
    expect(updated.lastRunStatus).toBe("success");

    scheduler.stop();
  });

  it("persists updated definitions to disk", async () => {
    const auto = makeTask({
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();
    scheduler.stop();

    // Read from disk to verify persistence
    const persisted = loadDefs(tmpDir);
    const updated = persisted.get(auto.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastRunStatus).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// Tests: Backoff respects natural interval
// ---------------------------------------------------------------------------

describe("Scheduler — backoff respects natural interval", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("30-min interval task with 1 error delays by 30min, not 30s", async () => {
    const auto = makeTask({
      schedule: { type: "interval", intervalMs: 1_800_000 }, // 30 min
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
      lastRunAt: new Date(Date.now() - 1_800_001).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const failRun = makeFailureRun(auto.id);
    const executor = createMockExecutor(failRun);
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(1);
    const nextRunMs = new Date(updated.nextRunAt!).getTime();
    // Should be at least 30 min from now (not 30s)
    expect(nextRunMs - Date.now()).toBeGreaterThan(1_790_000);
    scheduler.stop();
  });

  it("1-min interval task with 5 errors delays by 1hr (backoff > interval)", async () => {
    const auto = makeTask({
      schedule: { type: "interval", intervalMs: 60_000 }, // 1 min
      consecutiveErrors: 4,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
      lastRunAt: new Date(Date.now() - 60_001).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const failRun = makeFailureRun(auto.id);
    const executor = createMockExecutor(failRun);
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(5);
    const nextRunMs = new Date(updated.nextRunAt!).getTime();
    // Should be at least 1hr (3_600_000ms) from now
    expect(nextRunMs - Date.now()).toBeGreaterThan(3_590_000);
    scheduler.stop();
  });

  it("success resets to natural interval regardless of previous errors", async () => {
    const auto = makeTask({
      schedule: { type: "interval", intervalMs: 1_800_000 },
      consecutiveErrors: 5,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
      lastRunAt: new Date(Date.now() - 1_800_001).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor(); // success
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(0);
    scheduler.stop();
  });

  it("cron task with 1 error delays to next cron occurrence, not 30s", async () => {
    // Pin the clock to noon HST so the next 8am (daily) is ~20h out —
    // deterministically far beyond the 30s backoff. With the real clock this
    // test flaked whenever CI ran in the 07:59 HST minute: there the natural
    // next 8am is <60s away, so `max(backoff, natural)` is <60s and the
    // fixed-threshold assertion below fails even though backoff didn't win.
    const FIXED_NOW = Date.parse("2026-07-15T22:00:00.000Z"); // 12:00 Pacific/Honolulu
    const nowSpy = spyOn(Date, "now").mockReturnValue(FIXED_NOW);
    try {
      const auto = makeTask({
        schedule: { type: "cron", expression: "0 8 * * *", timezone: "Pacific/Honolulu" },
        nextRunAt: new Date(Date.now() - 1000).toISOString(),
      });
      const defs = new Map<string, Task>();
      defs.set(auto.id, auto);
      seedDefs(tmpDir, defs);

      const failRun = makeFailureRun(auto.id);
      const executor = createMockExecutor(failRun);
      const scheduler = new Scheduler(executor, {
        workDir: tmpDir,
        defaultTimezone: "Pacific/Honolulu",
      });
      scheduler.start();
      await scheduler.onTimer();

      const updated = defOf(scheduler, auto.id)!;
      expect(updated.consecutiveErrors).toBe(1);
      const nextRunMs = new Date(updated.nextRunAt!).getTime();
      // Backoff (30s) must NOT win — nextRunAt is exactly the natural next
      // 8am HST (2026-07-16 08:00 HST = 18:00Z). Asserting the exact instant
      // (now that the clock is pinned) also guards the cron math itself —
      // timezone + occurrence — not just "the delay is more than 30s".
      expect(nextRunMs).toBe(Date.parse("2026-07-16T18:00:00.000Z"));
      scheduler.stop();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Skipped runs advance nextRunAt
// ---------------------------------------------------------------------------

describe("Scheduler — skipped runs advance nextRunAt", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a skip refused because the workspace is gone drops the task instead of re-arming at zero delay", async () => {
    // `recordSkipped` writes before it advances `nextRunAt`, so a refused
    // write leaves the task due. Kept, the timer would re-arm at zero
    // delay and sweep it again immediately, forever.
    const defs = new Map<string, Task>();
    defs.set(
      "auto-ghost",
      makeTask({
        id: "auto-ghost",
        nextRunAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    seedDefs(tmpDir, defs);

    // Its first run is held open, so the next tick finds it still active and
    // takes the `recordSkipped` path.
    const { executor } = createBlockingExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));
    rmSync(join(tmpDir, "workspaces", WS), { recursive: true, force: true });
    defOf(scheduler, "auto-ghost")!.nextRunAt = new Date(Date.now() - 1000).toISOString();

    await scheduler.onTimer();

    expect(defOf(scheduler, "auto-ghost")).toBeUndefined();
    expect(existsSync(join(tmpDir, "workspaces", WS))).toBe(false);
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: Auto-disable after consecutive errors
// ---------------------------------------------------------------------------

describe("Scheduler — auto-disable", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("9 consecutive errors does not auto-disable", async () => {
    const auto = makeTask({
      consecutiveErrors: 8,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor(makeFailureRun(auto.id));
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(9);
    expect(updated.enabled).toBe(true);
    expect(updated.disabledAt).toBeUndefined();
    scheduler.stop();
  });

  it("10 consecutive errors triggers auto-disable", async () => {
    const auto = makeTask({
      consecutiveErrors: 9,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor(makeFailureRun(auto.id, "HTTP 401 Unauthorized"));
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(10);
    expect(updated.enabled).toBe(false);
    expect(updated.disabledAt).toBeDefined();
    expect(updated.disabledReason).toContain("10 consecutive failures");
    expect(updated.disabledReason).toContain("HTTP 401");
    scheduler.stop();
  });

  it("auto-disabled task does not fire on next timer tick", async () => {
    const auto = makeTask({
      enabled: false,
      disabledAt: new Date().toISOString(),
      disabledReason: "Auto-disabled after 10 consecutive failures",
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    expect(executor).not.toHaveBeenCalled();
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: Cancel
// ---------------------------------------------------------------------------

describe("Scheduler — cancelRun", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cancelRun on active task returns true and aborts", async () => {
    const auto = makeTask({
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    let receivedSignal: AbortSignal | null = null;
    const executor: Executor = mock(async (_auto: Task, signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<never>(() => {}); // block forever
    });

    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    scheduler.onTimer(); // don't await — executor blocks
    await new Promise((r) => setTimeout(r, 50));

    expect(scheduler.getActiveRunIds()).toContain(`${WS}/${OWNER}/${auto.id}`);
    const result = scheduler.cancelRun(WS, OWNER, auto.id);
    expect(result).toBe(true);
    expect(receivedSignal!.aborted).toBe(true);

    scheduler.stop();
  });

  it("a scheduled run has its id from dispatch, and is cancelled by it", async () => {
    const auto = makeTask({
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    let receivedSignal: AbortSignal | null = null;
    let receivedRunId: string | undefined;
    const executor: Executor = mock(
      async (
        _auto: Task,
        signal: AbortSignal,
        _trigger: unknown,
        _input: unknown,
        _lease: unknown,
        runId?: string,
      ) => {
        receivedSignal = signal;
        receivedRunId = runId;
        return new Promise<never>(() => {});
      },
    );

    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));

    const [entry] = scheduler.queueView(WS, OWNER);
    expect(entry?.runId).toMatch(/^run_[a-f0-9]{12}$/);
    expect(receivedRunId).toBe(entry?.runId);
    expect(scheduler.cancelRunById(WS, "someone-else", entry!.runId!)).toBe(false);
    expect(scheduler.cancelRunById(WS, OWNER, entry!.runId!)).toBe(true);
    expect(receivedSignal!.aborted).toBe(true);

    scheduler.stop();
  });

  it("a scheduled run whose executor throws is recorded under the id it ran with", async () => {
    const auto = makeTask({ nextRunAt: new Date(Date.now() - 1000).toISOString() });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    let fail!: (err: Error) => void;
    const executor: Executor = mock(
      () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    const done = scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));

    const [entry] = scheduler.queueView(WS, OWNER);
    expect(entry?.runId).toMatch(/^run_[a-f0-9]{12}$/);
    fail(new Error("upstream broke"));
    await done;

    const [recorded] = readRuns(tmpDir, WS, OWNER, auto.id);
    expect(recorded?.status).toBe("failure");
    expect(recorded?.id).toBe(entry?.runId);
    scheduler.stop();
  });

  it("cancelRun on idle task returns false", () => {
    const auto = makeTask({
      nextRunAt: new Date(Date.now() + 999_999).toISOString(), // not due
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    const result = scheduler.cancelRun(WS, OWNER, auto.id);
    expect(result).toBe(false);
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: Cumulative token tracking
// ---------------------------------------------------------------------------

describe("Scheduler — cumulative token tracking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("increments cumulative tokens after each run", async () => {
    const auto = makeTask({
      cumulativeInputTokens: 500,
      cumulativeOutputTokens: 100,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const run = makeSuccessRun(auto.id);
    run.inputTokens = 1000;
    run.outputTokens = 200;
    const executor = createMockExecutor(run);
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.cumulativeInputTokens).toBe(1500);
    expect(updated.cumulativeOutputTokens).toBe(300);
    scheduler.stop();
  });

  it("auto-disables when token budget exceeded", async () => {
    const auto = makeTask({
      cumulativeInputTokens: 4500,
      cumulativeOutputTokens: 0,
      tokenBudget: { maxInputTokens: 5000 },
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const run = makeSuccessRun(auto.id);
    run.inputTokens = 1000; // 4500 + 1000 = 5500 > 5000
    const executor = createMockExecutor(run);
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.enabled).toBe(false);
    expect(updated.disabledReason).toContain("Token budget exceeded");
    scheduler.stop();
  });

  it("resets cumulative counters when budgetResetAt is in the past", async () => {
    const auto = makeTask({
      cumulativeInputTokens: 50_000,
      cumulativeOutputTokens: 5_000,
      tokenBudget: { maxInputTokens: 100_000, period: "daily" },
      budgetResetAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const run = makeSuccessRun(auto.id);
    run.inputTokens = 1000;
    run.outputTokens = 200;
    const executor = createMockExecutor(run);
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    // Counters should be reset to just this run's tokens, not accumulated
    expect(updated.cumulativeInputTokens).toBe(1000);
    expect(updated.cumulativeOutputTokens).toBe(200);
    // budgetResetAt should be in the future (next day)
    expect(new Date(updated.budgetResetAt!).getTime()).toBeGreaterThan(Date.now());
    // Should still be enabled (1000 < 100000 budget)
    expect(updated.enabled).toBe(true);
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: computeBudgetResetAt
// ---------------------------------------------------------------------------

describe("computeBudgetResetAt", () => {
  it("daily with timezone returns midnight in that timezone", () => {
    // April 13 at 3pm HST = April 14 01:00 UTC
    // HST is UTC-10, so midnight April 14 HST = April 14 10:00 UTC
    const now = new Date("2026-04-14T01:00:00Z").getTime(); // 3pm HST April 13
    const result = computeBudgetResetAt("daily", now, "Pacific/Honolulu");
    expect(result).toBeDefined();
    const resetDate = new Date(result!);
    // Should be April 14 midnight HST = April 14 10:00 UTC
    expect(resetDate.getUTCHours()).toBe(10);
    expect(resetDate.getUTCDate()).toBe(14);
  });

  it("daily without timezone falls back to UTC", () => {
    const now = new Date("2026-04-13T15:30:00Z").getTime();
    const result = computeBudgetResetAt("daily", now);
    expect(result).toBe("2026-04-14T00:00:00.000Z");
  });

  it("monthly returns start of next month in timezone", () => {
    const now = new Date("2026-04-14T01:00:00Z").getTime(); // 3pm HST April 13
    const result = computeBudgetResetAt("monthly", now, "Pacific/Honolulu");
    expect(result).toBeDefined();
    const resetDate = new Date(result!);
    // May 1 midnight HST = May 1 10:00 UTC
    expect(resetDate.getUTCMonth()).toBe(4); // May = 4
    expect(resetDate.getUTCDate()).toBe(1);
    expect(resetDate.getUTCHours()).toBe(10);
  });

  it("undefined period returns undefined", () => {
    const result = computeBudgetResetAt(undefined, Date.now());
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-owner: the scheduler scans users/*/tasks and fires each
// task as its owner. Colliding kebab ids across owners must stay
// isolated (the whole point of composite ${ownerId}/${id} keys).
// ---------------------------------------------------------------------------

describe("Scheduler — multi-owner", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "scheduler-multiowner-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loads + fires tasks across owners; colliding ids stay isolated per owner", async () => {
    // Two owners in one workspace, SAME kebab id — only composite-key
    // isolation (${wsId}/${ownerId}/${id}) keeps them apart.
    const due = new Date(Date.now() - 1000).toISOString();
    const a = makeTask({ id: "daily-digest", ownerId: "usr_a", nextRunAt: due });
    const b = makeTask({ id: "daily-digest", ownerId: "usr_b", nextRunAt: due });
    seedDefs(root, new Map([[a.id, a]]), "usr_a");
    seedDefs(root, new Map([[b.id, b]]), "usr_b");

    const fired: Array<string | undefined> = [];
    const executor: Executor = mock(async (auto: Task) => {
      fired.push(auto.ownerId);
      return execOk(makeSuccessRun(auto.id));
    }) as Executor;

    const scheduler = new Scheduler(executor, { workDir: root });
    scheduler.start();
    await scheduler.onTimer();
    scheduler.stop();

    // Both owners' tasks fired, each carrying its own owner identity.
    expect(fired.sort()).toEqual(["usr_a", "usr_b"]);
    // Each run persisted to ITS OWN store — no cross-owner clobber.
    expect(loadDefs(root, "usr_a").get("daily-digest")!.runCount).toBe(1);
    expect(loadDefs(root, "usr_b").get("daily-digest")!.runCount).toBe(1);
  });

  it("runNow targets the owner-qualified task when ids collide", async () => {
    const a = makeTask({ id: "shared", ownerId: "usr_a", enabled: false });
    const b = makeTask({ id: "shared", ownerId: "usr_b", enabled: false });
    seedDefs(root, new Map([[a.id, a]]), "usr_a");
    seedDefs(root, new Map([[b.id, b]]), "usr_b");

    const fired: string[] = [];
    const executor: Executor = mock(async (auto: Task) => {
      fired.push(`${auto.ownerId}/${auto.id}`);
      return execOk(makeSuccessRun(auto.id));
    }) as Executor;

    const scheduler = new Scheduler(executor, { workDir: root });
    scheduler.start();
    const run = await scheduler.runNow(WS, "usr_b", "shared");
    scheduler.stop();

    expect(run).not.toBeNull();
    expect(fired).toEqual(["usr_b/shared"]); // only B's task ran
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — run trigger propagation
// ---------------------------------------------------------------------------

describe("Scheduler — run trigger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Executor that records the `trigger` it was dispatched with. */
  function recordingExecutor(triggers: string[]): Executor {
    return (async (auto: Task, _signal: AbortSignal, trigger: string) => {
      triggers.push(trigger);
      return execOk(makeSuccessRun(auto.id));
    }) as Executor;
  }

  it("dispatches scheduled (timer) runs with trigger 'scheduled'", async () => {
    const auto = makeTask({
      schedule: { type: "interval", intervalMs: 60_000 },
      lastRunAt: new Date(Date.now() - 60_001).toISOString(),
      nextRunAt: new Date(Date.now() - 1).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const triggers: string[] = [];
    const scheduler = new Scheduler(recordingExecutor(triggers), { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();
    scheduler.stop();

    expect(triggers).toEqual(["scheduled"]);
  });

  it("dispatches runNow (test button) runs with trigger 'manual'", async () => {
    const auto = makeTask();
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const triggers: string[] = [];
    const scheduler = new Scheduler(recordingExecutor(triggers), { workDir: tmpDir });
    scheduler.start();
    await scheduler.runNow(WS, OWNER, auto.id);
    scheduler.stop();

    expect(triggers).toEqual(["manual"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: an event schedule is never due from the timer
// ---------------------------------------------------------------------------

describe("Scheduler — event schedules", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function eventTask(overrides: Partial<Task> = {}): Task {
    return makeTask({
      id: "reply-triage",
      schedule: {
        type: "event",
        match: { source: "precision-outbound", name: "reply.*" },
      },
      ...overrides,
    });
  }

  it("has no next run", () => {
    expect(computeNextRunAt(eventTask(), Date.now())).toBeNull();
  });

  // An absent `nextRunAt` means "due immediately" for a clock schedule that has
  // not run yet, and an event schedule has none by construction. Without the
  // explicit test, the timer fires it on every tick.
  it("is never due, even with no nextRunAt", () => {
    expect(isDue(eventTask(), Date.now())).toBe(false);
    expect(isDue(eventTask({ nextRunAt: new Date(0).toISOString() }), Date.now())).toBe(false);
  });

  it("is not seeded with a nextRunAt at start", () => {
    seedDefs(workDir, new Map([["reply-triage", eventTask()]]));
    const scheduler = new Scheduler(createMockExecutor(), { workDir });
    scheduler.start();
    expect(defOf(scheduler, "reply-triage")?.nextRunAt).toBeUndefined();
    expect(loadDefs(workDir).get("reply-triage")?.nextRunAt).toBeUndefined();
    scheduler.stop();
  });

  it("does not arm the timer at zero delay, and the tick never runs it", async () => {
    seedDefs(workDir, new Map([["reply-triage", eventTask()]]));
    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir });
    scheduler.start();
    await scheduler.onTimer();
    expect(executor).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("runFromEvent runs it anyway, and the run says what woke it", async () => {
    seedDefs(workDir, new Map([["reply-triage", eventTask()]]));
    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir });
    scheduler.start();

    const outcome = await scheduler.runFromEvent(WS, OWNER, "reply-triage", {
      preamble: "<event>…</event>",
    });

    expect("run" in outcome).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
    const [, , trigger, input] = (executor as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]!;
    expect(trigger).toBe("event");
    expect(input).toEqual({ preamble: "<event>…</event>" });
    scheduler.stop();
  });

  it("reports why a run did not start rather than failing silently", async () => {
    seedDefs(workDir, new Map([["reply-triage", eventTask({ enabled: false })]]));
    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir });
    scheduler.start();

    const outcome = await scheduler.runFromEvent(WS, OWNER, "reply-triage", { preamble: "x" });
    expect(outcome).toEqual({ skipped: "the task is disabled" });
    expect(executor).not.toHaveBeenCalled();

    const missing = await scheduler.runFromEvent(WS, OWNER, "nope", { preamble: "x" });
    expect(missing).toEqual({
      skipped: "the task is no longer in this workspace",
    });
    scheduler.stop();
  });

  // A run's synthesized failure record has to carry the trigger too, or the
  // fire ceiling — which counts event runs off the run index — undercounts
  // exactly the runs a runaway loop produces.
  it("stamps the trigger on a run that threw", async () => {
    seedDefs(workDir, new Map([["reply-triage", eventTask()]]));
    const scheduler = new Scheduler(createThrowingExecutor(new Error("boom")), { workDir });
    scheduler.start();
    const outcome = await scheduler.runFromEvent(WS, OWNER, "reply-triage", { preamble: "x" });
    expect("run" in outcome && outcome.run.trigger).toBe("event");
    scheduler.stop();
  });
});

describe("Scheduler — degraded runs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** One `nb_task_runs_total` series. Read as a delta: the registry is process-global. */
  async function runsCounted(status: string): Promise<number> {
    const metric = await taskRunsTotal.get();
    return metric.values.find((v) => v.labels.status === status)?.value ?? 0;
  }

  async function runOnce(auto: Task, executor: Executor): Promise<Task> {
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();
    scheduler.stop();
    return loadDefs(tmpDir).get(auto.id)!;
  }

  it("records lastRunStatus degraded and clears the error streak", async () => {
    const auto = makeTask({
      consecutiveErrors: 5,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const degraded: TaskRun = {
      ...makeSuccessRun(auto.id),
      status: "degraded",
      error: "1 tool call(s) failed and were not retried to success: outlook__send_mail ×1.",
    };
    const updated = await runOnce(auto, createMockExecutor(degraded));
    expect(updated.lastRunStatus).toBe("degraded");
    expect(updated.consecutiveErrors).toBe(0);
    expect(updated.enabled).toBe(true);
  });

  it("counts each recorded run once, by status", async () => {
    const before = {
      degraded: await runsCounted("degraded"),
      failure: await runsCounted("failure"),
    };

    const a = makeTask({ id: "a", nextRunAt: new Date(Date.now() - 1000).toISOString() });
    await runOnce(a, createMockExecutor({ ...makeSuccessRun("a"), status: "degraded" }));
    const b = makeTask({ id: "b", nextRunAt: new Date(Date.now() - 1000).toISOString() });
    await runOnce(b, createThrowingExecutor(new Error("boom")));

    expect(await runsCounted("degraded")).toBe(before.degraded + 1);
    expect(await runsCounted("failure")).toBe(before.failure + 1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — a cron schedule whose next run cannot be computed
// ---------------------------------------------------------------------------

describe("Scheduler — cron schedule whose next run cannot be computed", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Create and update refuse an unknown timezone, so a stored row reaches this
  // only by a hand edit or a default timezone that stops resolving.
  const BAD_TZ = { type: "cron" as const, expression: "* * * * *", timezone: "Not/AZone" };

  it("never runs a stored row with a past nextRunAt, and clears it", async () => {
    const auto = makeTask({
      schedule: BAD_TZ,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    for (let tick = 0; tick < 5; tick++) await scheduler.onTimer();
    scheduler.stop();

    expect(executor).not.toHaveBeenCalled();
    expect(defOf(scheduler, auto.id)?.nextRunAt).toBeUndefined();
    expect(loadDefs(tmpDir).get(auto.id)?.nextRunAt).toBeUndefined();
  });

  it("records the run and clears nextRunAt when the next run fails to compute after it", async () => {
    const auto = makeTask({
      schedule: { type: "cron", expression: "* * * * *" },
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    const executor = createMockExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    // The stored row's timezone stops resolving while the timer still holds
    // a due run.
    const stored = loadDefs(tmpDir).get(auto.id)!;
    saveTask(tmpDir, WS, OWNER, { ...stored, schedule: BAD_TZ });
    defOf(scheduler, auto.id)!.nextRunAt = new Date(Date.now() - 1000).toISOString();

    for (let tick = 0; tick < 5; tick++) await scheduler.onTimer();
    scheduler.stop();

    expect(executor).toHaveBeenCalledTimes(1);
    expect(defOf(scheduler, auto.id)?.nextRunAt).toBeUndefined();
    expect(loadDefs(tmpDir).get(auto.id)?.runCount).toBe(1);
  });

  it("clears nextRunAt on a skipped run whose next run fails to compute", async () => {
    const auto = makeTask({
      schedule: { type: "cron", expression: "* * * * *" },
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));

    const { executor, resolve } = createBlockingExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));

    // While the first run is still active, the timezone stops resolving and
    // the timer still holds a due run, so the next tick skips it.
    const stored = loadDefs(tmpDir).get(auto.id)!;
    saveTask(tmpDir, WS, OWNER, { ...stored, schedule: BAD_TZ });
    defOf(scheduler, auto.id)!.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await scheduler.onTimer();

    expect(executor).toHaveBeenCalledTimes(1);
    expect(defOf(scheduler, auto.id)?.nextRunAt).toBeUndefined();

    resolve(makeSuccessRun(auto.id));
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: the run queue (Run now and event runs at the global limit)
// ---------------------------------------------------------------------------

describe("Scheduler — run queue", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Executor whose runs stay open until released one by one, oldest first.
   * Each record carries the run's trigger, as the real executor's does.
   */
  function createSlotExecutor(): {
    executor: Executor;
    started: string[];
    releaseOne: () => void;
    releaseAll: () => void;
  } {
    const pending: Array<{ id: string; resolve: () => void }> = [];
    const started: string[] = [];
    const executor: Executor = mock(
      async (auto: Task, _signal: AbortSignal, trigger: TaskRunTrigger) => {
        started.push(auto.id);
        return new Promise<{ run: TaskRun; result: null }>((resolve) => {
          pending.push({
            id: auto.id,
            resolve: () => resolve(execOk({ ...makeSuccessRun(auto.id), trigger })),
          });
        });
      },
    ) as Executor;
    return {
      executor,
      started,
      releaseOne: () => pending.shift()?.resolve(),
      releaseAll: () => {
        for (const p of pending.splice(0)) p.resolve();
      },
    };
  }

  /** Disabled tasks (so the timer never fires them), one per id. */
  function seedIdle(ids: string[], overrides: Partial<Task> = {}): void {
    seedDefs(
      tmpDir,
      new Map(ids.map((id) => [id, makeTask({ id, name: id, enabled: false, ...overrides })])),
    );
  }

  const tick = () => new Promise((r) => setTimeout(r, 10));

  it("queues a Run now at the global limit instead of starting it", async () => {
    seedIdle(["a", "b", "c"]);
    const { executor, started, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 2 }),
    });
    scheduler.start();

    expect(scheduler.requestRunNow(WS, OWNER, "a")?.state).toBe("started");
    expect(scheduler.requestRunNow(WS, OWNER, "b")?.state).toBe("started");
    const third = scheduler.requestRunNow(WS, OWNER, "c");
    expect(third).toMatchObject({ state: "queued", position: 1 });
    await tick();

    expect(started).toEqual(["a", "b"]);
    expect(scheduler.getActiveRunIds().length).toBe(2);
    expect(scheduler.getQueuedRunIds()).toEqual([`${WS}/${OWNER}/c`]);
    expect(readRuns(tmpDir, WS, OWNER, "c")).toEqual([]);

    releaseAll();
    scheduler.stop();
  });

  it("queueView reports one owner's running and queued runs, from its own admission keys", async () => {
    seedIdle(["a", "b", "c"]);
    seedDefs(
      tmpDir,
      new Map([["x", makeTask({ id: "x", name: "x", enabled: false, ownerId: "usr_other" })]]),
      "usr_other",
    );
    const { executor, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 2 }),
    });
    scheduler.start();
    const requested = { runId: "run_aaaaaaaaaaaa", requestedAt: new Date().toISOString() };
    scheduler.requestRunNow(WS, OWNER, "a", requested);
    scheduler.requestRunNow(WS, "usr_other", "x");
    scheduler.requestRunNow(WS, "usr_other", "x"); // a duplicate: refused, not queued
    scheduler.requestRunNow(WS, OWNER, "b");
    scheduler.requestRunNow(WS, OWNER, "c", { ...requested, runId: "run_cccccccccccc" });
    await tick();

    const view = scheduler.queueView(WS, OWNER);
    expect(view.find((e) => e.state === "running")).toMatchObject({
      taskId: "a",
      runId: "run_aaaaaaaaaaaa",
      trigger: "manual",
    });
    expect(view.filter((e) => e.state === "running")).toHaveLength(1);
    // Positions count this scheduler's whole queue, as tasks__run's do.
    expect(view.filter((e) => e.state === "queued")).toEqual([
      { taskId: "b", state: "queued", position: 1 },
      { taskId: "c", state: "queued", position: 2, runId: "run_cccccccccccc" },
    ]);
    expect(scheduler.queueView(WS, "usr_other").map((e) => [e.taskId, e.state])).toEqual([
      ["x", "running"],
    ]);
    expect(scheduler.queueView("ws_ffffffffffffffff", OWNER)).toEqual([]);

    releaseAll();
    await tick();
    releaseAll();
    await tick();
    expect(scheduler.queueView(WS, OWNER)).toEqual([]);
    scheduler.stop();
  });

  it("starts the next queued run the moment a slot frees, without a timer tick", async () => {
    seedIdle(["a", "b", "c"]);
    const { executor, started, releaseOne, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 2 }),
    });
    scheduler.start();
    const onTimer = spyOn(scheduler, "onTimer");

    scheduler.requestRunNow(WS, OWNER, "a");
    scheduler.requestRunNow(WS, OWNER, "b");
    const third = scheduler.requestRunNow(WS, OWNER, "c");
    await tick();

    releaseOne(); // "a" ends
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    expect(scheduler.getQueuedRunIds()).toEqual([]);
    expect(onTimer).not.toHaveBeenCalled();

    releaseAll();
    if (third?.state !== "queued") throw new Error("expected queued");
    const run = await third.run;
    expect(run.status).toBe("success");
    expect(run.taskId).toBe("c");
    expect(readRuns(tmpDir, WS, OWNER, "c").map((r) => r.status)).toEqual(["success"]);
    scheduler.stop();
  });

  it("takes its slot count and queue limit from the tasks config", async () => {
    seedIdle(["a", "b", "c", "d", "e"]);
    const { executor, started, releaseAll } = createSlotExecutor();
    const { maxConcurrentRuns, maxQueuedRuns } = resolveTasksConfig({
      maxConcurrentRuns: 3,
      maxQueuedRuns: 1,
    });
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns, maxQueuedRuns }),
    });
    scheduler.start();

    const states = ["a", "b", "c", "d", "e"].map(
      (id) => scheduler.requestRunNow(WS, OWNER, id)?.state,
    );
    await tick();
    expect(states).toEqual(["started", "started", "started", "queued", "refused"]);
    expect(started).toEqual(["a", "b", "c"]);

    releaseAll();
    scheduler.stop();
  });

  it("queues FIFO and reports each run's position", async () => {
    seedIdle(["a", "b", "c", "d"]);
    const { executor, started, releaseOne, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1 }),
    });
    scheduler.start();

    scheduler.requestRunNow(WS, OWNER, "a");
    expect(scheduler.requestRunNow(WS, OWNER, "b")).toMatchObject({ position: 1 });
    expect(scheduler.requestRunNow(WS, OWNER, "c")).toMatchObject({ position: 2 });
    expect(scheduler.requestRunNow(WS, OWNER, "d")).toMatchObject({ position: 3 });

    for (let i = 0; i < 3; i++) {
      await tick();
      releaseOne();
    }
    await tick();
    expect(started).toEqual(["a", "b", "c", "d"]);
    releaseAll();
    scheduler.stop();
  });

  it("refuses a Run now beyond the queue limit with a skipped record", async () => {
    seedIdle(["a", "b", "c"]);
    const { executor, started, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1, maxQueuedRuns: 1 }),
    });
    scheduler.start();

    scheduler.requestRunNow(WS, OWNER, "a");
    expect(scheduler.requestRunNow(WS, OWNER, "b")?.state).toBe("queued");
    const refused = scheduler.requestRunNow(WS, OWNER, "c");
    if (refused?.state !== "refused") throw new Error("expected refused");
    expect(refused.run.status).toBe("skipped");
    expect(refused.run.error).toContain("Run queue full");
    // A run that never started carries no trigger: `trigger` means it ran.
    expect(refused.run.trigger).toBeUndefined();
    expect(readRuns(tmpDir, WS, OWNER, "c").map((r) => r.error)).toEqual([refused.run.error]);
    await tick();
    expect(started).toEqual(["a"]);

    releaseAll();
    scheduler.stop();
  });

  it("refuses a Run now for a task that is already queued", async () => {
    seedIdle(["a", "b"]);
    const { executor, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1 }),
    });
    scheduler.start();

    scheduler.requestRunNow(WS, OWNER, "a");
    expect(scheduler.requestRunNow(WS, OWNER, "b")?.state).toBe("queued");
    const again = scheduler.requestRunNow(WS, OWNER, "b");
    if (again?.state !== "refused") throw new Error("expected refused");
    expect(again.run.error).toBe("Already queued (runNow)");
    expect(scheduler.getQueuedRunIds()).toEqual([`${WS}/${OWNER}/b`]);

    const running = scheduler.requestRunNow(WS, OWNER, "a");
    if (running?.state !== "refused") throw new Error("expected refused");
    expect(running.run.error).toBe("Already running (runNow)");

    releaseAll();
    scheduler.stop();
  });

  it("a refused Run now leaves the schedule alone", async () => {
    const nextRunAt = new Date(Date.now() + 3_600_000).toISOString();
    seedDefs(tmpDir, new Map([["a", makeTask({ id: "a", nextRunAt })]]));
    const { executor, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    scheduler.requestRunNow(WS, OWNER, "a");
    expect(scheduler.requestRunNow(WS, OWNER, "a")?.state).toBe("refused");
    expect(loadDefs(tmpDir).get("a")?.nextRunAt).toBe(nextRunAt);

    releaseAll();
    scheduler.stop();
  });

  it("cancel removes a queued run and records it cancelled", async () => {
    seedIdle(["a", "b"]);
    const { executor, started, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1 }),
    });
    scheduler.start();

    scheduler.requestRunNow(WS, OWNER, "a");
    const queued = scheduler.requestRunNow(WS, OWNER, "b");
    if (queued?.state !== "queued") throw new Error("expected queued");

    expect(scheduler.cancelRun(WS, OWNER, "b")).toBe(true);
    expect(scheduler.getQueuedRunIds()).toEqual([]);
    const run = await queued.run;
    expect(run.status).toBe("cancelled");
    expect(readRuns(tmpDir, WS, OWNER, "b").map((r) => r.status)).toEqual(["cancelled"]);

    releaseAll();
    await tick();
    expect(started).toEqual(["a"]);
    expect(scheduler.cancelRun(WS, OWNER, "b")).toBe(false);
    scheduler.stop();
  });

  it("stop records every queued run as skipped", async () => {
    seedIdle(["a", "b"]);
    const { executor } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1 }),
    });
    scheduler.start();

    scheduler.requestRunNow(WS, OWNER, "a");
    const queued = scheduler.requestRunNow(WS, OWNER, "b");
    if (queued?.state !== "queued") throw new Error("expected queued");

    scheduler.stop();
    const run = await queued.run;
    expect(run.status).toBe("skipped");
    expect(run.error).toContain("runtime stopped");
    expect(readRuns(tmpDir, WS, OWNER, "b").map((r) => r.status)).toEqual(["skipped"]);
  });

  it("an event run at the limit queues and runs when a slot frees", async () => {
    seedDefs(
      tmpDir,
      new Map([
        ["a", makeTask({ id: "a", enabled: false })],
        ["ev", makeTask({ id: "ev", schedule: { type: "event", match: { source: "x" } } })],
      ]),
    );
    const { executor, started, releaseOne, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1 }),
    });
    scheduler.start();

    scheduler.requestRunNow(WS, OWNER, "a");
    const outcome = scheduler.runFromEvent(WS, OWNER, "ev", { preamble: "x" });
    await tick();
    expect(started).toEqual(["a"]);
    expect(scheduler.getQueuedRunIds()).toEqual([`${WS}/${OWNER}/ev`]);
    expect(readRuns(tmpDir, WS, OWNER, "ev")).toEqual([]);

    releaseOne();
    await tick();
    expect(started).toEqual(["a", "ev"]);
    releaseAll();
    const settled = await outcome;
    if (!("run" in settled)) throw new Error(`expected a run, got ${JSON.stringify(settled)}`);
    expect(settled.run.status).toBe("success");
    scheduler.stop();
  });

  it("an event run beyond the queue limit is skipped", async () => {
    seedDefs(
      tmpDir,
      new Map([
        ["a", makeTask({ id: "a", enabled: false })],
        ["ev", makeTask({ id: "ev", schedule: { type: "event", match: { source: "x" } } })],
      ]),
    );
    const { executor, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1, maxQueuedRuns: 0 }),
    });
    scheduler.start();

    scheduler.requestRunNow(WS, OWNER, "a");
    const outcome = await scheduler.runFromEvent(WS, OWNER, "ev", { preamble: "x" });
    expect(outcome).toMatchObject({ skipped: expect.stringContaining("run queue was full") });
    const rows = readRuns(tmpDir, WS, OWNER, "ev");
    expect(rows.map((r) => r.status)).toEqual(["skipped"]);
    expect(rows.filter(countsAsEventFire)).toEqual([]);

    releaseAll();
    scheduler.stop();
  });

  /** An enabled event task `ev`, plus idle tasks that hold slots and queue places. */
  function seedEventAnd(idle: string[]): void {
    seedDefs(
      tmpDir,
      new Map<string, Task>([
        ...idle.map((id): [string, Task] => [id, makeTask({ id, enabled: false })]),
        ["ev", makeTask({ id: "ev", schedule: { type: "event", match: { source: "x" } } })],
      ]),
    );
  }

  it("refused event fires do not count toward the fire ceiling; started ones do", async () => {
    seedEventAnd(["a", "b"]);
    const { executor, started, releaseOne, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1, maxQueuedRuns: 1 }),
    });
    scheduler.start();
    const input = { preamble: "x" };

    // One fire that runs, and one refused while it is in flight.
    const first = scheduler.runFromEvent(WS, OWNER, "ev", input);
    expect(await scheduler.runFromEvent(WS, OWNER, "ev", input)).toMatchObject({
      skipped: expect.stringContaining("still in flight"),
    });
    releaseOne();
    expect(await first).toMatchObject({ run: { status: "success" } });

    // Refused because the queue is full.
    scheduler.requestRunNow(WS, OWNER, "a");
    scheduler.requestRunNow(WS, OWNER, "b");
    expect(await scheduler.runFromEvent(WS, OWNER, "ev", input)).toMatchObject({
      skipped: expect.stringContaining("run queue was full"),
    });
    scheduler.cancelRun(WS, OWNER, "b");

    // Queued, then cancelled before it started.
    const cancelled = scheduler.runFromEvent(WS, OWNER, "ev", input);
    expect(scheduler.cancelRun(WS, OWNER, "ev")).toBe(true);
    expect(await cancelled).toEqual({ skipped: "Cancelled by user while queued" });

    releaseAll();
    await tick();
    expect(started).toEqual(["ev", "a"]);
    const rows = readRuns(tmpDir, WS, OWNER, "ev");
    expect(rows.map((r) => r.status).sort()).toEqual([
      "cancelled",
      "skipped",
      "skipped",
      "success",
    ]);
    expect(rows.filter(countsAsEventFire).map((r) => r.status)).toEqual(["success"]);
    scheduler.stop();
  });

  it("a started event run that is then cancelled still counts as a fire", () => {
    const run = {
      ...makeSuccessRun("ev"),
      status: "cancelled" as const,
      trigger: "event" as const,
    };
    expect(countsAsEventFire(run)).toBe(true);
    // The runtime refusing a dispatched run at the door did no work.
    expect(countsAsEventFire({ ...run, status: "skipped" })).toBe(false);
  });

  it("an event run disabled while queued does not start, and answers skipped", async () => {
    seedEventAnd(["a"]);
    const { executor, started, releaseOne, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1 }),
    });
    scheduler.start();

    scheduler.requestRunNow(WS, OWNER, "a");
    const outcome = scheduler.runFromEvent(WS, OWNER, "ev", { preamble: "x" });
    expect(scheduler.getQueuedRunIds()).toEqual([`${WS}/${OWNER}/ev`]);
    defOf(scheduler, "ev")!.enabled = false;

    releaseOne(); // "a" ends; the queue drains into the re-check
    expect(await outcome).toEqual({ skipped: "Disabled while queued (event)" });
    await tick();
    expect(started).toEqual(["a"]);
    const rows = readRuns(tmpDir, WS, OWNER, "ev");
    expect(rows.map((r) => [r.status, r.error])).toEqual([
      ["skipped", "Disabled while queued (event)"],
    ]);
    expect(rows.filter(countsAsEventFire)).toEqual([]);

    releaseAll();
    scheduler.stop();
  });

  it("a queued Run now whose token budget is spent while it waits is refused as it leaves the queue", async () => {
    seedDefs(
      tmpDir,
      new Map([
        ["a", makeTask({ id: "a", enabled: false })],
        [
          "x",
          makeTask({
            id: "x",
            enabled: false,
            tokenBudget: { maxInputTokens: 5000, period: "daily" },
            budgetResetAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        ],
      ]),
    );
    const { executor, started, releaseOne, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1 }),
    });
    scheduler.start();

    scheduler.requestRunNow(WS, OWNER, "a");
    const queued = scheduler.requestRunNow(WS, OWNER, "x");
    if (queued?.state !== "queued") throw new Error("expected queued");
    // The window fills while the run waits.
    defOf(scheduler, "x")!.cumulativeInputTokens = 9000;

    releaseOne();
    const run = await queued.run;
    expect(run.status).toBe("skipped");
    expect(run.error).toContain("Token budget exceeded");
    await tick();
    expect(started).toEqual(["a"]);
    expect(readRuns(tmpDir, WS, OWNER, "x").map((r) => r.status)).toEqual(["skipped"]);

    releaseAll();
    scheduler.stop();
  });

  it("dropWorkspace resolves the workspace's queued runs as not started, writing nothing", async () => {
    seedEventAnd(["a", "b"]);
    const { executor, started, releaseAll } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1 }),
    });
    scheduler.start();

    scheduler.requestRunNow(WS, OWNER, "a");
    const manual = scheduler.requestRunNow(WS, OWNER, "b");
    if (manual?.state !== "queued") throw new Error("expected queued");
    const event = scheduler.runFromEvent(WS, OWNER, "ev", { preamble: "x" });
    expect(scheduler.getQueuedRunIds()).toHaveLength(2);

    scheduler.dropWorkspace(WS);
    expect(scheduler.getQueuedRunIds()).toEqual([]);
    const run = await manual.run;
    expect(run.status).toBe("skipped");
    expect(run.error).toBe("the workspace was deleted");
    expect(await event).toEqual({ skipped: "the workspace was deleted" });
    expect(readRuns(tmpDir, WS, OWNER, "b")).toEqual([]);
    expect(readRuns(tmpDir, WS, OWNER, "ev")).toEqual([]);

    releaseAll();
    await tick();
    expect(started).toEqual(["a"]);
    scheduler.stop();
  });

  it("refuses Run now and event runs once stopped, instead of queueing what nothing drains", async () => {
    seedEventAnd(["a"]);
    const { executor, started } = createSlotExecutor();
    const scheduler = new Scheduler(executor, {
      workDir: tmpDir,
      admission: createRunAdmission({ maxConcurrentRuns: 1 }),
    });
    scheduler.start();
    scheduler.stop();

    const ticket = scheduler.requestRunNow(WS, OWNER, "a");
    if (ticket?.state !== "refused") throw new Error(`expected refused, got ${ticket?.state}`);
    expect(ticket.run.status).toBe("skipped");
    expect(ticket.run.error).toBe("the scheduler is stopped");
    expect(await scheduler.runFromEvent(WS, OWNER, "ev", { preamble: "x" })).toEqual({
      skipped: "the scheduler is stopped",
    });
    expect(scheduler.getQueuedRunIds()).toEqual([]);
    expect(started).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: token budget on Run now
// ---------------------------------------------------------------------------

describe("Scheduler — token budget applies to every run", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runOf(id: string, inputTokens: number): TaskRun {
    return { ...makeSuccessRun(id), inputTokens, outputTokens: 0 };
  }

  it("accumulates a disabled task's Run now spend", async () => {
    const auto = makeTask({
      enabled: false,
      tokenBudget: { maxInputTokens: 5000, period: "daily" },
      budgetResetAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    const scheduler = new Scheduler(createMockExecutor(runOf(auto.id, 3000)), {
      workDir: tmpDir,
    });
    scheduler.start();

    await scheduler.runNow(WS, OWNER, auto.id);
    expect(defOf(scheduler, auto.id)?.cumulativeInputTokens).toBe(3000);
    scheduler.stop();
  });

  it("refuses Run now on a disabled task whose budget is spent", async () => {
    const auto = makeTask({
      enabled: false,
      tokenBudget: { maxInputTokens: 5000, period: "daily" },
      budgetResetAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    const executor = createMockExecutor(runOf(auto.id, 3000));
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    expect((await scheduler.runNow(WS, OWNER, auto.id))?.status).toBe("success");
    expect((await scheduler.runNow(WS, OWNER, auto.id))?.status).toBe("success"); // 6000 > 5000
    const refused = await scheduler.runNow(WS, OWNER, auto.id);
    expect(refused?.status).toBe("skipped");
    expect(refused?.error).toContain("Token budget exceeded");
    expect(refused?.error).toContain("until the budget resets");
    expect(executor).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("lets Run now through again once the window resets", async () => {
    const auto = makeTask({
      enabled: false,
      cumulativeInputTokens: 9000,
      tokenBudget: { maxInputTokens: 5000, period: "daily" },
      budgetResetAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    const executor = createMockExecutor(runOf(auto.id, 100));
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    expect((await scheduler.runNow(WS, OWNER, auto.id))?.status).toBe("skipped");

    // The window's boundary passes.
    defOf(scheduler, auto.id)!.budgetResetAt = new Date(Date.now() - 1000).toISOString();
    const stored = loadDefs(tmpDir).get(auto.id)!;
    stored.budgetResetAt = new Date(Date.now() - 1000).toISOString();
    saveTask(tmpDir, WS, OWNER, stored);

    expect((await scheduler.runNow(WS, OWNER, auto.id))?.status).toBe("success");
    const after = defOf(scheduler, auto.id)!;
    expect(after.cumulativeInputTokens).toBe(100);
    expect(new Date(after.budgetResetAt!).getTime()).toBeGreaterThan(Date.now());
    scheduler.stop();
  });

  it("a lifetime budget refuses until it is raised", async () => {
    const auto = makeTask({
      enabled: false,
      cumulativeInputTokens: 9000,
      tokenBudget: { maxInputTokens: 5000 },
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    const scheduler = new Scheduler(createMockExecutor(), { workDir: tmpDir });
    scheduler.start();

    const refused = await scheduler.runNow(WS, OWNER, auto.id);
    expect(refused?.status).toBe("skipped");
    expect(refused?.error).toContain("until its token budget is raised");
    scheduler.stop();
  });

  it("names one token spend account per cap, holding what is left of the window", () => {
    const now = Date.now();
    const resetAt = new Date(now + 3_600_000).toISOString();
    const auto = makeTask({
      cumulativeInputTokens: 3_000,
      cumulativeOutputTokens: 900,
      tokenBudget: { maxInputTokens: 5_000, maxOutputTokens: 1_000, period: "daily" },
      budgetResetAt: resetAt,
    });
    const accounts = budgetSpendAccounts(auto, now);
    expect(accounts.map((a) => [a.unit, a.remaining])).toEqual([
      ["input_tokens", 2_000],
      ["output_tokens", 100],
    ]);
    // Opaque to the door, distinct per task and window.
    expect(accounts[0]!.id).toContain(auto.id);
    expect(accounts[0]!.id).toContain(resetAt);
    expect(accounts[0]!.id).not.toBe(accounts[1]!.id);

    // A spent window names nothing left, never a negative amount.
    expect(budgetSpendAccounts({ ...auto, cumulativeInputTokens: 9_000 }, now)[0]!.remaining).toBe(
      0,
    );
    // A passed boundary is a fresh window: full caps, and a different id.
    const fresh = budgetSpendAccounts(auto, now + 7_200_000);
    expect(fresh.map((a) => a.remaining)).toEqual([5_000, 1_000]);
    expect(fresh[0]!.id).not.toBe(accounts[0]!.id);
    // No budget, no accounts.
    expect(budgetSpendAccounts(makeTask(), now)).toEqual([]);
  });

  it("disables an enabled task whose run the budget stopped mid-way, below the cap", async () => {
    const auto = makeTask({
      cumulativeInputTokens: 3_000,
      tokenBudget: { maxInputTokens: 5_000, period: "daily" },
      budgetResetAt: new Date(Date.now() + 3_600_000).toISOString(),
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    // The door stopped the run before a call that would have passed the cap,
    // so the counters (3,000 + 1,500) stay under it.
    const stopped: TaskRun = {
      ...runOf(auto.id, 1_500),
      status: "failure",
      stopReason: "spend_limit",
      spendAccountId: budgetSpendAccounts(auto, Date.now())[0]!.id,
      error: "Token budget reached: too little of the budget was left for the next step",
    };
    const scheduler = new Scheduler(createMockExecutor(stopped), { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.cumulativeInputTokens).toBe(4_500);
    expect(updated.enabled).toBe(false);
    expect(updated.disabledReason).toContain("Token budget reached");
    scheduler.stop();
  });

  it("a spend stop by an account that is not the budget's leaves the task enabled", async () => {
    const auto = makeTask({
      cumulativeInputTokens: 3_000,
      tokenBudget: { maxInputTokens: 5_000, period: "daily" },
      budgetResetAt: new Date(Date.now() + 3_600_000).toISOString(),
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    const stopped: TaskRun = {
      ...runOf(auto.id, 1_500),
      status: "failure",
      stopReason: "spend_limit",
      spendAccountId: "workspace-dollars:acme-corp",
      error: "Token budget reached",
    };
    const scheduler = new Scheduler(createMockExecutor(stopped), { workDir: tmpDir });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.cumulativeInputTokens).toBe(4_500);
    expect(updated.enabled).toBe(true);
    expect(updated.disabledReason).toBeUndefined();
    scheduler.stop();
  });

  it("enforces the budget before each model call, through the executor and the engine", async () => {
    // Each model call spends 1,000 input tokens and asks for a tool. With 2,500
    // left in the window, the door lets two calls through and stops the third.
    const auto = makeTask({
      cumulativeInputTokens: 2_500,
      tokenBudget: { maxInputTokens: 5_000, period: "daily" },
      budgetResetAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    const tools: ToolSchema[] = [{ name: "test__step", description: "step", inputSchema: {} }];
    const balances = createSpendBalances();
    let modelCalls = 0;
    const taskFn: TaskFn = async (req) => {
      const hold = balances.open(req.spendAccounts ?? [], { model: "test", rates: null });
      const engine = new AgentEngine(
        createMockModel(() => {
          modelCalls++;
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: `c${modelCalls}`,
                toolName: "test__step",
                input: "{}",
              },
            ],
            inputTokens: 1_000,
            outputTokens: 1,
          };
        }),
        new StaticToolRouter(
          tools,
          (): ToolResult => ({ content: textContent("ok"), isError: false }),
        ),
        { emit() {} },
      );
      try {
        const r = await engine.run(
          {
            model: "test",
            maxIterations: 25,
            maxInputTokens: 500_000,
            maxOutputTokens: 100,
            spend: hold,
          },
          "",
          [{ role: "user", content: [{ type: "text", text: req.prompt }] }],
          tools,
        );
        return {
          output: r.output,
          runId: "run_spendtest00",
          toolCalls: [],
          stopReason: r.stopReason,
          ...(r.spendAccountId ? { spendAccountId: r.spendAccountId } : {}),
          usage: { ...r.usage, iterations: r.iterations },
        };
      } finally {
        hold.release();
      }
    };
    const scheduler = new Scheduler(
      createDirectExecutor(taskFn, () => ({})),
      { workDir: tmpDir },
    );
    scheduler.start();

    const run = await scheduler.runNow(WS, OWNER, auto.id);
    expect(modelCalls).toBe(2);
    expect(run?.stopReason).toBe("spend_limit");
    expect(run?.inputTokens).toBe(2_000);
    const updated = defOf(scheduler, auto.id)!;
    expect(updated.cumulativeInputTokens).toBe(4_500);
    expect(updated.cumulativeInputTokens).toBeLessThanOrEqual(5_000);
    expect(updated.enabled).toBe(false);
    expect(updated.disabledReason).toContain("Token budget reached");
    scheduler.stop();
  });

  it("seeding an unset window starts it fresh instead of counting stale spend", async () => {
    const auto = makeTask({
      cumulativeInputTokens: 90_000,
      tokenBudget: { maxInputTokens: 10_000, period: "daily" },
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    const scheduler = new Scheduler(createMockExecutor(runOf(auto.id, 1000)), {
      workDir: tmpDir,
    });
    scheduler.start();
    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.cumulativeInputTokens).toBe(1000);
    expect(updated.enabled).toBe(true);
    expect(updated.budgetResetAt).toBeDefined();
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — every recorded run has a result
// ---------------------------------------------------------------------------

describe("Scheduler — every recorded run has a result", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedOne(overrides: Partial<Task> = {}): Task {
    const auto = makeTask({ nextRunAt: new Date(Date.now() - 1000).toISOString(), ...overrides });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    return auto;
  }

  /** Every line of the task's run index, each with the result read back by its id. */
  function linesWithResults(taskId: string) {
    return readRuns(tmpDir, WS, OWNER, taskId).map((run) => ({
      run,
      result: readRunResult(tmpDir, WS, OWNER, taskId, run.id),
    }));
  }

  it("a run whose executor throws has a result carrying its error", async () => {
    const auto = seedOne();
    const scheduler = new Scheduler(createThrowingExecutor(new Error("boom")), {
      workDir: tmpDir,
    });
    scheduler.start();

    const run = await scheduler.runNow(WS, OWNER, auto.id);
    scheduler.stop();

    expect(run!.status).toBe("failure");
    const lines = linesWithResults(auto.id);
    expect(lines.length).toBeGreaterThan(0);
    for (const { run: line, result } of lines) {
      expect(result).not.toBeNull();
      expect(result!.runId).toBe(line.id);
      expect(result!.error).toBe(line.error);
    }
    const result = readRunResult(tmpDir, WS, OWNER, auto.id, run!.id)!;
    expect(result.error).toBe("boom");
    expect(result.output).toBe("");
    expect(result.activityLog).toEqual([]);
    expect(result.outputFiles).toEqual([]);
  });

  it("a membership-revoked run, recorded skipped, has a result with the reason", async () => {
    const auto = seedOne();
    const denied = Object.assign(new Error("owner is no longer a member"), {
      code: "workspace_membership_revoked",
    });
    const scheduler = new Scheduler(createThrowingExecutor(denied), { workDir: tmpDir });
    scheduler.start();

    const run = await scheduler.runNow(WS, OWNER, auto.id);
    scheduler.stop();

    expect(run!.status).toBe("skipped");
    const result = readRunResult(tmpDir, WS, OWNER, auto.id, run!.id);
    expect(result?.error).toBe("owner is no longer a member");
  });

  it("a run refused because one is already running has a result with the reason", async () => {
    const auto = seedOne();
    const { executor, resolve } = createBlockingExecutor();
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    scheduler.onTimer();
    await new Promise((r) => setTimeout(r, 50));

    const run = await scheduler.runNow(WS, OWNER, auto.id);

    expect(run!.status).toBe("skipped");
    const result = readRunResult(tmpDir, WS, OWNER, auto.id, run!.id);
    expect(result).not.toBeNull();
    expect(result!.error).toBe(run!.error);
    expect(result!.output).toBe("");
    resolve(makeSuccessRun(auto.id));
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();

    for (const { result: each } of linesWithResults(auto.id)) expect(each).not.toBeNull();
  });

  it("a requested run lost with its process has a result when it is settled", () => {
    const auto = seedOne();
    const scheduler = new Scheduler(createMockExecutor(), { workDir: tmpDir });
    const runId = "run_0123456789ab";
    const settled = scheduler.settleLostRun(WS, OWNER, {
      runId,
      taskId: auto.id,
      requestedAt: new Date().toISOString(),
      run: {
        id: runId,
        taskId: auto.id,
        startedAt: new Date().toISOString(),
        status: "running",
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        iterations: 0,
        trigger: "manual",
      },
    });

    expect(settled.run.status).toBe("failure");
    const result = readRunResult(tmpDir, WS, OWNER, auto.id, runId);
    expect(result?.error).toBe(settled.run.error);
  });

  it("a scheduled run interrupted by a stop has a result once the next process settles it", async () => {
    const auto = seedOne({ schedule: { type: "interval", intervalMs: 3_600_000 } });
    const first = new Scheduler(createBlockingExecutor().executor, { workDir: tmpDir });
    first.start();
    await new Promise((r) => setTimeout(r, 20));

    const second = new Scheduler(createMockExecutor(), { workDir: tmpDir });
    second.start();
    second.stop();

    const lines = linesWithResults(auto.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.result?.error).toBe(INTERRUPTED_RUN_ERROR);
  });

  it("a completed run's result lands with the run's error, when it has one", async () => {
    const auto = seedOne();
    const degraded: TaskRun = {
      ...makeSuccessRun(auto.id),
      status: "degraded",
      error: "a tool failed",
    };
    const scheduler = new Scheduler(createMockExecutor(degraded), { workDir: tmpDir });
    scheduler.start();

    const run = await scheduler.runNow(WS, OWNER, auto.id);
    scheduler.stop();

    expect(readRunResult(tmpDir, WS, OWNER, auto.id, run!.id)?.error).toBe("a tool failed");
  });
});
