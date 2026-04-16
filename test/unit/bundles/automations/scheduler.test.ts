import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Automation, AutomationRun } from "../../../../src/bundles/automations/src/types.ts";
import {
	Scheduler,
	isTransientError,
	backoffDelay,
	isInBackoff,
	computeNextRunAt,
	isDue,
	MAX_CONSECUTIVE_ERRORS,
	computeBudgetResetAt,
	type Executor,
} from "../../../../src/bundles/automations/src/scheduler.ts";
import { saveDefinitions, loadDefinitions } from "../../../../src/bundles/automations/src/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "scheduler-test-"));
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
	return {
		id: "test-auto",
		name: "Test Automation",
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

function makeSuccessRun(automationId: string): AutomationRun {
	return {
		id: `run_${Date.now()}`,
		automationId,
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		status: "success",
		inputTokens: 100,
		outputTokens: 50,
		toolCalls: 1,
		iterations: 1,
	};
}

function makeFailureRun(automationId: string, error = "Something broke"): AutomationRun {
	return {
		id: `run_${Date.now()}`,
		automationId,
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

function createMockExecutor(result?: AutomationRun): Executor {
	return mock(async (auto: Automation, _signal: AbortSignal) => {
		return result ?? makeSuccessRun(auto.id);
	}) as Executor;
}

/** Create a delayed executor that resolves after a given delay (or never, until signaled). */
function createBlockingExecutor(): {
	executor: Executor;
	resolve: (run: AutomationRun) => void;
	promise: Promise<AutomationRun>;
} {
	let resolve!: (run: AutomationRun) => void;
	const promise = new Promise<AutomationRun>((r) => {
		resolve = r;
	});
	const executor: Executor = mock(async (_auto: Automation, _signal: AbortSignal) => {
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
		const auto = makeAutomation({ consecutiveErrors: 0 });
		expect(isInBackoff(auto, Date.now())).toBe(false);
	});

	it("returns true when in backoff period", () => {
		const futureTime = new Date(Date.now() + 60_000).toISOString();
		const auto = makeAutomation({
			consecutiveErrors: 1,
			nextRunAt: futureTime,
		});
		expect(isInBackoff(auto, Date.now())).toBe(true);
	});

	it("returns false when backoff period has passed", () => {
		const pastTime = new Date(Date.now() - 1000).toISOString();
		const auto = makeAutomation({
			consecutiveErrors: 1,
			nextRunAt: pastTime,
		});
		expect(isInBackoff(auto, Date.now())).toBe(false);
	});

	it("returns false when no nextRunAt set", () => {
		const auto = makeAutomation({
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
		const auto = makeAutomation({
			schedule: { type: "interval", intervalMs: 60_000 },
			lastRunAt: new Date(lastRun).toISOString(),
		});
		const next = computeNextRunAt(auto, Date.now());
		expect(next).toBe(lastRun + 60_000);
	});

	it("interval fires immediately when no lastRunAt", () => {
		const now = Date.now();
		const auto = makeAutomation({
			schedule: { type: "interval", intervalMs: 60_000 },
			lastRunAt: undefined,
		});
		const next = computeNextRunAt(auto, now);
		expect(next).toBe(now);
	});

	it("computes cron next run", () => {
		const now = Date.now();
		const auto = makeAutomation({
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
		const auto = makeAutomation({
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
		const auto = makeAutomation({
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
		const auto = makeAutomation({ enabled: false });
		expect(isDue(auto, Date.now())).toBe(false);
	});

	it("returns true when no nextRunAt (first interval run)", () => {
		const auto = makeAutomation({ nextRunAt: undefined });
		expect(isDue(auto, Date.now())).toBe(true);
	});

	it("returns true when past nextRunAt", () => {
		const auto = makeAutomation({
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		expect(isDue(auto, Date.now())).toBe(true);
	});

	it("returns false when before nextRunAt", () => {
		const auto = makeAutomation({
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

		const auto = makeAutomation({ nextRunAt });
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });

		// Spy on setTimeout
		const originalSetTimeout = globalThis.setTimeout;
		let capturedDelay = -1;
		globalThis.setTimeout = ((fn: Function, delay?: number) => {
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

	it("arms timer to 60s when next-due > 60s", () => {
		const nextRunAt = new Date(Date.now() + 120_000).toISOString(); // 2 minutes out

		const auto = makeAutomation({ nextRunAt });
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });

		const originalSetTimeout = globalThis.setTimeout;
		let capturedDelay = -1;
		globalThis.setTimeout = ((fn: Function, delay?: number) => {
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

	it("arms timer to 60s when no automations are due", () => {
		// No automations at all
		const defs = new Map<string, Automation>();
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });

		const originalSetTimeout = globalThis.setTimeout;
		let capturedDelay = -1;
		globalThis.setTimeout = ((fn: Function, delay?: number) => {
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
		const auto = makeAutomation({
			schedule: { type: "interval", intervalMs: 60_000 },
			lastRunAt: new Date(now - 60_001).toISOString(), // Just past due
			nextRunAt: new Date(now - 1).toISOString(), // Due now
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });

		scheduler.start();
		// Manually trigger the timer callback
		await scheduler.onTimer();
		scheduler.stop();

		expect(executor).toHaveBeenCalledTimes(1);
	});

	it("interval with no lastRunAt fires immediately", async () => {
		const auto = makeAutomation({
			schedule: { type: "interval", intervalMs: 60_000 },
			lastRunAt: undefined,
			nextRunAt: undefined, // Will be computed as "now" on start
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });

		scheduler.start();
		// After start(), nextRunAt should be set to approximately now
		const loaded = scheduler.getDefinitions().get(auto.id)!;
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
		const auto = makeAutomation({
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

	it("skips second run while first is active (per-automation guard)", async () => {
		const auto = makeAutomation({
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const { executor, resolve } = createBlockingExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
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

	it("global limit: 3rd run skipped when maxConcurrentRuns=2 and 2 are active", async () => {
		const auto1 = makeAutomation({
			id: "auto-1",
			name: "Auto 1",
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const auto2 = makeAutomation({
			id: "auto-2",
			name: "Auto 2",
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const auto3 = makeAutomation({
			id: "auto-3",
			name: "Auto 3",
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto1.id, auto1);
		defs.set(auto2.id, auto2);
		defs.set(auto3.id, auto3);
		saveDefinitions(defs, tmpDir);

		// Each automation gets its own blocking promise
		const promises: Array<{ resolve: (run: AutomationRun) => void }> = [];
		const callLog: string[] = [];
		const executor: Executor = mock(async (auto: Automation, _signal: AbortSignal) => {
			callLog.push(auto.id);
			return new Promise<AutomationRun>((resolve) => {
				promises.push({ resolve });
			});
		}) as Executor;

		const scheduler = new Scheduler(executor, {
			storeDir: tmpDir,
			maxConcurrentRuns: 2,
		});
		scheduler.start();

		// Fire onTimer (don't await — blocking executors)
		scheduler.onTimer();
		await new Promise((r) => setTimeout(r, 50));

		expect(callLog.length).toBe(2);
		expect(scheduler.getActiveRunIds().length).toBe(2);

		// Clean up
		for (const p of promises) {
			p.resolve(makeSuccessRun("any"));
		}
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

	it("after 1 failure, next run delayed by 30s", async () => {
		const auto = makeAutomation({
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const failRun = makeFailureRun(auto.id);
		const executor = createMockExecutor(failRun);
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.consecutiveErrors).toBe(1);
		const nextRunMs = new Date(updated.nextRunAt!).getTime();
		const expectedMin = Date.now() + 30_000 - 2000; // 2s tolerance
		expect(nextRunMs).toBeGreaterThanOrEqual(expectedMin);

		scheduler.stop();
	});

	it("after 3 failures, next run delayed by 5m", async () => {
		const auto = makeAutomation({
			consecutiveErrors: 2, // Already has 2 errors
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const failRun = makeFailureRun(auto.id);
		const executor = createMockExecutor(failRun);
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.consecutiveErrors).toBe(3);
		const nextRunMs = new Date(updated.nextRunAt!).getTime();
		const expectedMin = Date.now() + 300_000 - 2000;
		expect(nextRunMs).toBeGreaterThanOrEqual(expectedMin);

		scheduler.stop();
	});

	it("backoff resets to 0 on successful run", async () => {
		const auto = makeAutomation({
			consecutiveErrors: 3,
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const successRun = makeSuccessRun(auto.id);
		const executor = createMockExecutor(successRun);
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
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
		saveDefinitions(new Map(), tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		expect(scheduler.getDefinitions().size).toBe(0);

		// Add a new automation to the store externally
		const auto = makeAutomation({ id: "new-auto" });
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		// Reload should pick it up
		scheduler.reload();
		expect(scheduler.getDefinitions().size).toBe(1);
		expect(scheduler.getDefinitions().has("new-auto")).toBe(true);

		scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Tests: Scheduler — runNow
// ---------------------------------------------------------------------------

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
		const auto = makeAutomation({
			consecutiveErrors: 5, // In heavy backoff
			nextRunAt: futureTime,
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		const run = await scheduler.runNow(auto.id);

		expect(run).not.toBeNull();
		expect(run!.status).toBe("success");
		expect(executor).toHaveBeenCalledTimes(1);

		scheduler.stop();
	});

	it("runNow() returns null for unknown automation", async () => {
		saveDefinitions(new Map(), tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		const run = await scheduler.runNow("nonexistent");
		expect(run).toBeNull();

		scheduler.stop();
	});

	it("runNow() skips if automation is already running", async () => {
		const auto = makeAutomation({
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const { executor, resolve } = createBlockingExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		// Start a run via onTimer (don't await — executor blocks)
		scheduler.onTimer();
		await new Promise((r) => setTimeout(r, 50));
		expect(scheduler.getActiveRunIds()).toContain(auto.id);

		// runNow should skip
		const run = await scheduler.runNow(auto.id);
		expect(run).not.toBeNull();
		expect(run!.status).toBe("skipped");

		// Clean up
		resolve(makeSuccessRun(auto.id));
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
		const auto = makeAutomation({
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		let receivedSignal: AbortSignal | null = null;
		const executor: Executor = mock(async (_auto: Automation, signal: AbortSignal) => {
			receivedSignal = signal;
			// Block forever
			return new Promise<AutomationRun>(() => {});
		}) as Executor;

		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
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
		const auto = makeAutomation({
			runCount: 5,
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.runCount).toBe(6);

		scheduler.stop();
	});

	it("updates lastRunAt and lastRunStatus", async () => {
		const auto = makeAutomation({
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.lastRunAt).toBeDefined();
		expect(updated.lastRunStatus).toBe("success");

		scheduler.stop();
	});

	it("persists updated definitions to disk", async () => {
		const auto = makeAutomation({
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		await scheduler.onTimer();
		scheduler.stop();

		// Read from disk to verify persistence
		const persisted = loadDefinitions(tmpDir);
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

	beforeEach(() => { tmpDir = makeTmpDir(); });
	afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

	it("30-min interval automation with 1 error delays by 30min, not 30s", async () => {
		const auto = makeAutomation({
			schedule: { type: "interval", intervalMs: 1_800_000 }, // 30 min
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
			lastRunAt: new Date(Date.now() - 1_800_001).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const failRun = makeFailureRun(auto.id);
		const executor = createMockExecutor(failRun);
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.consecutiveErrors).toBe(1);
		const nextRunMs = new Date(updated.nextRunAt!).getTime();
		// Should be at least 30 min from now (not 30s)
		expect(nextRunMs - Date.now()).toBeGreaterThan(1_790_000);
		scheduler.stop();
	});

	it("1-min interval automation with 5 errors delays by 1hr (backoff > interval)", async () => {
		const auto = makeAutomation({
			schedule: { type: "interval", intervalMs: 60_000 }, // 1 min
			consecutiveErrors: 4,
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
			lastRunAt: new Date(Date.now() - 60_001).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const failRun = makeFailureRun(auto.id);
		const executor = createMockExecutor(failRun);
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.consecutiveErrors).toBe(5);
		const nextRunMs = new Date(updated.nextRunAt!).getTime();
		// Should be at least 1hr (3_600_000ms) from now
		expect(nextRunMs - Date.now()).toBeGreaterThan(3_590_000);
		scheduler.stop();
	});

	it("success resets to natural interval regardless of previous errors", async () => {
		const auto = makeAutomation({
			schedule: { type: "interval", intervalMs: 1_800_000 },
			consecutiveErrors: 5,
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
			lastRunAt: new Date(Date.now() - 1_800_001).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor(); // success
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.consecutiveErrors).toBe(0);
		scheduler.stop();
	});

	it("cron automation with 1 error delays to next cron occurrence, not 30s", async () => {
		// Daily at 8am HST — next occurrence is hours away, far longer than 30s backoff
		const auto = makeAutomation({
			schedule: { type: "cron", expression: "0 8 * * *", timezone: "Pacific/Honolulu" },
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const failRun = makeFailureRun(auto.id);
		const executor = createMockExecutor(failRun);
		const scheduler = new Scheduler(executor, { storeDir: tmpDir, defaultTimezone: "Pacific/Honolulu" });
		scheduler.start();
		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.consecutiveErrors).toBe(1);
		const nextRunMs = new Date(updated.nextRunAt!).getTime();
		// Next 8am is at least 1 hour away (unless test runs exactly at 7:59am HST)
		// Backoff of 30s should NOT win — natural cron time should
		expect(nextRunMs - Date.now()).toBeGreaterThan(60_000); // at least 1 min, proving backoff didn't win
		scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Tests: Skipped runs advance nextRunAt
// ---------------------------------------------------------------------------

describe("Scheduler — skipped runs advance nextRunAt", () => {
	let tmpDir: string;

	beforeEach(() => { tmpDir = makeTmpDir(); });
	afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

	it("after skip, automation is no longer due for next interval", async () => {
		const auto = makeAutomation({
			id: "auto-skip-test",
			schedule: { type: "interval", intervalMs: 1_800_000 },
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
			lastRunAt: new Date(Date.now() - 1_800_001).toISOString(),
		});
		// Also create a blocking automation to trigger the skip
		const blocking = makeAutomation({
			id: "auto-blocker",
			name: "Blocker",
			nextRunAt: new Date(Date.now() - 2000).toISOString(),
			lastRunAt: new Date(Date.now() - 60_001).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(blocking.id, blocking);
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		// Block on the first automation, skip the second
		let resolveBlock!: (run: AutomationRun) => void;
		const blockPromise = new Promise<AutomationRun>((r) => { resolveBlock = r; });
		let callCount = 0;
		const executor: Executor = mock(async (a: Automation, _signal: AbortSignal) => {
			callCount++;
			if (a.id === "auto-blocker") return blockPromise;
			return makeSuccessRun(a.id);
		}) as Executor;

		const scheduler = new Scheduler(executor, { storeDir: tmpDir, maxConcurrentRuns: 1 });
		scheduler.start();

		// First timer: dispatches blocker, skips auto-skip-test (don't await — blocker blocks)
		scheduler.onTimer();
		await new Promise((r) => setTimeout(r, 50));

		// Check that the skipped automation's nextRunAt was advanced into the future
		const updated = scheduler.getDefinitions().get("auto-skip-test")!;
		expect(updated.nextRunAt).toBeDefined();
		const nextMs = new Date(updated.nextRunAt!).getTime();
		// Should be ~30 min in the future (now + intervalMs since old nextRunAt was past)
		expect(nextMs).toBeGreaterThan(Date.now() + 1_700_000);

		resolveBlock(makeSuccessRun("auto-blocker"));
		scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Tests: Auto-disable after consecutive errors
// ---------------------------------------------------------------------------

describe("Scheduler — auto-disable", () => {
	let tmpDir: string;

	beforeEach(() => { tmpDir = makeTmpDir(); });
	afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

	it("9 consecutive errors does not auto-disable", async () => {
		const auto = makeAutomation({
			consecutiveErrors: 8,
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor(makeFailureRun(auto.id));
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.consecutiveErrors).toBe(9);
		expect(updated.enabled).toBe(true);
		expect(updated.disabledAt).toBeUndefined();
		scheduler.stop();
	});

	it("10 consecutive errors triggers auto-disable", async () => {
		const auto = makeAutomation({
			consecutiveErrors: 9,
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor(makeFailureRun(auto.id, "HTTP 401 Unauthorized"));
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.consecutiveErrors).toBe(10);
		expect(updated.enabled).toBe(false);
		expect(updated.disabledAt).toBeDefined();
		expect(updated.disabledReason).toContain("10 consecutive failures");
		expect(updated.disabledReason).toContain("HTTP 401");
		scheduler.stop();
	});

	it("auto-disabled automation does not fire on next timer tick", async () => {
		const auto = makeAutomation({
			enabled: false,
			disabledAt: new Date().toISOString(),
			disabledReason: "Auto-disabled after 10 consecutive failures",
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
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

	beforeEach(() => { tmpDir = makeTmpDir(); });
	afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

	it("cancelRun on active automation returns true and aborts", async () => {
		const auto = makeAutomation({
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		let receivedSignal: AbortSignal | null = null;
		const executor: Executor = mock(async (_auto: Automation, signal: AbortSignal) => {
			receivedSignal = signal;
			return new Promise<AutomationRun>(() => {}); // block forever
		}) as Executor;

		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		scheduler.onTimer(); // don't await — executor blocks
		await new Promise((r) => setTimeout(r, 50));

		expect(scheduler.getActiveRunIds()).toContain(auto.id);
		const result = scheduler.cancelRun(auto.id);
		expect(result).toBe(true);
		expect(receivedSignal!.aborted).toBe(true);

		scheduler.stop();
	});

	it("cancelRun on idle automation returns false", () => {
		const auto = makeAutomation({
			nextRunAt: new Date(Date.now() + 999_999).toISOString(), // not due
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, makeTmpDir());

		const executor = createMockExecutor();
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		const result = scheduler.cancelRun(auto.id);
		expect(result).toBe(false);
		scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Tests: Cumulative token tracking
// ---------------------------------------------------------------------------

describe("Scheduler — cumulative token tracking", () => {
	let tmpDir: string;

	beforeEach(() => { tmpDir = makeTmpDir(); });
	afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

	it("increments cumulative tokens after each run", async () => {
		const auto = makeAutomation({
			cumulativeInputTokens: 500,
			cumulativeOutputTokens: 100,
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const run = makeSuccessRun(auto.id);
		run.inputTokens = 1000;
		run.outputTokens = 200;
		const executor = createMockExecutor(run);
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.cumulativeInputTokens).toBe(1500);
		expect(updated.cumulativeOutputTokens).toBe(300);
		scheduler.stop();
	});

	it("auto-disables when token budget exceeded", async () => {
		const auto = makeAutomation({
			cumulativeInputTokens: 4500,
			cumulativeOutputTokens: 0,
			tokenBudget: { maxInputTokens: 5000 },
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const run = makeSuccessRun(auto.id);
		run.inputTokens = 1000; // 4500 + 1000 = 5500 > 5000
		const executor = createMockExecutor(run);
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.enabled).toBe(false);
		expect(updated.disabledReason).toContain("Token budget exceeded");
		scheduler.stop();
	});

	it("resets cumulative counters when budgetResetAt is in the past", async () => {
		const auto = makeAutomation({
			cumulativeInputTokens: 50_000,
			cumulativeOutputTokens: 5_000,
			tokenBudget: { maxInputTokens: 100_000, period: "daily" },
			budgetResetAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const run = makeSuccessRun(auto.id);
		run.inputTokens = 1000;
		run.outputTokens = 200;
		const executor = createMockExecutor(run);
		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();
		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
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
