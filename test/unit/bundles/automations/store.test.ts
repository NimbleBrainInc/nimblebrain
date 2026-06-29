import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	automationFilePath,
	automationRunIndexPath,
	automationRunsDir,
	workspaceAutomationsDir,
} from "../../../../src/bundles/automations/src/paths.ts";
import {
	appendRun,
	deleteAutomation,
	deleteAutomationDefinition,
	detectOrphans,
	loadAllAutomations,
	loadAutomation,
	loadOwnerAutomations,
	readAllRuns,
	readRunResult,
	readRuns,
	saveAutomation,
	saveRunResult,
	updateRun,
} from "../../../../src/bundles/automations/src/store.ts";
import type {
	Automation,
	AutomationRun,
	AutomationRunResult,
} from "../../../../src/bundles/automations/src/types.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-automation-store");
const WS = "ws_test";
const OWNER = "usr_test";

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
	return {
		id: "test-auto",
		name: "Test Automation",
		prompt: "Do something",
		schedule: { type: "interval", intervalMs: 60_000 },
		enabled: true,
		source: "user",
		workspaceId: WS,
		ownerId: OWNER,
		createdAt: "2025-06-01T00:00:00.000Z",
		updatedAt: "2025-06-01T00:00:00.000Z",
		runCount: 0,
		consecutiveErrors: 0,
		cumulativeInputTokens: 0,
		cumulativeOutputTokens: 0,
		...overrides,
	};
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
	return {
		id: `run_${Math.random().toString(36).slice(2, 14)}`,
		automationId: "test-auto",
		startedAt: new Date().toISOString(),
		status: "success",
		inputTokens: 100,
		outputTokens: 50,
		toolCalls: 2,
		iterations: 1,
		...overrides,
	};
}

