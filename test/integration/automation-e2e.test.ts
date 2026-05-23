/**
 * End-to-end integration tests for the automation lifecycle.
 *
 * Tests the full flow: create automation -> trigger via `run` handler ->
 * verify run history shows success -> verify executor was called with
 * correct metadata structure.
 *
 * Uses the exported tool handler functions directly with a test harness
 * that wires up store, scheduler, and mock executor.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
	Automation,
	AutomationRun,
} from "../../src/bundles/automations/src/types.ts";
import {
	loadDefinitions,
	saveDefinitions,
	appendRun,
	readRuns,
} from "../../src/bundles/automations/src/store.ts";
import { Scheduler } from "../../src/bundles/automations/src/scheduler.ts";
import {
	handleCreate,
	handleList,
	handleRun,
	handleRuns,
	handleStatus,
	type ToolContext,
} from "../../src/bundles/automations/src/server.ts";
import type { AutomationsRunOutput } from "../../src/tools/platform/schemas/automations.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(tmpdir(), `automation-e2e-${Date.now()}`);

/** Records of what the mock executor received. */
let executorCalls: Array<{ automation: Automation; signal: AbortSignal }>;

/** Configurable executor result. */
let executorResult: (auto: Automation) => AutomationRun;

function defaultExecutorResult(auto: Automation): AutomationRun {
	return {
		id: `run_${crypto.randomUUID().slice(0, 12)}`,
		automationId: auto.id,
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		status: "success",
		conversationId: `conv_${auto.id}`,
		inputTokens: 150,
		outputTokens: 80,
		toolCalls: 3,
		iterations: 2,
		resultPreview: "Automation completed successfully.",
		stopReason: "complete",
	};
}

let scheduler: Scheduler;

/**
 * `handleRun` returns a discriminated union — see `AutomationsRunOutput`.
 * Integration tests using the fast in-process executor always expect
 * the synchronous `{ run }` shape; this helper narrows + asserts that
 * explicitly so a future test with a slow executor doesn't silently
 * drop into the "dispatched" branch and pass on undefined dereferences.
 */
function expectSyncRun(result: AutomationsRunOutput): AutomationRun {
	if ("run" in result) return result.run;
	throw new Error(
		`expected handleRun to return synchronously with { run }, got ${JSON.stringify(result)}`,
	);
}

function createHarness(): ToolContext {
	executorCalls = [];
	executorResult = defaultExecutorResult;

	const executor = async (
		automation: Automation,
		signal: AbortSignal,
	): Promise<AutomationRun> => {
		executorCalls.push({ automation, signal });
		const run = executorResult(automation);
		appendRun(automation.id, run, TMP_DIR);
		return run;
	};

	scheduler = new Scheduler(executor, {
		storeDir: TMP_DIR,
		defaultTimezone: "Pacific/Honolulu",
	});
	scheduler.start();

	return {
		definitions: () => loadDefinitions(TMP_DIR),
		save: (defs) => saveDefinitions(defs, TMP_DIR),
		reloadScheduler: () => scheduler.reload(),
		runNow: (id) => scheduler.runNow(id),
		storeDir: TMP_DIR,
		defaultTimezone: "Pacific/Honolulu",
	};
}

