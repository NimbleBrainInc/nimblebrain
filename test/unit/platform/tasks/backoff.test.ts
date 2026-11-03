/**
 * Backoff behavior tests for the task scheduler.
 *
 * Verifies exponential backoff delays after consecutive failures,
 * reset on success, transient vs non-transient error classification,
 * and that backoff-delayed tasks are not executed prematurely.
 *
 * Uses time manipulation (not real waits) via direct scheduler state
 * and the exported helper functions.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backoffDelay,
  type Executor,
  isInBackoff,
  isTransientError,
  MAX_CONSECUTIVE_ERRORS,
  MAX_CONSECUTIVE_TRANSIENT_ERRORS,
  Scheduler,
} from "../../../../src/platform/tasks/scheduler.ts";
import { loadTask, saveTask } from "../../../../src/platform/tasks/store.ts";
import type { Task, TaskRun } from "../../../../src/platform/tasks/types.ts";
import { seedWorkspaceRoot } from "../../../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

// Tasks are workspace-owned: the scheduler scans
// `{workDir}/workspaces/<wsId>/tasks/<ownerId>/`. `makeTmpDir` returns the
// workDir root handed straight to the Scheduler; `seedDefs`/`loadDefs` write/read
// the per-task store; `defOf` looks up the composite-keyed definitions.
const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "backoff-test-"));
  seedWorkspaceRoot(dir, WS);
  return dir;
}

function seedDefs(workDir: string, defs: Map<string, Task>): void {
  for (const auto of defs.values()) {
    if (!auto.workspaceId) auto.workspaceId = WS;
    if (!auto.ownerId) auto.ownerId = OWNER;
    saveTask(workDir, WS, OWNER, auto);
  }
}

function defOf(scheduler: Scheduler, id: string, owner = OWNER, ws = WS): Task | undefined {
  return scheduler.getDefinitions().get(`${ws}/${owner}/${id}`);
}

/** Wrap a run in the executor's `{ run, result }` return shape. */
function execOk(run: TaskRun): { run: TaskRun; result: null } {
  return { run, result: null };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "backoff-test",
    ownerId: OWNER,
    workspaceId: WS,
    name: "Backoff Test",
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

function makeFailureRun(taskId: string, error = "Something broke"): TaskRun {
  return {
    id: `run_fail_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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

function makeSuccessRun(taskId: string): TaskRun {
  return {
    id: `run_ok_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    taskId,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "success",
    inputTokens: 200,
    outputTokens: 100,
    toolCalls: 2,
    iterations: 1,
  };
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Backoff delay progression across consecutive failures
// ---------------------------------------------------------------------------

describe("backoff delay progression", () => {
  test("3 consecutive failures produce increasing backoff delays (respecting natural interval)", async () => {
    // 1-min interval task. Backoff uses max(backoff, naturalInterval):
    // Failure 1: max(30s, 60s) = 60s
    // Failure 2: max(60s, 60s) = 60s
    // Failure 3: max(300s, 60s) = 300s
    const auto = makeTask({
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
      lastRunAt: new Date(Date.now() - 60_001).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    let failCount = 0;
    const executor: Executor = mock(async (a: Task, _signal: AbortSignal) => {
      failCount++;
      return execOk(makeFailureRun(a.id, `Failure #${failCount}`));
    }) as Executor;

    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    // --- Failure 1 ---
    await scheduler.onTimer();
    let updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(1);
    const nextAfter1 = new Date(updated.nextRunAt!).getTime();
    // Should be ~60s from now (natural interval > 30s backoff)
    expect(nextAfter1).toBeGreaterThanOrEqual(Date.now() + 58_000);
    expect(nextAfter1).toBeLessThanOrEqual(Date.now() + 62_000);

    // --- Failure 2: manually set nextRunAt to past so it fires ---
    updated.nextRunAt = new Date(Date.now() - 1).toISOString();
    seedDefs(tmpDir, scheduler.getDefinitions());
    scheduler.reload();

    await scheduler.onTimer();
    updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(2);
    const nextAfter2 = new Date(updated.nextRunAt!).getTime();
    // Should be ~60s from now (natural interval = 60s backoff)
    expect(nextAfter2).toBeGreaterThanOrEqual(Date.now() + 58_000);
    expect(nextAfter2).toBeLessThanOrEqual(Date.now() + 62_000);

    // --- Failure 3: manually set nextRunAt to past ---
    updated.nextRunAt = new Date(Date.now() - 1).toISOString();
    seedDefs(tmpDir, scheduler.getDefinitions());
    scheduler.reload();

    await scheduler.onTimer();
    updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(3);
    const nextAfter3 = new Date(updated.nextRunAt!).getTime();
    // Should be ~5m from now (backoff > natural interval)
    expect(nextAfter3).toBeGreaterThanOrEqual(Date.now() + 298_000);
    expect(nextAfter3).toBeLessThanOrEqual(Date.now() + 302_000);

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Backoff resets to 0 on success
// ---------------------------------------------------------------------------

describe("backoff reset on success", () => {
  test("success after failures resets consecutiveErrors to 0", async () => {
    // Start with 3 consecutive errors, next run due now
    const auto = makeTask({
      consecutiveErrors: 3,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor: Executor = mock(async (a: Task, _signal: AbortSignal) =>
      execOk(makeSuccessRun(a.id)),
    ) as Executor;

    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    await scheduler.onTimer();

    const updated = defOf(scheduler, auto.id)!;
    expect(updated.consecutiveErrors).toBe(0);
    expect(updated.lastRunStatus).toBe("success");

    // Next run should NOT have a backoff delay (should be normal interval)
    const nextRunMs = new Date(updated.nextRunAt!).getTime();
    // Normal interval would be lastRunAt + 60s, which is roughly "now + 60s"
    // With no backoff, it should NOT be pushed out by minutes
    expect(nextRunMs).toBeLessThan(Date.now() + 120_000);

    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// Transient vs non-transient error classification
// ---------------------------------------------------------------------------

describe("transient vs non-transient error classification", () => {
  test("rate limit errors are classified as transient", () => {
    expect(isTransientError("rate limit exceeded")).toBe(true);
    expect(isTransientError("429 Rate_Limit")).toBe(true);
  });

  test("timeout errors are classified as transient", () => {
    expect(isTransientError("Request timeout after 30s")).toBe(true);
  });

  test("network errors are classified as transient", () => {
    expect(isTransientError("network error")).toBe(true);
    expect(isTransientError("ECONNREFUSED 127.0.0.1:3000")).toBe(true);
  });

  test("5xx server errors are classified as transient", () => {
    expect(isTransientError("HTTP 500 Internal Server Error")).toBe(true);
    expect(isTransientError("503 Service Unavailable")).toBe(true);
    expect(isTransientError("502 Bad Gateway")).toBe(true);
  });

  test("overloaded server is classified as transient", () => {
    expect(isTransientError("Server overloaded, please retry")).toBe(true);
  });

  test("validation errors are NOT transient", () => {
    expect(isTransientError("invalid prompt format")).toBe(false);
    expect(isTransientError("missing required field")).toBe(false);
  });

  test("auth errors are NOT transient", () => {
    expect(isTransientError("authentication failed")).toBe(false);
    expect(isTransientError("permission denied")).toBe(false);
    expect(isTransientError("HTTP 401 Unauthorized")).toBe(false);
  });

  test("4xx client errors (except rate limit) are NOT transient", () => {
    expect(isTransientError("HTTP 400 Bad Request")).toBe(false);
    expect(isTransientError("HTTP 403 Forbidden")).toBe(false);
    expect(isTransientError("HTTP 404 Not Found")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backoff-delayed task is not executed before backoff expires
// ---------------------------------------------------------------------------

describe("backoff prevents premature execution", () => {
  test("task in backoff period is skipped by onTimer", async () => {
    // Set up a task with 2 errors and nextRunAt 60s in the future
    const auto = makeTask({
      consecutiveErrors: 2,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor: Executor = mock(async (a: Task, _signal: AbortSignal) =>
      execOk(makeSuccessRun(a.id)),
    ) as Executor;

    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    // Fire the timer — should NOT execute because of backoff
    await scheduler.onTimer();

    expect(executor).toHaveBeenCalledTimes(0);

    scheduler.stop();
  });

  test("task executes after backoff period expires", async () => {
    // Set nextRunAt to the past (backoff has expired)
    const auto = makeTask({
      consecutiveErrors: 1,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    const defs = new Map<string, Task>();
    defs.set(auto.id, auto);
    seedDefs(tmpDir, defs);

    const executor: Executor = mock(async (a: Task, _signal: AbortSignal) =>
      execOk(makeSuccessRun(a.id)),
    ) as Executor;

    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();

    await scheduler.onTimer();

    // Should have executed since backoff period is past
    expect(executor).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  test("isInBackoff correctly identifies active backoff", () => {
    const futureAuto = makeTask({
      consecutiveErrors: 2,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(isInBackoff(futureAuto, Date.now())).toBe(true);

    const pastAuto = makeTask({
      consecutiveErrors: 2,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(isInBackoff(pastAuto, Date.now())).toBe(false);

    const noErrorAuto = makeTask({
      consecutiveErrors: 0,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(isInBackoff(noErrorAuto, Date.now())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backoff delay values match spec
// ---------------------------------------------------------------------------

describe("backoff delay values match spec", () => {
  test("delay table: 30s, 1m, 5m, 15m, 1h, then capped", () => {
    expect(backoffDelay(0)).toBe(0);
    expect(backoffDelay(1)).toBe(30_000); // 30s
    expect(backoffDelay(2)).toBe(60_000); // 1m
    expect(backoffDelay(3)).toBe(300_000); // 5m
    expect(backoffDelay(4)).toBe(900_000); // 15m
    expect(backoffDelay(5)).toBe(3_600_000); // 1h
    expect(backoffDelay(6)).toBe(3_600_000); // capped at 1h
    expect(backoffDelay(50)).toBe(3_600_000); // still capped
  });
});

// ---------------------------------------------------------------------------
// Auto-disable: what counts toward it
// ---------------------------------------------------------------------------

describe("auto-disable", () => {
  const OUTAGE = "Overloaded";
  const REAL = "Invalid request: unknown field";
  const HOUR = 3_600_000;
  let scheduler: Scheduler;

  afterEach(() => scheduler.stop());

  /** One saved task and a scheduler whose runs end as the next entry of `outcomes` says. */
  function schedulerRunning(outcomes: (string | null)[]) {
    const auto = makeTask({ schedule: { type: "interval", intervalMs: 60_000 } });
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    let i = 0;
    const executor: Executor = mock(async (a: Task, _signal: AbortSignal) => {
      const error = outcomes[i++];
      return execOk(error == null ? makeSuccessRun(a.id) : makeFailureRun(a.id, error));
    }) as Executor;
    scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    return {
      async run(times = outcomes.length) {
        for (let n = 0; n < times; n++) await scheduler.runNow(WS, OWNER, auto.id);
        return defOf(scheduler, auto.id)!;
      },
    };
  }

  test("a long transient outage leaves the task enabled and still backing off", async () => {
    const { run } = schedulerRunning(Array(MAX_CONSECUTIVE_ERRORS * 3).fill(OUTAGE));
    const task = await run();

    expect(task.enabled).toBe(true);
    expect(task.disabledReason).toBeUndefined();
    expect(task.consecutiveErrors).toBe(MAX_CONSECUTIVE_ERRORS * 3);
    // On disk too, so a restart mid-outage keeps the count.
    const saved = loadTask(tmpDir, WS, OWNER, task.id);
    expect(saved?.transientErrors).toBe(MAX_CONSECUTIVE_ERRORS * 3);
    const wait = new Date(task.nextRunAt!).getTime() - Date.now();
    expect(wait).toBeGreaterThanOrEqual(HOUR - 2_000);
    expect(wait).toBeLessThanOrEqual(HOUR + 2_000);
    expect(isInBackoff(task, Date.now())).toBe(true);
  });

  test("a permanent error still disables at ten", async () => {
    const { run } = schedulerRunning(Array(MAX_CONSECUTIVE_ERRORS).fill(REAL));

    expect((await run(MAX_CONSECUTIVE_ERRORS - 1)).enabled).toBe(true);
    const task = await run(1);

    expect(task.enabled).toBe(false);
    expect(task.disabledReason).toContain(`after ${MAX_CONSECUTIVE_ERRORS} consecutive failures`);
    expect(task.disabledReason).toContain(REAL);
  });

  test("one real error after a long outage does not disable", async () => {
    const outcomes = [...Array(MAX_CONSECUTIVE_ERRORS * 2).fill(OUTAGE), REAL];
    const task = await schedulerRunning(outcomes).run();

    expect(task.enabled).toBe(true);
  });

  test("real errors between transient ones still disable at ten, and not before", async () => {
    const outcomes = Array.from({ length: MAX_CONSECUTIVE_ERRORS * 2 }, (_, i) =>
      i % 2 === 0 ? OUTAGE : REAL,
    );
    const { run } = schedulerRunning(outcomes);

    expect((await run(outcomes.length - 1)).enabled).toBe(true);
    const task = await run(1);

    expect(task.enabled).toBe(false);
    expect(task.disabledReason).toContain(`after ${MAX_CONSECUTIVE_ERRORS} consecutive failures`);
  });

  test("a failure that only ever looks transient disables at the larger cap", async () => {
    const rateLimited = "This request would exceed your organization's rate limit";
    const { run } = schedulerRunning(Array(MAX_CONSECUTIVE_TRANSIENT_ERRORS).fill(rateLimited));

    expect((await run(MAX_CONSECUTIVE_TRANSIENT_ERRORS - 1)).enabled).toBe(true);
    const task = await run(1);

    expect(task.enabled).toBe(false);
    expect(task.disabledReason).toContain("looked temporary");
    expect(task.disabledReason).toContain(rateLimited);
  });

  test("the first success clears the streak, so ten more real errors are needed", async () => {
    const outcomes = [
      ...Array(MAX_CONSECUTIVE_ERRORS * 2).fill(OUTAGE),
      ...Array(MAX_CONSECUTIVE_ERRORS - 1).fill(REAL),
      null,
      ...Array(MAX_CONSECUTIVE_ERRORS - 1).fill(REAL),
    ];
    const { run } = schedulerRunning(outcomes);

    const recovered = await run(MAX_CONSECUTIVE_ERRORS * 3);
    expect(recovered.enabled).toBe(true);
    expect(recovered.consecutiveErrors).toBe(0);
    expect(recovered.transientErrors).toBeUndefined();
    expect(isInBackoff(recovered, Date.now())).toBe(false);

    expect((await run(MAX_CONSECUTIVE_ERRORS - 1)).enabled).toBe(true);
  });
});

describe("what a thrown run counts as", () => {
  /** The `transient` a run is recorded with when its executor throws `err`. */
  async function transientOf(err: unknown): Promise<boolean | undefined> {
    const auto = makeTask();
    seedDefs(tmpDir, new Map([[auto.id, auto]]));
    const executor: Executor = mock(async () => {
      throw err;
    }) as Executor;
    const scheduler = new Scheduler(executor, { workDir: tmpDir });
    scheduler.start();
    const run = await scheduler.runNow(WS, OWNER, auto.id);
    scheduler.stop();
    return run?.transient;
  }

  const providerError = (message: string, statusCode: number, isRetryable: boolean) =>
    Object.assign(new Error(message), { statusCode, isRetryable });

  test("a provider server error whose text carries no status is transient", async () => {
    expect(await transientOf(providerError("Internal server error", 500, true))).toBe(true);
    expect(await transientOf(providerError("Bad Gateway", 502, true))).toBe(true);
  });

  test("a provider connection failure is transient", async () => {
    const reset = "Cannot connect to API: ECONNRESET: The socket connection was closed";
    expect(await transientOf(Object.assign(new Error(reset), { isRetryable: true }))).toBe(true);
  });

  test("a stalled model stream is transient, with or without output so far", async () => {
    const stalled = (what: string, retryable: boolean) =>
      Object.assign(new Error(`Model stream stalled: no ${what} for 90000ms`), { retryable });
    expect(await transientOf(stalled("response", true))).toBe(true);
    expect(await transientOf(stalled("further output", false))).toBe(true);
  });

  test("a provider's refusal of the request is not transient", async () => {
    const tooLong = "prompt is too long: 205000 tokens > 200000 maximum";
    expect(await transientOf(providerError(tooLong, 400, false))).toBe(false);
  });

  test("a run that used its whole time allowance is not transient, whatever the task is called", async () => {
    const overTime = Object.assign(new Error("Task timeout-report-500 timed out after 540s"), {
      code: "run_duration_exceeded",
    });
    expect(await transientOf(overTime)).toBe(false);
  });
});

describe("a number in an error is not a server error", () => {
  test("digits inside a longer number or a duration do not read as 5xx", () => {
    expect(isTransientError("prompt is too long: 205000 tokens > 200000 maximum")).toBe(false);
    expect(isTransientError("Task report timed out after 540s")).toBe(false);
  });
});
