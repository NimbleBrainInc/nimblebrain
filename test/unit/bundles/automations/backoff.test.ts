/**
 * Backoff behavior tests for the automation scheduler.
 *
 * Verifies exponential backoff delays after consecutive failures,
 * reset on success, transient vs non-transient error classification,
 * and that backoff-delayed automations are not executed prematurely.
 *
 * Uses time manipulation (not real waits) via direct scheduler state
 * and the exported helper functions.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Automation, AutomationRun } from "../../../../src/bundles/automations/src/types.ts";
import {
	Scheduler,
	backoffDelay,
	isTransientError,
	isInBackoff,
	type Executor,
} from "../../../../src/bundles/automations/src/scheduler.ts";
import {
	saveDefinitions,
	loadDefinitions,
	readRuns,
} from "../../../../src/bundles/automations/src/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "backoff-test-"));
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
	return {
		id: "backoff-test",
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

function makeFailureRun(
	automationId: string,
	error = "Something broke",
): AutomationRun {
	return {
		id: `run_fail_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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

function makeSuccessRun(automationId: string): AutomationRun {
	return {
		id: `run_ok_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
		automationId,
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
		// 1-min interval automation. Backoff uses max(backoff, naturalInterval):
		// Failure 1: max(30s, 60s) = 60s
		// Failure 2: max(60s, 60s) = 60s
		// Failure 3: max(300s, 60s) = 300s
		const auto = makeAutomation({
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
			lastRunAt: new Date(Date.now() - 60_001).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		let failCount = 0;
		const executor: Executor = mock(
			async (a: Automation, _signal: AbortSignal) => {
				failCount++;
				return makeFailureRun(a.id, `Failure #${failCount}`);
			},
		) as Executor;

		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		// --- Failure 1 ---
		await scheduler.onTimer();
		let updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.consecutiveErrors).toBe(1);
		const nextAfter1 = new Date(updated.nextRunAt!).getTime();
		// Should be ~60s from now (natural interval > 30s backoff)
		expect(nextAfter1).toBeGreaterThanOrEqual(Date.now() + 58_000);
		expect(nextAfter1).toBeLessThanOrEqual(Date.now() + 62_000);

		// --- Failure 2: manually set nextRunAt to past so it fires ---
		updated.nextRunAt = new Date(Date.now() - 1).toISOString();
		saveDefinitions(scheduler.getDefinitions(), tmpDir);
		scheduler.reload();

		await scheduler.onTimer();
		updated = scheduler.getDefinitions().get(auto.id)!;
		expect(updated.consecutiveErrors).toBe(2);
		const nextAfter2 = new Date(updated.nextRunAt!).getTime();
		// Should be ~60s from now (natural interval = 60s backoff)
		expect(nextAfter2).toBeGreaterThanOrEqual(Date.now() + 58_000);
		expect(nextAfter2).toBeLessThanOrEqual(Date.now() + 62_000);

		// --- Failure 3: manually set nextRunAt to past ---
		updated.nextRunAt = new Date(Date.now() - 1).toISOString();
		saveDefinitions(scheduler.getDefinitions(), tmpDir);
		scheduler.reload();

		await scheduler.onTimer();
		updated = scheduler.getDefinitions().get(auto.id)!;
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
		const auto = makeAutomation({
			consecutiveErrors: 3,
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor: Executor = mock(
			async (a: Automation, _signal: AbortSignal) => makeSuccessRun(a.id),
		) as Executor;

		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		await scheduler.onTimer();

		const updated = scheduler.getDefinitions().get(auto.id)!;
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
// Backoff-delayed automation is not executed before backoff expires
// ---------------------------------------------------------------------------

describe("backoff prevents premature execution", () => {
	test("automation in backoff period is skipped by onTimer", async () => {
		// Set up an automation with 2 errors and nextRunAt 60s in the future
		const auto = makeAutomation({
			consecutiveErrors: 2,
			nextRunAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor: Executor = mock(
			async (a: Automation, _signal: AbortSignal) => makeSuccessRun(a.id),
		) as Executor;

		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		// Fire the timer — should NOT execute because of backoff
		await scheduler.onTimer();

		expect(executor).toHaveBeenCalledTimes(0);

		scheduler.stop();
	});

	test("automation executes after backoff period expires", async () => {
		// Set nextRunAt to the past (backoff has expired)
		const auto = makeAutomation({
			consecutiveErrors: 1,
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		const defs = new Map<string, Automation>();
		defs.set(auto.id, auto);
		saveDefinitions(defs, tmpDir);

		const executor: Executor = mock(
			async (a: Automation, _signal: AbortSignal) => makeSuccessRun(a.id),
		) as Executor;

		const scheduler = new Scheduler(executor, { storeDir: tmpDir });
		scheduler.start();

		await scheduler.onTimer();

		// Should have executed since backoff period is past
		expect(executor).toHaveBeenCalledTimes(1);

		scheduler.stop();
	});

	test("isInBackoff correctly identifies active backoff", () => {
		const futureAuto = makeAutomation({
			consecutiveErrors: 2,
			nextRunAt: new Date(Date.now() + 60_000).toISOString(),
		});
		expect(isInBackoff(futureAuto, Date.now())).toBe(true);

		const pastAuto = makeAutomation({
			consecutiveErrors: 2,
			nextRunAt: new Date(Date.now() - 1000).toISOString(),
		});
		expect(isInBackoff(pastAuto, Date.now())).toBe(false);

		const noErrorAuto = makeAutomation({
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
		expect(backoffDelay(1)).toBe(30_000);   // 30s
		expect(backoffDelay(2)).toBe(60_000);   // 1m
		expect(backoffDelay(3)).toBe(300_000);  // 5m
		expect(backoffDelay(4)).toBe(900_000);  // 15m
		expect(backoffDelay(5)).toBe(3_600_000); // 1h
		expect(backoffDelay(6)).toBe(3_600_000); // capped at 1h
		expect(backoffDelay(50)).toBe(3_600_000); // still capped
	});
});