function makeResult(overrides: Partial<AutomationRunResult> = {}): AutomationRunResult {
	return {
		runId: "run_abcdef012345",
		automationId: "test-auto",
		completedAt: new Date().toISOString(),
		output: "The full deliverable.",
		activityLog: [
			{ id: "t1", name: "files__create", input: {}, output: "{}", ok: true, ms: 12 },
		],
		outputFiles: [],
		usage: { inputTokens: 100, outputTokens: 50, iterations: 1 },
		stopReason: "complete",
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
// Definitions: per-automation save + load round-trip
// ---------------------------------------------------------------------------

describe("definitions", () => {
	test("loadOwnerAutomations returns empty map when dir is missing", () => {
		const map = loadOwnerAutomations(TMP_DIR, WS, OWNER);
		expect(map.size).toBe(0);
	});

	test("save then load round-trips per automation", () => {
		const auto1 = makeAutomation({ id: "a1", name: "First" });
		const auto2 = makeAutomation({ id: "a2", name: "Second" });

		saveAutomation(TMP_DIR, WS, OWNER, auto1);
		saveAutomation(TMP_DIR, WS, OWNER, auto2);

		const loaded = loadOwnerAutomations(TMP_DIR, WS, OWNER);
		expect(loaded.size).toBe(2);
		expect(loaded.get("a1")!.name).toBe("First");
		expect(loaded.get("a2")!.name).toBe("Second");
		expect(loaded.get("a1")!.prompt).toBe("Do something");
	});

	test("each automation lives in its own <id>.json file", () => {
		saveAutomation(TMP_DIR, WS, OWNER, makeAutomation({ id: "a1" }));
		expect(existsSync(automationFilePath(TMP_DIR, WS, OWNER, "a1"))).toBe(true);
	});

	test("loadAutomation reads a single automation, null when missing", () => {
		saveAutomation(TMP_DIR, WS, OWNER, makeAutomation({ id: "a1", name: "Solo" }));
		expect(loadAutomation(TMP_DIR, WS, OWNER, "a1")!.name).toBe("Solo");
		expect(loadAutomation(TMP_DIR, WS, OWNER, "missing")).toBeNull();
	});

	test("atomic write uses temp+rename (no leftover .tmp files)", () => {
		saveAutomation(TMP_DIR, WS, OWNER, makeAutomation({ id: "a1" }));
		const dir = workspaceAutomationsDir(TMP_DIR, WS, OWNER);
		const tmpFiles = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
		expect(tmpFiles.length).toBe(0);
	});

	test("deleteAutomation removes the file and its runs dir", () => {
		saveAutomation(TMP_DIR, WS, OWNER, makeAutomation({ id: "a1" }));
		appendRun(TMP_DIR, WS, OWNER, "a1", makeRun({ automationId: "a1" }));
		expect(existsSync(automationFilePath(TMP_DIR, WS, OWNER, "a1"))).toBe(true);
		expect(existsSync(automationRunsDir(TMP_DIR, WS, OWNER, "a1"))).toBe(true);

		deleteAutomation(TMP_DIR, WS, OWNER, "a1");
		expect(existsSync(automationFilePath(TMP_DIR, WS, OWNER, "a1"))).toBe(false);
		expect(existsSync(automationRunsDir(TMP_DIR, WS, OWNER, "a1"))).toBe(false);
	});

	test("deleteAutomationDefinition removes the file but preserves run history", () => {
		saveAutomation(TMP_DIR, WS, OWNER, makeAutomation({ id: "a1" }));
		appendRun(TMP_DIR, WS, OWNER, "a1", makeRun({ automationId: "a1" }));

		deleteAutomationDefinition(TMP_DIR, WS, OWNER, "a1");
		expect(existsSync(automationFilePath(TMP_DIR, WS, OWNER, "a1"))).toBe(false);
		// Run history (audit trail) outlives the definition.
		expect(readRuns(TMP_DIR, WS, OWNER, "a1").length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// loadAllAutomations: cross-workspace scan + backfill from path
// ---------------------------------------------------------------------------

describe("loadAllAutomations", () => {
	test("loads automations across workspaces and owners", () => {
		saveAutomation(TMP_DIR, "ws_a", "usr_1", makeAutomation({ id: "x", workspaceId: "ws_a", ownerId: "usr_1" }));
		saveAutomation(TMP_DIR, "ws_a", "usr_2", makeAutomation({ id: "y", workspaceId: "ws_a", ownerId: "usr_2" }));
		saveAutomation(TMP_DIR, "ws_b", "usr_1", makeAutomation({ id: "z", workspaceId: "ws_b", ownerId: "usr_1" }));

		const all = loadAllAutomations(TMP_DIR);
		expect(all.length).toBe(3);
		expect(all.map((a) => a.id).sort()).toEqual(["x", "y", "z"]);
	});

	test("backfills workspaceId/ownerId from the path when missing on the record", () => {
		// Persist a record that lacks the binding fields; the dir is authoritative.
		const bare = makeAutomation({ id: "bare" });
		bare.workspaceId = undefined;
		bare.ownerId = undefined;
		saveAutomation(TMP_DIR, "ws_path", "usr_path", bare);

		const all = loadAllAutomations(TMP_DIR);
		const recovered = all.find((a) => a.id === "bare")!;
		expect(recovered.workspaceId).toBe("ws_path");
		expect(recovered.ownerId).toBe("usr_path");
	});

	test("returns empty when workspaces root is missing", () => {
		const empty = join(TMP_DIR, "no-workspaces");
		mkdirSync(empty, { recursive: true });
		expect(loadAllAutomations(empty)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Runs: append + read
// ---------------------------------------------------------------------------

describe("runs", () => {
	test("append run then read runs returns it", () => {
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "run_001", automationId: "test-auto" }));
		const runs = readRuns(TMP_DIR, WS, OWNER, "test-auto");
		expect(runs.length).toBe(1);
		expect(runs[0]!.id).toBe("run_001");
	});

	test("readRuns returns newest first", () => {
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "run_001", startedAt: "2025-06-01T00:00:00.000Z" }));
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "run_002", startedAt: "2025-06-01T01:00:00.000Z" }));

		const runs = readRuns(TMP_DIR, WS, OWNER, "test-auto");
		expect(runs.length).toBe(2);
		expect(runs[0]!.id).toBe("run_002");
		expect(runs[1]!.id).toBe("run_001");
	});

	test("readRuns with missing index returns empty array", () => {
		expect(readRuns(TMP_DIR, WS, OWNER, "nonexistent")).toEqual([]);
	});

	test("missing runs directory is created on first write", () => {
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ automationId: "test-auto" }));
		expect(existsSync(automationRunIndexPath(TMP_DIR, WS, OWNER, "test-auto"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Update run
// ---------------------------------------------------------------------------

describe("updateRun", () => {
	test("updates status from running to success", () => {
		const run = makeRun({ id: "run_upd", status: "running", completedAt: undefined });
		appendRun(TMP_DIR, WS, OWNER, "test-auto", run);

		updateRun(TMP_DIR, WS, OWNER, "test-auto", {
			...run,
			status: "success",
			completedAt: "2025-06-01T01:00:00.000Z",
		});

		const runs = readRuns(TMP_DIR, WS, OWNER, "test-auto");
		expect(runs.length).toBe(1);
		expect(runs[0]!.status).toBe("success");
		expect(runs[0]!.completedAt).toBe("2025-06-01T01:00:00.000Z");
	});

	test("updates last matching line when multiple runs exist", () => {
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "run_same", status: "running" }));
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "run_other", status: "success" }));

		updateRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "run_same", status: "failure", error: "Something broke" }));

		const runs = readRuns(TMP_DIR, WS, OWNER, "test-auto");
		const matched = runs.find((r) => r.id === "run_same");
		expect(matched!.status).toBe("failure");
		expect(matched!.error).toBe("Something broke");
	});

	test("no-op when index does not exist", () => {
		updateRun(TMP_DIR, WS, OWNER, "nonexistent", makeRun({ id: "run_x" }));
	});
});