beforeEach(() => {
	mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
	scheduler?.stop();
	rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// E2E: create -> run -> verify run history
// ---------------------------------------------------------------------------

describe("automation e2e: create -> run -> verify", () => {
	test("create automation, trigger via run handler, run history shows success", async () => {
		const ctx = createHarness();

		// Step 1: Create automation
		const createResult = handleCreate(
			{
				manifest: {
					name: "Daily Summary",
					schedule: { type: "cron", expression: "0 8 * * *", timezone: "Pacific/Honolulu" },
					description: "Generates a daily activity summary",
				},
				body: "Summarize today's activity",
			},
			ctx,
		) as { automation: Automation; created: boolean };

		expect(createResult.created).toBe(true);
		expect(createResult.automation.id).toBe("daily-summary");

		// Step 2: Trigger via run handler
		const run = expectSyncRun(await handleRun({ name: "Daily Summary" }, ctx));
		// `handleRun` is typed as AutomationsRunOutput; expectSyncRun narrows
		// to the synchronous-completion shape for this fast-executor test.

		expect(run.status).toBe("success");
		expect(run.automationId).toBe("daily-summary");

		// Step 3: Verify run history
		const runsResult = handleRuns(
			{ automationId: "daily-summary" },
			ctx,
		) as { runs: AutomationRun[]; total: number };

		expect(runsResult.total).toBeGreaterThanOrEqual(1);
		const latestRun = runsResult.runs[0]!;
		expect(latestRun.status).toBe("success");
		expect(latestRun.conversationId).toContain("conv_");
		expect(latestRun.toolCalls).toBe(3);
		expect(latestRun.iterations).toBe(2);
	});

	test("create automation, trigger, executor receives correct metadata structure", async () => {
		const ctx = createHarness();

		handleCreate(
			{
				manifest: {
					name: "Weekly Report",
					schedule: { type: "interval", intervalMs: 3_600_000 },
					description: "Compiles weekly metrics",
					skill: "reporting",
					maxIterations: 8,
					maxInputTokens: 100_000,
					model: "claude-sonnet-4-5-20250929",
				},
				body: "Generate the weekly report",
			},
			ctx,
		);

		await handleRun({ name: "Weekly Report" }, ctx);

		// Verify the executor received the full automation object
		expect(executorCalls.length).toBe(1);
		const received = executorCalls[0]!.automation;
		expect(received.id).toBe("weekly-report");
		expect(received.name).toBe("Weekly Report");
		expect(received.prompt).toBe("Generate the weekly report");
		expect(received.skill).toBe("reporting");
		expect(received.maxIterations).toBe(8);
		expect(received.maxInputTokens).toBe(100_000);
		expect(received.model).toBe("claude-sonnet-4-5-20250929");
		expect(received.schedule.type).toBe("interval");
		expect(received.schedule.intervalMs).toBe(3_600_000);

		// Signal should not be aborted
		expect(executorCalls[0]!.signal.aborted).toBe(false);
	});

	test("allowedTools passed through to executor when set on the stored automation", async () => {
		// `allowedTools` is no longer in the LLM-facing schema (it's a
		// leaky literal-tool-name affinity). Operators set it by directly
		// editing the stored Automation. This test seeds the store
		// directly to exercise the executor pass-through behavior.
		const ctx = createHarness();

		handleCreate(
			{
				manifest: {
					name: "Scoped Automation",
					schedule: { type: "interval", intervalMs: 120_000 },
				},
				body: "Do scoped work",
			},
			ctx,
		);
		const defs = ctx.definitions();
		defs.get("scoped-automation")!.allowedTools = [
			"files__*",
			"reports__generate",
			"analytics__*",
		];
		ctx.save(defs);

		await handleRun({ name: "Scoped Automation" }, ctx);

		expect(executorCalls.length).toBe(1);
		const received = executorCalls[0]!.automation;
		expect(received.allowedTools).toEqual([
			"files__*",
			"reports__generate",
			"analytics__*",
		]);
	});
});

// ---------------------------------------------------------------------------
// E2E: run records tool count and iterations
// ---------------------------------------------------------------------------

describe("automation e2e: run records metrics", () => {
	test("run records tool count and iterations from executor result", async () => {
		const ctx = createHarness();

		executorResult = (auto: Automation): AutomationRun => ({
			id: `run_metrics_test`,
			automationId: auto.id,
			startedAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
			status: "success",
			conversationId: "conv_metrics",
			inputTokens: 500,
			outputTokens: 200,
			toolCalls: 7,
			iterations: 4,
			resultPreview: "Used 7 tools across 4 iterations.",
			stopReason: "complete",
		});

		handleCreate(
			{
				manifest: {
					name: "Multi Tool Job",
					schedule: { type: "interval", intervalMs: 60_000 },
				},
				body: "Use many tools",
			},
			ctx,
		);

		const run = expectSyncRun(await handleRun({ name: "Multi Tool Job" }, ctx));

		expect(run.toolCalls).toBe(7);
		expect(run.iterations).toBe(4);
		expect(run.inputTokens).toBe(500);
		expect(run.outputTokens).toBe(200);
	});

	test("status shows updated runCount and lastRunStatus after run", async () => {
		const ctx = createHarness();

		handleCreate(
			{
				manifest: {
					name: "Status Check",
					schedule: { type: "interval", intervalMs: 60_000 },
				},
				body: "Check status",
			},
			ctx,
		);

		// Before run
		const beforeStatus = handleStatus({ name: "Status Check" }, ctx) as {
			automation: Automation;
		};
		expect(beforeStatus.automation.runCount).toBe(0);
		expect(beforeStatus.automation.lastRunStatus).toBeUndefined();

		// Run it
		await handleRun({ name: "Status Check" }, ctx);

		// After run: scheduler.updateAfterRun updates the definition
		const afterDefs = loadDefinitions(TMP_DIR);
		const updated = afterDefs.get("status-check")!;
		expect(updated.runCount).toBe(1);
		expect(updated.lastRunStatus).toBe("success");
		expect(updated.consecutiveErrors).toBe(0);
	});
});
