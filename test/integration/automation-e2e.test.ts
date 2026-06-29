/**
 * End-to-end integration tests for the automation lifecycle.
 *
 * Tests the full flow: create automation -> trigger via `run` handler ->
 * verify run history shows success -> verify executor was called with
 * correct metadata structure.
 *
 * Uses the exported tool handler functions directly with a test harness
 * that wires up the workspace-owned store, the scheduler, and a mock executor.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "../../src/bundles/automations/src/scheduler.ts";
import {
	handleCreate,
	handleRun,
	handleRuns,
	handleStatus,
	type ToolContext,
} from "../../src/bundles/automations/src/server.ts";
import {
	deleteAutomationDefinition,
	loadOwnerAutomations,
	readAllRuns,
	readRunResult,
	readRuns,
	saveAutomation,
} from "../../src/bundles/automations/src/store.ts";
import type {
	Automation,
	AutomationRun,
	AutomationRunResult,
} from "../../src/bundles/automations/src/types.ts";
import type { AutomationsRunOutput } from "../../src/tools/platform/schemas/automations.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(tmpdir(), `automation-e2e-${Date.now()}`);
// Automations are workspace-owned: stored at
// `{workDir}/workspaces/<wsId>/automations/<ownerId>/`, the scheduler scans
// `{workDir}/workspaces/*`. The harness acts as one workspace + owner.
const WS = "ws_test";
const OWNER = "usr_test";

/** Records of what the mock executor received. */
let executorCalls: Array<{ automation: Automation; signal: AbortSignal; trigger: string }>;

/** Configurable executor result. */
let executorResult: (auto: Automation) => AutomationRun;

function defaultExecutorResult(auto: Automation): AutomationRun {
	return {
		id: `run_${crypto.randomUUID().slice(0, 12)}`,
		automationId: auto.id,
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		status: "success",
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

function loadDefs(): Map<string, Automation> {
	return loadOwnerAutomations(TMP_DIR, WS, OWNER);
}

function saveDefs(map: Map<string, Automation>): void {
	const onDisk = loadOwnerAutomations(TMP_DIR, WS, OWNER);
	for (const auto of map.values()) {
		if (!auto.workspaceId) auto.workspaceId = WS;
		if (!auto.ownerId) auto.ownerId = OWNER;
		saveAutomation(TMP_DIR, WS, OWNER, auto);
	}
	for (const id of onDisk.keys()) {
		if (!map.has(id)) deleteAutomationDefinition(TMP_DIR, WS, OWNER, id);
	}
}

function createHarness(): ToolContext {
	executorCalls = [];
	executorResult = defaultExecutorResult;

	const executor = async (
		automation: Automation,
		signal: AbortSignal,
		trigger: string,
	): Promise<{ run: AutomationRun; result: AutomationRunResult | null }> => {
		executorCalls.push({ automation, signal, trigger });
		const run = executorResult(automation);
		const result: AutomationRunResult = {
			runId: run.id,
			automationId: automation.id,
			completedAt: run.completedAt ?? new Date().toISOString(),
			output: run.resultPreview ?? "",
			activityLog: [],
			outputFiles: [],
			usage: {
				inputTokens: run.inputTokens,
				outputTokens: run.outputTokens,
				iterations: run.iterations,
			},
			stopReason: run.stopReason,
		};
		// The scheduler (updateAfterRun) persists the run summary + result sidecar.
		return { run, result };
	};

	scheduler = new Scheduler(executor, {
		workDir: TMP_DIR,
		defaultTimezone: "Pacific/Honolulu",
	});
	scheduler.start();

	return {
		definitions: () => loadDefs(),
		save: (defs) => saveDefs(defs),
		reloadScheduler: () => scheduler.reload(),
		runNow: (id) => scheduler.runNow(WS, OWNER, id),
		cancelRun: (id) => scheduler.cancelRun(WS, OWNER, id),
		readRuns: (id, opts) => readRuns(TMP_DIR, WS, OWNER, id, opts),
		readAllRuns: (opts) => readAllRuns(TMP_DIR, WS, OWNER, opts),
		readRunResult: (id, runId) => readRunResult(TMP_DIR, WS, OWNER, id, runId),
		defaultTimezone: "Pacific/Honolulu",
		currentUserId: OWNER,
		currentWorkspaceId: WS,
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

		const run = expectSyncRun(await handleRun({ name: "Daily Summary" }, ctx));
		expect(run.status).toBe("success");
		expect(run.automationId).toBe("daily-summary");

		const runsResult = handleRuns(
			{ automationId: "daily-summary" },
			ctx,
		) as { runs: AutomationRun[]; total: number };

		expect(runsResult.total).toBeGreaterThanOrEqual(1);
		const latestRun = runsResult.runs[0]!;
		expect(latestRun.status).toBe("success");
		expect(latestRun.toolCalls).toBe(3);
		expect(latestRun.iterations).toBe(2);
		// A run is no longer a conversation — it leaves a result sidecar instead.
		const result = ctx.readRunResult("daily-summary", latestRun.id);
		expect(result).not.toBeNull();
		expect(result!.usage.iterations).toBe(2);
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

		expect(executorCalls[0]!.signal.aborted).toBe(false);

		// The `run` tool is a user-triggered (manual) dispatch.
		expect(executorCalls[0]!.trigger).toBe("manual");
	});

	test("allowedTools passed through to executor when set on the stored automation", async () => {
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
			id: `run_${crypto.randomUUID().slice(0, 12)}`,
			automationId: auto.id,
			startedAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
			status: "success",
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

		const beforeStatus = handleStatus({ name: "Status Check" }, ctx) as {
			automation: Automation;
		};
		expect(beforeStatus.automation.runCount).toBe(0);
		expect(beforeStatus.automation.lastRunStatus).toBeUndefined();

		await handleRun({ name: "Status Check" }, ctx);

		// After run: scheduler.updateAfterRun updates the definition on disk.
		const updated = loadDefs().get("status-check")!;
		expect(updated.runCount).toBe(1);
		expect(updated.lastRunStatus).toBe("success");
		expect(updated.consecutiveErrors).toBe(0);
	});
});