// ---------------------------------------------------------------------------
// Run results (the deliverable sidecar)
// ---------------------------------------------------------------------------

describe("run results", () => {
	test("save then read round-trips the full result", () => {
		const result = makeResult({ runId: "run_abc123def456", automationId: "test-auto" });
		saveRunResult(TMP_DIR, WS, OWNER, "test-auto", result);

		const loaded = readRunResult(TMP_DIR, WS, OWNER, "test-auto", "run_abc123def456");
		expect(loaded).not.toBeNull();
		expect(loaded!.output).toBe("The full deliverable.");
		expect(loaded!.activityLog.length).toBe(1);
		expect(loaded!.usage.iterations).toBe(1);
	});

	test("readRunResult returns null for an unknown runId", () => {
		expect(readRunResult(TMP_DIR, WS, OWNER, "test-auto", "run_missing00000")).toBeNull();
	});

	test("readRunResult returns null for an invalid runId (no throw)", () => {
		expect(readRunResult(TMP_DIR, WS, OWNER, "test-auto", "../../etc/passwd")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------------

describe("detectOrphans", () => {
	test("marks running runs without completedAt as failure", () => {
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "run_orphan", status: "running", completedAt: undefined }));

		expect(detectOrphans(TMP_DIR, WS, OWNER)).toBe(1);

		const runs = readRuns(TMP_DIR, WS, OWNER, "test-auto");
		expect(runs[0]!.status).toBe("failure");
		expect(runs[0]!.error).toContain("Orphaned run");
		expect(runs[0]!.completedAt).toBeDefined();
	});

	test("does not touch completed running runs", () => {
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "run_completed", status: "running", completedAt: "2025-06-01T01:00:00.000Z" }));

		expect(detectOrphans(TMP_DIR, WS, OWNER)).toBe(0);
		expect(readRuns(TMP_DIR, WS, OWNER, "test-auto")[0]!.status).toBe("running");
	});

	test("handles multiple orphans across automations in one owner dir", () => {
		appendRun(TMP_DIR, WS, OWNER, "auto-a", makeRun({ id: "run_o1", automationId: "auto-a", status: "running", completedAt: undefined }));
		appendRun(TMP_DIR, WS, OWNER, "auto-b", makeRun({ id: "run_o2", automationId: "auto-b", status: "running", completedAt: undefined }));

		expect(detectOrphans(TMP_DIR, WS, OWNER)).toBe(2);
	});

	test("returns 0 when no runs directory exists", () => {
		expect(detectOrphans(TMP_DIR, WS, "usr_empty")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe("pruning", () => {
	test("prunes oldest when exceeding 1000 lines", () => {
		const filePath = automationRunIndexPath(TMP_DIR, WS, OWNER, "prune-test");
		mkdirSync(automationRunsDir(TMP_DIR, WS, OWNER, "prune-test"), { recursive: true });

		const lines: string[] = [];
		for (let i = 0; i < 1000; i++) {
			lines.push(
				JSON.stringify(
					makeRun({
						id: `run_${String(i).padStart(4, "0")}`,
						automationId: "prune-test",
						startedAt: new Date(Date.parse("2025-01-01T00:00:00Z") + i * 1000).toISOString(),
					}),
				),
			);
		}
		writeFileSync(filePath, `${lines.join("\n")}\n`);

		appendRun(TMP_DIR, WS, OWNER, "prune-test", makeRun({ id: "run_1000", automationId: "prune-test", startedAt: "2025-02-01T00:00:00.000Z" }));

		const resultLines = readFileSync(filePath, "utf-8").trimEnd().split("\n");
		expect(resultLines.length).toBe(1000);

		const parsed = resultLines.map((l) => JSON.parse(l) as AutomationRun);
		expect(parsed.find((r) => r.id === "run_0000")).toBeUndefined();
		expect(parsed.find((r) => r.id === "run_1000")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("filters", () => {
	test("limit returns at most N runs", () => {
		for (let i = 0; i < 10; i++) {
			appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: `run_${i}`, startedAt: new Date(Date.now() + i * 1000).toISOString() }));
		}
		expect(readRuns(TMP_DIR, WS, OWNER, "test-auto", { limit: 5 }).length).toBe(5);
	});

	test("status filter returns only matching runs", () => {
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "r1", status: "success" }));
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "r2", status: "failure" }));
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "r3", status: "success" }));
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "r4", status: "failure" }));

		const failures = readRuns(TMP_DIR, WS, OWNER, "test-auto", { status: "failure" });
		expect(failures.length).toBe(2);
		expect(failures.every((r) => r.status === "failure")).toBe(true);
	});

	test("since filter returns only runs after timestamp", () => {
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "old", startedAt: "2025-01-01T00:00:00.000Z" }));
		appendRun(TMP_DIR, WS, OWNER, "test-auto", makeRun({ id: "new", startedAt: "2025-06-01T00:00:00.000Z" }));

		const runs = readRuns(TMP_DIR, WS, OWNER, "test-auto", { since: "2025-03-01T00:00:00.000Z" });
		expect(runs.length).toBe(1);
		expect(runs[0]!.id).toBe("new");
	});
});

