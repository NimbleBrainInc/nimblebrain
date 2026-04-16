import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
	Automation,
	AutomationRun,
} from "../../../../src/bundles/automations/src/types.ts";
import {
	loadDefinitions,
	saveDefinitions,
	appendRun,
} from "../../../../src/bundles/automations/src/store.ts";
import {
	formatSchedule,
	formatRelativeTime,
	toKebabCase,
	handleCreate,
	handleUpdate,
	handleDelete,
	handleList,
	handleStatus,
	handleRuns,
	handleRun,
	handleCancel,
	validateAutomationFields,
	type ToolContext,
} from "../../../../src/bundles/automations/src/server.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(import.meta.dir, ".tmp-automation-server");

let savedDefs: Map<string, Automation>;
let schedulerReloaded: boolean;

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
	savedDefs = loadDefinitions(TMP_DIR);
	schedulerReloaded = false;

	return {
		definitions: () => loadDefinitions(TMP_DIR),
		save: (defs) => {
			saveDefinitions(defs, TMP_DIR);
			savedDefs = defs;
		},
		reloadScheduler: () => {
			schedulerReloaded = true;
		},
		runNow: async (automationId: string): Promise<AutomationRun | null> => {
			const defs = loadDefinitions(TMP_DIR);
			const auto = defs.get(automationId);
			if (!auto) return null;
			const run: AutomationRun = {
				id: `run_test_${Date.now()}`,
				automationId,
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				status: "success",
				inputTokens: 100,
				outputTokens: 50,
				toolCalls: 2,
				iterations: 1,
				resultPreview: "Test run completed",
			};
			appendRun(automationId, run, TMP_DIR);
			return run;
		},
		cancelRun: (_automationId: string) => false,
		storeDir: TMP_DIR,
		defaultTimezone: "Pacific/Honolulu",
		...overrides,
	};
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
	return {
		id: `run_${Math.random().toString(36).slice(2, 8)}`,
		automationId: "daily-report",
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		status: "success",
		inputTokens: 100,
		outputTokens: 50,
		toolCalls: 2,
		iterations: 1,
		...overrides,
	};
}