// ---------------------------------------------------------------------------
// readAllRuns (across one owner's automations)
// ---------------------------------------------------------------------------

describe("readAllRuns", () => {
	test("aggregates runs across multiple automations", () => {
		appendRun(TMP_DIR, WS, OWNER, "auto-a", makeRun({ id: "ra1", automationId: "auto-a", startedAt: "2025-06-01T00:00:00.000Z" }));
		appendRun(TMP_DIR, WS, OWNER, "auto-b", makeRun({ id: "rb1", automationId: "auto-b", startedAt: "2025-06-01T01:00:00.000Z" }));
		appendRun(TMP_DIR, WS, OWNER, "auto-a", makeRun({ id: "ra2", automationId: "auto-a", startedAt: "2025-06-01T02:00:00.000Z" }));

		const all = readAllRuns(TMP_DIR, WS, OWNER);
		expect(all.length).toBe(3);
		expect(all[0]!.id).toBe("ra2");
		expect(all[1]!.id).toBe("rb1");
		expect(all[2]!.id).toBe("ra1");
	});

	test("applies filters across all automations", () => {
		appendRun(TMP_DIR, WS, OWNER, "auto-a", makeRun({ id: "ra1", automationId: "auto-a", status: "failure" }));
		appendRun(TMP_DIR, WS, OWNER, "auto-b", makeRun({ id: "rb1", automationId: "auto-b", status: "success" }));

		const failures = readAllRuns(TMP_DIR, WS, OWNER, { status: "failure" });
		expect(failures.length).toBe(1);
		expect(failures[0]!.id).toBe("ra1");
	});

	test("returns empty when runs directory does not exist", () => {
		expect(readAllRuns(TMP_DIR, WS, "usr_norows")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Automation ID validation (path traversal prevention)
// ---------------------------------------------------------------------------

describe("automation id validation", () => {
	test("rejects path traversal IDs", () => {
		expect(() => appendRun(TMP_DIR, WS, OWNER, "../../etc/passwd", makeRun())).toThrow(/Invalid automation id/i);
	});

	test("rejects empty string", () => {
		expect(() => appendRun(TMP_DIR, WS, OWNER, "", makeRun())).toThrow(/Invalid automation id/i);
	});

	test("rejects IDs with slashes", () => {
		expect(() => appendRun(TMP_DIR, WS, OWNER, "foo/bar", makeRun())).toThrow(/Invalid automation id/i);
	});

	test("rejects IDs with uppercase letters", () => {
		expect(() => appendRun(TMP_DIR, WS, OWNER, "My-Auto", makeRun())).toThrow(/Invalid automation id/i);
	});

	test("accepts valid kebab-case automation IDs", () => {
		appendRun(TMP_DIR, WS, OWNER, "daily-report", makeRun({ automationId: "daily-report" }));
		expect(readRuns(TMP_DIR, WS, OWNER, "daily-report").length).toBe(1);
	});

	test("accepts automation IDs with numbers", () => {
		appendRun(TMP_DIR, WS, OWNER, "report-2025", makeRun({ automationId: "report-2025" }));
		expect(readRuns(TMP_DIR, WS, OWNER, "report-2025").length).toBe(1);
	});

	test("validation applies to readRuns", () => {
		expect(() => readRuns(TMP_DIR, WS, OWNER, "../../etc/passwd")).toThrow(/Invalid automation id/i);
	});

	test("validation applies to updateRun", () => {
		expect(() => updateRun(TMP_DIR, WS, OWNER, "../../etc/passwd", makeRun())).toThrow(/Invalid automation id/i);
	});
});