beforeEach(() => {
	mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// formatSchedule
// ---------------------------------------------------------------------------

describe("formatSchedule", () => {
	test("interval in minutes", () => {
		expect(formatSchedule({ type: "interval", intervalMs: 1_800_000 })).toBe(
			"Every 30 minutes",
		);
	});

	test("interval in hours", () => {
		expect(formatSchedule({ type: "interval", intervalMs: 7_200_000 })).toBe(
			"Every 2 hours",
		);
	});

	test("daily cron", () => {
		expect(
			formatSchedule({
				type: "cron",
				expression: "0 8 * * *",
				timezone: "Pacific/Honolulu",
			}),
		).toBe("Daily at 8:00 AM HST");
	});

	test("weekly cron (Monday)", () => {
		expect(
			formatSchedule({
				type: "cron",
				expression: "0 9 * * 1",
				timezone: "Pacific/Honolulu",
			}),
		).toBe("Mondays at 9:00 AM HST");
	});

	test("every N minutes cron", () => {
		expect(
			formatSchedule({ type: "cron", expression: "*/30 * * * *" }),
		).toBe("Every 30 minutes");
	});

	test("single minute interval", () => {
		expect(formatSchedule({ type: "interval", intervalMs: 60_000 })).toBe(
			"Every 1 minute",
		);
	});
});

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

describe("formatRelativeTime", () => {
	const now = new Date("2025-06-15T12:00:00.000Z").getTime();

	test("past hours", () => {
		const twoHoursAgo = new Date(now - 2 * 3_600_000).toISOString();
		expect(formatRelativeTime(twoHoursAgo, now)).toBe("2h ago");
	});

	test("future hours", () => {
		const inTwentyTwoHours = new Date(now + 22 * 3_600_000).toISOString();
		expect(formatRelativeTime(inTwentyTwoHours, now)).toBe("in 22h");
	});

	test("past days", () => {
		const threeDaysAgo = new Date(now - 3 * 86_400_000).toISOString();
		expect(formatRelativeTime(threeDaysAgo, now)).toBe("3d ago");
	});

	test("past minutes", () => {
		const fiveMinAgo = new Date(now - 5 * 60_000).toISOString();
		expect(formatRelativeTime(fiveMinAgo, now)).toBe("5m ago");
	});

	test("future minutes", () => {
		const inTenMin = new Date(now + 10 * 60_000).toISOString();
		expect(formatRelativeTime(inTenMin, now)).toBe("in 10m");
	});
});

// ---------------------------------------------------------------------------
// toKebabCase
// ---------------------------------------------------------------------------

describe("toKebabCase", () => {
	test("converts spaces", () => {
		expect(toKebabCase("Daily Report")).toBe("daily-report");
	});

	test("strips special chars", () => {
		expect(toKebabCase("My Automation!@#$%")).toBe("my-automation");
	});

	test("handles multiple spaces", () => {
		expect(toKebabCase("  hello   world  ")).toBe("hello-world");
	});
});

// ---------------------------------------------------------------------------
// create tool
// ---------------------------------------------------------------------------

describe("handleCreate", () => {
	test("creates automation with defaults", () => {
		const ctx = makeCtx();
		const result = handleCreate(
			{
				name: "Daily Report",
				prompt: "Generate daily report",
				schedule: { type: "cron", expression: "0 8 * * *", timezone: "Pacific/Honolulu" },
			},
			ctx,
		) as { automation: Automation; created: boolean };

		expect(result.created).toBe(true);
		expect(result.automation.id).toBe("daily-report");
		expect(result.automation.name).toBe("Daily Report");
		expect(result.automation.enabled).toBe(true);
		expect(result.automation.source).toBe("agent");
		expect(result.automation.runCount).toBe(0);
		expect(result.automation.consecutiveErrors).toBe(0);
		expect(result.automation.createdAt).toBeDefined();
		expect(result.automation.updatedAt).toBeDefined();
		expect(schedulerReloaded).toBe(true);
	});

	test("idempotent — returns existing for duplicate name", () => {
		const ctx = makeCtx();
		const first = handleCreate(
			{
				name: "Daily Report",
				prompt: "Generate daily report",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		) as { automation: Automation; created: boolean };

		expect(first.created).toBe(true);

		const second = handleCreate(
			{
				name: "Daily Report",
				prompt: "Different prompt",
				schedule: { type: "interval", intervalMs: 120_000 },
			},
			ctx,
		) as { automation: Automation; created: boolean };

		expect(second.created).toBe(false);
		expect(second.automation.id).toBe(first.automation.id);
		expect(second.automation.prompt).toBe("Generate daily report"); // original prompt
	});

	test("rejects recursive allowedTools (automations__create)", () => {
		const ctx = makeCtx();
		expect(() =>
			handleCreate(
				{
					name: "Recursive",
					prompt: "Bad",
					schedule: { type: "interval", intervalMs: 60_000 },
					allowedTools: ["automations__create"],
				},
				ctx,
			),
		).toThrow("Recursive prevention");
	});

	test("rejects recursive allowedTools (automations__update)", () => {
		const ctx = makeCtx();
		expect(() =>
			handleCreate(
				{
					name: "Recursive",
					prompt: "Bad",
					schedule: { type: "interval", intervalMs: 60_000 },
					allowedTools: ["some_tool", "automations__update"],
				},
				ctx,
			),
		).toThrow("Recursive prevention");
	});

	test("rejects missing required fields", () => {
		const ctx = makeCtx();
		expect(() =>
			handleCreate({ name: "No prompt" } as Record<string, unknown>, ctx),
		).toThrow("Missing required fields");
	});
});

// ---------------------------------------------------------------------------
// create → list integration
// ---------------------------------------------------------------------------

describe("create → list", () => {
	test("created automation appears in list", () => {
		const ctx = makeCtx();
		handleCreate(
			{
				name: "Daily Report",
				prompt: "Generate daily report",
				schedule: { type: "interval", intervalMs: 1_800_000 },
			},
			ctx,
		);

		const result = handleList({}, ctx) as {
			automations: Array<{ id: string; name: string; schedule: string }>;
			total: number;
		};

		expect(result.total).toBe(1);
		expect(result.automations[0]!.name).toBe("Daily Report");
		expect(result.automations[0]!.schedule).toBe("Every 30 minutes");
	});
});

// ---------------------------------------------------------------------------
// update tool
// ---------------------------------------------------------------------------

describe("handleUpdate", () => {
	test("updates enabled status", () => {
		const ctx = makeCtx();
		handleCreate(
			{
				name: "Daily Report",
				prompt: "Generate report",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		);

		const result = handleUpdate(
			{ name: "Daily Report", enabled: false },
			ctx,
		) as { automation: Automation; updated: boolean };

		expect(result.updated).toBe(true);
		expect(result.automation.enabled).toBe(false);

		// Verify reflected in list
		const listResult = handleList({}, ctx) as {
			automations: Array<{ enabled: boolean }>;
		};
		expect(listResult.automations[0]!.enabled).toBe(false);
	});

	test("updates schedule and reloads scheduler", () => {
		const ctx = makeCtx();
		handleCreate(
			{
				name: "My Task",
				prompt: "Do it",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		);

		schedulerReloaded = false;
		handleUpdate(
			{
				name: "My Task",
				schedule: { type: "cron", expression: "0 9 * * 1", timezone: "Pacific/Honolulu" },
			},
			ctx,
		);

		expect(schedulerReloaded).toBe(true);
	});

	test("throws for nonexistent automation", () => {
		const ctx = makeCtx();
		expect(() =>
			handleUpdate({ name: "Nonexistent" }, ctx),
		).toThrow("Automation not found");
	});
});

// ---------------------------------------------------------------------------
// delete tool
// ---------------------------------------------------------------------------

describe("handleDelete", () => {
	test("removes automation from list", () => {
		const ctx = makeCtx();
		handleCreate(
			{
				name: "Temp",
				prompt: "Temporary",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		);

		const delResult = handleDelete({ name: "Temp" }, ctx) as {
			deleted: boolean;
		};
		expect(delResult.deleted).toBe(true);

		const listResult = handleList({}, ctx) as { total: number };
		expect(listResult.total).toBe(0);
	});

	test("throws for nonexistent automation", () => {
		const ctx = makeCtx();
		expect(() => handleDelete({ name: "Nope" }, ctx)).toThrow(
			"Automation not found",
		);
	});
});

// ---------------------------------------------------------------------------
// list with filters
// ---------------------------------------------------------------------------

describe("handleList filters", () => {
	function seedAutomations(ctx: ToolContext): void {
		handleCreate(
			{
				name: "Active Bundle",
				prompt: "p",
				schedule: { type: "interval", intervalMs: 60_000 },
				enabled: true,
				source: "bundle",
			},
			ctx,
		);
		handleCreate(
			{
				name: "Disabled User",
				prompt: "p",
				schedule: { type: "interval", intervalMs: 60_000 },
				enabled: false,
				source: "user",
			},
			ctx,
		);
		handleCreate(
			{
				name: "Active Agent",
				prompt: "p",
				schedule: { type: "interval", intervalMs: 60_000 },
				enabled: true,
				source: "agent",
			},
			ctx,
		);
	}

	test("filter enabled: true", () => {
		const ctx = makeCtx();
		seedAutomations(ctx);

		const result = handleList({ enabled: true }, ctx) as {
			automations: Array<{ enabled: boolean }>;
			total: number;
		};
		expect(result.total).toBe(2);
		expect(result.automations.every((a) => a.enabled)).toBe(true);
	});

	test("filter source: bundle", () => {
		const ctx = makeCtx();
		seedAutomations(ctx);

		const result = handleList({ source: "bundle" }, ctx) as {
			automations: Array<{ source: string }>;
			total: number;
		};
		expect(result.total).toBe(1);
		expect(result.automations[0]!.source).toBe("bundle");
	});

	test("filter enabled: false", () => {
		const ctx = makeCtx();
		seedAutomations(ctx);

		const result = handleList({ enabled: false }, ctx) as {
			automations: Array<{ enabled: boolean }>;
			total: number;
		};
		expect(result.total).toBe(1);
		expect(result.automations[0]!.enabled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// status tool
// ---------------------------------------------------------------------------

describe("handleStatus", () => {
	test("returns automation with recent runs (newest first)", () => {
		const ctx = makeCtx();
		handleCreate(
			{
				name: "Status Test",
				prompt: "p",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		);

		// Seed some runs
		const runs = [
			makeRun({
				automationId: "status-test",
				startedAt: "2025-06-15T10:00:00.000Z",
				status: "success",
			}),
			makeRun({
				automationId: "status-test",
				startedAt: "2025-06-15T11:00:00.000Z",
				status: "failure",
				error: "something broke",
			}),
			makeRun({
				automationId: "status-test",
				startedAt: "2025-06-15T12:00:00.000Z",
				status: "success",
			}),
		];
		for (const run of runs) {
			appendRun("status-test", run, TMP_DIR);
		}

		const result = handleStatus({ name: "Status Test", limit: 5 }, ctx) as {
			automation: Automation & { scheduleHuman: string };
			recentRuns: AutomationRun[];
		};

		expect(result.automation.id).toBe("status-test");
		expect(result.automation.scheduleHuman).toBe("Every 1 minute");
		expect(result.recentRuns.length).toBe(3);
		// Newest first
		expect(result.recentRuns[0]!.startedAt).toBe("2025-06-15T12:00:00.000Z");
		expect(result.recentRuns[2]!.startedAt).toBe("2025-06-15T10:00:00.000Z");
	});

	test("throws for nonexistent automation", () => {
		const ctx = makeCtx();
		expect(() => handleStatus({ name: "Nope" }, ctx)).toThrow(
			"Automation not found",
		);
	});
});

// ---------------------------------------------------------------------------
// runs tool
// ---------------------------------------------------------------------------

describe("handleRuns", () => {
	test("filters by status", () => {
		const ctx = makeCtx();
		handleCreate(
			{
				name: "Run Filter Test",
				prompt: "p",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		);

		appendRun(
			"run-filter-test",
			makeRun({
				automationId: "run-filter-test",
				status: "success",
				startedAt: "2025-06-15T10:00:00.000Z",
			}),
			TMP_DIR,
		);
		appendRun(
			"run-filter-test",
			makeRun({
				automationId: "run-filter-test",
				status: "failure",
				error: "oops",
				startedAt: "2025-06-15T11:00:00.000Z",
			}),
			TMP_DIR,
		);
		appendRun(
			"run-filter-test",
			makeRun({
				automationId: "run-filter-test",
				status: "success",
				startedAt: "2025-06-15T12:00:00.000Z",
			}),
			TMP_DIR,
		);

		const result = handleRuns(
			{ automationId: "run-filter-test", status: "failure" },
			ctx,
		) as { runs: AutomationRun[]; total: number };

		expect(result.total).toBe(1);
		expect(result.runs[0]!.status).toBe("failure");
	});

	test("queries across all automations", () => {
		const ctx = makeCtx();
		handleCreate(
			{ name: "A", prompt: "p", schedule: { type: "interval", intervalMs: 60_000 } },
			ctx,
		);
		handleCreate(
			{ name: "B", prompt: "p", schedule: { type: "interval", intervalMs: 60_000 } },
			ctx,
		);

		appendRun("a", makeRun({ automationId: "a", startedAt: "2025-06-15T10:00:00.000Z" }), TMP_DIR);
		appendRun("b", makeRun({ automationId: "b", startedAt: "2025-06-15T11:00:00.000Z" }), TMP_DIR);

		const result = handleRuns({}, ctx) as { runs: AutomationRun[]; total: number };
		expect(result.total).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// run tool
// ---------------------------------------------------------------------------

describe("handleRun", () => {
	test("triggers immediate execution and returns result", async () => {
		const ctx = makeCtx();
		handleCreate(
			{
				name: "Immediate",
				prompt: "Run now",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		);

		const result = (await handleRun({ name: "Immediate" }, ctx)) as {
			run: AutomationRun;
		};

		expect(result.run).toBeDefined();
		expect(result.run.automationId).toBe("immediate");
		expect(result.run.status).toBe("success");
	});

	test("throws for nonexistent automation", async () => {
		const ctx = makeCtx();
		await expect(handleRun({ name: "Nope" }, ctx)).rejects.toThrow(
			"Automation not found",
		);
	});
});

// ---------------------------------------------------------------------------
// Delete preserves run history
// ---------------------------------------------------------------------------

describe("delete preserves run history", () => {
	test("runs still accessible after deletion", () => {
		const ctx = makeCtx();
		handleCreate(
			{
				name: "Deletable",
				prompt: "p",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		);

		appendRun(
			"deletable",
			makeRun({ automationId: "deletable", status: "success" }),
			TMP_DIR,
		);

		handleDelete({ name: "Deletable" }, ctx);

		// Runs still accessible via runs tool
		const result = handleRuns({ automationId: "deletable" }, ctx) as {
			runs: AutomationRun[];
			total: number;
		};
		expect(result.total).toBe(1);
		expect(result.runs[0]!.status).toBe("success");
	});
});

// ---------------------------------------------------------------------------
// handleCreate — new fields
// ---------------------------------------------------------------------------

describe("handleCreate — new fields", () => {
	test("stores maxRunDurationMs and tokenBudget", () => {
		const ctx = makeCtx();
		const result = handleCreate({
			name: "Budget Test",
			prompt: "test",
			schedule: { type: "interval", intervalMs: 60_000 },
			maxRunDurationMs: 60_000,
			tokenBudget: { maxInputTokens: 10000, period: "daily" },
		}, ctx) as Record<string, unknown>;

		const auto = (result.automation as Automation);
		expect(auto.maxRunDurationMs).toBe(60_000);
		expect(auto.tokenBudget).toEqual({ maxInputTokens: 10000, period: "daily" });
		expect(auto.cumulativeInputTokens).toBe(0);
		expect(auto.cumulativeOutputTokens).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// handleUpdate — re-enable clears disable state
// ---------------------------------------------------------------------------

describe("handleUpdate — re-enable clears disable state", () => {
	test("enabled=true clears disabledAt, disabledReason, and consecutiveErrors", () => {
		const ctx = makeCtx();
		// Create an automation first
		handleCreate({
			name: "Disabled Test",
			prompt: "test",
			schedule: { type: "interval", intervalMs: 60_000 },
		}, ctx);

		// Simulate auto-disable by writing directly
		const defs = loadDefinitions(TMP_DIR);
		const auto = defs.get("disabled-test")!;
		auto.enabled = false;
		auto.disabledAt = new Date().toISOString();
		auto.disabledReason = "Auto-disabled after 10 consecutive failures";
		auto.consecutiveErrors = 10;
		saveDefinitions(defs, TMP_DIR);

		// Re-enable
		const result = handleUpdate({ name: "Disabled Test", enabled: true }, ctx) as Record<string, unknown>;
		const updated = (result.automation as Automation);
		expect(updated.enabled).toBe(true);
		expect(updated.consecutiveErrors).toBe(0);
		expect(updated.disabledAt).toBeUndefined();
		expect(updated.disabledReason).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// handleCancel
// ---------------------------------------------------------------------------

describe("handleCancel", () => {
	test("calls cancelRun and returns result", () => {
		let cancelledId: string | null = null;
		const ctx = makeCtx({
			cancelRun: (id) => { cancelledId = id; return true; },
		});
		handleCreate({
			name: "Cancel Target",
			prompt: "test",
			schedule: { type: "interval", intervalMs: 60_000 },
		}, ctx);

		const result = handleCancel({ name: "Cancel Target" }, ctx) as Record<string, unknown>;
		expect(result.cancelled).toBe(true);
		expect(cancelledId).toBe("cancel-target");
	});

	test("throws for non-existent automation", () => {
		const ctx = makeCtx();
		expect(() => handleCancel({ name: "Nonexistent" }, ctx)).toThrow("not found");
	});
});

// ---------------------------------------------------------------------------
// handleList — includes disable info
// ---------------------------------------------------------------------------

describe("handleList — disable info", () => {
	test("includes disabledReason when auto-disabled", () => {
		const ctx = makeCtx();
		handleCreate({
			name: "List Disabled",
			prompt: "test",
			schedule: { type: "interval", intervalMs: 60_000 },
		}, ctx);

		// Simulate auto-disable
		const defs = loadDefinitions(TMP_DIR);
		const auto = defs.get("list-disabled")!;
		auto.enabled = false;
		auto.disabledAt = new Date().toISOString();
		auto.disabledReason = "Token budget exceeded";
		saveDefinitions(defs, TMP_DIR);

		const result = handleList({}, ctx) as Record<string, unknown>;
		const automations = result.automations as Array<Record<string, unknown>>;
		const entry = automations.find(a => a.id === "list-disabled")!;
		expect(entry.disabledReason).toBe("Token budget exceeded");
	});
});

// ---------------------------------------------------------------------------
// validateAutomationFields
// ---------------------------------------------------------------------------

describe("validateAutomationFields", () => {
	test("rejects intervalMs below 60000", () => {
		expect(() =>
			validateAutomationFields({
				schedule: { type: "interval", intervalMs: 30_000 },
			}),
		).toThrow("at least 1 minute");
	});

	test("accepts intervalMs at 60000", () => {
		expect(() =>
			validateAutomationFields({
				schedule: { type: "interval", intervalMs: 60_000 },
			}),
		).not.toThrow();
	});

	test("rejects interval type without intervalMs", () => {
		expect(() =>
			validateAutomationFields({
				schedule: { type: "interval" },
			}),
		).toThrow("intervalMs is required");
	});

	test("rejects cron type without expression", () => {
		expect(() =>
			validateAutomationFields({
				schedule: { type: "cron" },
			}),
		).toThrow("expression is required");
	});

	test("rejects invalid cron expression", () => {
		expect(() =>
			validateAutomationFields({
				schedule: { type: "cron", expression: "not a cron" },
			}),
		).toThrow("Invalid cron expression");
	});

	test("accepts valid cron expression", () => {
		expect(() =>
			validateAutomationFields({
				schedule: { type: "cron", expression: "0 8 * * *" },
			}),
		).not.toThrow();
	});

	test("rejects maxIterations below 1", () => {
		expect(() =>
			validateAutomationFields({ maxIterations: 0 }),
		).toThrow("between 1 and 15");
	});

	test("rejects maxIterations above 15", () => {
		expect(() =>
			validateAutomationFields({ maxIterations: 16 }),
		).toThrow("between 1 and 15");
	});

	test("accepts maxIterations at 5", () => {
		expect(() =>
			validateAutomationFields({ maxIterations: 5 }),
		).not.toThrow();
	});

	test("rejects maxInputTokens below 1000", () => {
		expect(() =>
			validateAutomationFields({ maxInputTokens: 500 }),
		).toThrow("between 1,000 and 1,000,000");
	});

	test("accepts maxInputTokens at 200000", () => {
		expect(() =>
			validateAutomationFields({ maxInputTokens: 200_000 }),
		).not.toThrow();
	});

	test("rejects maxRunDurationMs below 10000", () => {
		expect(() =>
			validateAutomationFields({ maxRunDurationMs: 5_000 }),
		).toThrow("between 10 seconds and 10 minutes");
	});

	test("accepts maxRunDurationMs at 120000", () => {
		expect(() =>
			validateAutomationFields({ maxRunDurationMs: 120_000 }),
		).not.toThrow();
	});

	test("passes with no validation-relevant fields", () => {
		expect(() =>
			validateAutomationFields({ name: "test", prompt: "do stuff" }),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// handleCreate — validation integration
// ---------------------------------------------------------------------------

describe("handleCreate — validation", () => {
	test("rejects creation with invalid intervalMs", () => {
		const ctx = makeCtx();
		expect(() =>
			handleCreate(
				{
					name: "Bad Interval",
					prompt: "test",
					schedule: { type: "interval", intervalMs: 10_000 },
				},
				ctx,
			),
		).toThrow("at least 1 minute");
	});

	test("rejects creation with invalid cron", () => {
		const ctx = makeCtx();
		expect(() =>
			handleCreate(
				{
					name: "Bad Cron",
					prompt: "test",
					schedule: { type: "cron", expression: "nope" },
				},
				ctx,
			),
		).toThrow("Invalid cron");
	});
});

// ---------------------------------------------------------------------------
// handleUpdate — validation integration
// ---------------------------------------------------------------------------

describe("handleUpdate — validation", () => {
	test("rejects update with invalid intervalMs", () => {
		const ctx = makeCtx();
		handleCreate(
			{
				name: "Update Target",
				prompt: "test",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		);

		expect(() =>
			handleUpdate(
				{
					name: "Update Target",
					schedule: { type: "interval", intervalMs: 5_000 },
				},
				ctx,
			),
		).toThrow("at least 1 minute");
	});

	test("accepts valid schedule update", () => {
		const ctx = makeCtx();
		handleCreate(
			{
				name: "Update Target Valid",
				prompt: "test",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		);

		const result = handleUpdate(
			{
				name: "Update Target Valid",
				schedule: { type: "cron", expression: "0 9 * * 1" },
			},
			ctx,
		) as Record<string, unknown>;
		expect(result.updated).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Automation ownership (ownerId / workspaceId)
// ---------------------------------------------------------------------------

describe("automation ownership", () => {
	test("handleCreate sets ownerId from context", () => {
		const ctx = makeCtx({ currentUserId: "usr_alice" });
		const result = handleCreate(
			{
				name: "Owned Automation",
				prompt: "do something",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		) as { automation: Automation; created: boolean };

		expect(result.created).toBe(true);
		expect(result.automation.ownerId).toBe("usr_alice");
	});

	test("handleCreate sets workspaceId from context", () => {
		const ctx = makeCtx({ currentWorkspaceId: "ws_engineering" });
		const result = handleCreate(
			{
				name: "Workspace Automation",
				prompt: "do something",
				schedule: { type: "interval", intervalMs: 60_000 },
			},
			ctx,
		) as { automation: Automation; created: boolean };

		expect(result.created).toBe(true);
		expect(result.automation.workspaceId).toBe("ws_engineering");
	});

	test("handleCreate sets both ownerId and workspaceId", () => {
		const ctx = makeCtx({
			currentUserId: "usr_bob",
			currentWorkspaceId: "ws_ops",
		});
		const result = handleCreate(
			{
				name: "Full Context Automation",
				prompt: "do something",
				schedule: { type: "cron", expression: "0 9 * * *" },
			},
			ctx,
		) as { automation: Automation; created: boolean };

		expect(result.created).toBe(true);
		expect(result.automation.ownerId).toBe("usr_bob");
		expect(result.automation.workspaceId).toBe("ws_ops");
	});

	test("automations without ownerId continue to work (backward compat)", () => {
		const ctx = makeCtx(); // no currentUserId or currentWorkspaceId
		const result = handleCreate(
			{
				name: "Legacy Automation",
				prompt: "do something",
				schedule: { type: "interval", intervalMs: 120_000 },
			},
			ctx,
		) as { automation: Automation; created: boolean };

		expect(result.created).toBe(true);
		expect(result.automation.ownerId).toBeUndefined();
		expect(result.automation.workspaceId).toBeUndefined();
	});
});
