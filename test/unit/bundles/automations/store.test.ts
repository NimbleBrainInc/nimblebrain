import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	appendRun,
	detectOrphans,
	loadDefinitions,
	readAllRuns,
	readRuns,
	saveDefinitions,
	updateRun,
} from "../../../../src/bundles/automations/src/store.ts";
import type {
	Automation,
	AutomationRun,
} from "../../../../src/bundles/automations/src/types.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-automation-store");

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
	return {
		id: "test-auto",
		name: "Test Automation",
		prompt: "Do something",
		schedule: { type: "interval", intervalMs: 60_000 },
		enabled: true,
		source: "user",
		createdAt: "2025-06-01T00:00:00.000Z",
		updatedAt: "2025-06-01T00:00:00.000Z",
		runCount: 0,
		consecutiveErrors: 0,
		...overrides,
	};
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
	return {
		id: `run_${Math.random().toString(36).slice(2, 8)}`,
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

beforeEach(() => {
	mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Definitions: save + load round-trip
// ---------------------------------------------------------------------------

describe("definitions", () => {
	test("loadDefinitions creates file if missing", () => {
		const map = loadDefinitions(TMP_DIR);
		expect(map.size).toBe(0);
		expect(existsSync(join(TMP_DIR, "automations.json"))).toBe(true);
	});

	test("save then load round-trips correctly", () => {
		const auto1 = makeAutomation({ id: "a1", name: "First" });
		const auto2 = makeAutomation({ id: "a2", name: "Second" });

		const map = new Map<string, Automation>();
		map.set("a1", auto1);
		map.set("a2", auto2);

		saveDefinitions(map, TMP_DIR);
		const loaded = loadDefinitions(TMP_DIR);

		expect(loaded.size).toBe(2);
		expect(loaded.get("a1")!.name).toBe("First");
		expect(loaded.get("a2")!.name).toBe("Second");
		expect(loaded.get("a1")!.prompt).toBe("Do something");
	});

	test("atomic write uses temp+rename (no partial writes)", () => {
		const auto = makeAutomation({ id: "a1" });
		const map = new Map<string, Automation>();
		map.set("a1", auto);

		saveDefinitions(map, TMP_DIR);

		// After save, no .tmp files should remain
		const files = readFileSync(join(TMP_DIR, "automations.json"), "utf-8");
		expect(files).toContain('"a1"');

		// Check no leftover temp files
		const dirFiles = require("node:fs").readdirSync(TMP_DIR) as string[];
		const tmpFiles = dirFiles.filter((f: string) => f.endsWith(".tmp"));
		expect(tmpFiles.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Runs: append + read
// ---------------------------------------------------------------------------

describe("runs", () => {
	test("append run then read runs returns it", () => {
		const run = makeRun({ id: "run_001", automationId: "test-auto" });
		appendRun("test-auto", run, TMP_DIR);

		const runs = readRuns("test-auto", undefined, TMP_DIR);
		expect(runs.length).toBe(1);
		expect(runs[0]!.id).toBe("run_001");
	});

	test("readRuns returns newest first", () => {
		const run1 = makeRun({
			id: "run_001",
			startedAt: "2025-06-01T00:00:00.000Z",
		});
		const run2 = makeRun({
			id: "run_002",
			startedAt: "2025-06-01T01:00:00.000Z",
		});

		appendRun("test-auto", run1, TMP_DIR);
		appendRun("test-auto", run2, TMP_DIR);

		const runs = readRuns("test-auto", undefined, TMP_DIR);
		expect(runs.length).toBe(2);
		// run2 is newer, should be first
		expect(runs[0]!.id).toBe("run_002");
		expect(runs[1]!.id).toBe("run_001");
	});

	test("readRuns with missing file returns empty array", () => {
		const runs = readRuns("nonexistent", undefined, TMP_DIR);
		expect(runs.length).toBe(0);
	});

	test("missing data directory is created on first write", () => {
		const deepDir = join(TMP_DIR, "nested", "deep");
		const run = makeRun({ automationId: "test-auto" });

		appendRun("test-auto", run, deepDir);

		expect(existsSync(join(deepDir, "runs", "test-auto.jsonl"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Update run
// ---------------------------------------------------------------------------

describe("updateRun", () => {
	test("updates status from running to success", () => {
		const run = makeRun({
			id: "run_upd",
			status: "running",
			completedAt: undefined,
		});
		appendRun("test-auto", run, TMP_DIR);

		const updated: AutomationRun = {
			...run,
			status: "success",
			completedAt: "2025-06-01T01:00:00.000Z",
		};
		updateRun("test-auto", updated, TMP_DIR);

		const runs = readRuns("test-auto", undefined, TMP_DIR);
		expect(runs.length).toBe(1);
		expect(runs[0]!.status).toBe("success");
		expect(runs[0]!.completedAt).toBe("2025-06-01T01:00:00.000Z");
	});

	test("updates last matching line when multiple runs exist", () => {
		const run1 = makeRun({ id: "run_same", status: "running" });
		const run2 = makeRun({ id: "run_other", status: "success" });

		appendRun("test-auto", run1, TMP_DIR);
		appendRun("test-auto", run2, TMP_DIR);

		const updated: AutomationRun = {
			...run1,
			status: "failure",
			error: "Something broke",
		};
		updateRun("test-auto", updated, TMP_DIR);

		const runs = readRuns("test-auto", undefined, TMP_DIR);
		const matched = runs.find((r) => r.id === "run_same");
		expect(matched!.status).toBe("failure");
		expect(matched!.error).toBe("Something broke");
	});

	test("no-op when file does not exist", () => {
		const run = makeRun({ id: "run_x" });
		// Should not throw
		updateRun("nonexistent", run, TMP_DIR);
	});
});

// ---------------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------------

describe("detectOrphans", () => {
	test("marks running runs without completedAt as failure", () => {
		const orphan = makeRun({
			id: "run_orphan",
			status: "running",
			completedAt: undefined,
		});
		appendRun("test-auto", orphan, TMP_DIR);

		const count = detectOrphans(TMP_DIR);
		expect(count).toBe(1);

		const runs = readRuns("test-auto", undefined, TMP_DIR);
		expect(runs[0]!.status).toBe("failure");
		expect(runs[0]!.error).toContain("Orphaned run");
		expect(runs[0]!.completedAt).toBeDefined();
	});

	test("does not touch completed running runs", () => {
		const run = makeRun({
			id: "run_completed",
			status: "running",
			completedAt: "2025-06-01T01:00:00.000Z",
		});
		appendRun("test-auto", run, TMP_DIR);

		const count = detectOrphans(TMP_DIR);
		expect(count).toBe(0);

		const runs = readRuns("test-auto", undefined, TMP_DIR);
		expect(runs[0]!.status).toBe("running");
	});

	test("handles multiple orphans across files", () => {
		const orphan1 = makeRun({
			id: "run_o1",
			automationId: "auto-a",
			status: "running",
			completedAt: undefined,
		});
		const orphan2 = makeRun({
			id: "run_o2",
			automationId: "auto-b",
			status: "running",
			completedAt: undefined,
		});

		appendRun("auto-a", orphan1, TMP_DIR);
		appendRun("auto-b", orphan2, TMP_DIR);

		const count = detectOrphans(TMP_DIR);
		expect(count).toBe(2);
	});

	test("returns 0 when no runs directory exists", () => {
		const emptyDir = join(TMP_DIR, "empty-store");
		mkdirSync(emptyDir, { recursive: true });
		const count = detectOrphans(emptyDir);
		expect(count).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe("pruning", () => {
	test("prunes oldest when exceeding 1000 lines", () => {
		// Seed 1000 runs
		const runsSubDir = join(TMP_DIR, "runs");
		mkdirSync(runsSubDir, { recursive: true });
		const filePath = join(runsSubDir, "prune-test.jsonl");

		const lines: string[] = [];
		for (let i = 0; i < 1000; i++) {
			lines.push(
				JSON.stringify(
					makeRun({
						id: `run_${String(i).padStart(4, "0")}`,
						automationId: "prune-test",
						startedAt: new Date(
							Date.parse("2025-01-01T00:00:00Z") + i * 1000,
						).toISOString(),
					}),
				),
			);
		}
		writeFileSync(filePath, lines.join("\n") + "\n");

		// Append the 1001st run
		const newRun = makeRun({
			id: "run_1000",
			automationId: "prune-test",
			startedAt: "2025-02-01T00:00:00.000Z",
		});
		appendRun("prune-test", newRun, TMP_DIR);

		// Verify file has exactly 1000 lines
		const content = readFileSync(filePath, "utf-8").trimEnd();
		const resultLines = content.split("\n");
		expect(resultLines.length).toBe(1000);

		// Oldest run (run_0000) should be gone, newest (run_1000) should be present
		const parsed = resultLines.map(
			(l) => JSON.parse(l) as AutomationRun,
		);
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
			appendRun(
				"test-auto",
				makeRun({
					id: `run_${i}`,
					startedAt: new Date(Date.now() + i * 1000).toISOString(),
				}),
				TMP_DIR,
			);
		}

		const runs = readRuns("test-auto", { limit: 5 }, TMP_DIR);
		expect(runs.length).toBe(5);
	});

	test("status filter returns only matching runs", () => {
		appendRun("test-auto", makeRun({ id: "r1", status: "success" }), TMP_DIR);
		appendRun("test-auto", makeRun({ id: "r2", status: "failure" }), TMP_DIR);
		appendRun("test-auto", makeRun({ id: "r3", status: "success" }), TMP_DIR);
		appendRun("test-auto", makeRun({ id: "r4", status: "failure" }), TMP_DIR);

		const failures = readRuns("test-auto", { status: "failure" }, TMP_DIR);
		expect(failures.length).toBe(2);
		expect(failures.every((r) => r.status === "failure")).toBe(true);
	});

	test("since filter returns only runs after timestamp", () => {
		appendRun(
			"test-auto",
			makeRun({ id: "old", startedAt: "2025-01-01T00:00:00.000Z" }),
			TMP_DIR,
		);
		appendRun(
			"test-auto",
			makeRun({ id: "new", startedAt: "2025-06-01T00:00:00.000Z" }),
			TMP_DIR,
		);

		const runs = readRuns(
			"test-auto",
			{ since: "2025-03-01T00:00:00.000Z" },
			TMP_DIR,
		);
		expect(runs.length).toBe(1);
		expect(runs[0]!.id).toBe("new");
	});
});

// ---------------------------------------------------------------------------
// readAllRuns
// ---------------------------------------------------------------------------

describe("readAllRuns", () => {
	test("aggregates runs across multiple automation files", () => {
		appendRun(
			"auto-a",
			makeRun({
				id: "ra1",
				automationId: "auto-a",
				startedAt: "2025-06-01T00:00:00.000Z",
			}),
			TMP_DIR,
		);
		appendRun(
			"auto-b",
			makeRun({
				id: "rb1",
				automationId: "auto-b",
				startedAt: "2025-06-01T01:00:00.000Z",
			}),
			TMP_DIR,
		);
		appendRun(
			"auto-a",
			makeRun({
				id: "ra2",
				automationId: "auto-a",
				startedAt: "2025-06-01T02:00:00.000Z",
			}),
			TMP_DIR,
		);

		const all = readAllRuns(undefined, TMP_DIR);
		expect(all.length).toBe(3);
		// Newest first
		expect(all[0]!.id).toBe("ra2");
		expect(all[1]!.id).toBe("rb1");
		expect(all[2]!.id).toBe("ra1");
	});

	test("applies filters across all files", () => {
		appendRun(
			"auto-a",
			makeRun({ id: "ra1", automationId: "auto-a", status: "failure" }),
			TMP_DIR,
		);
		appendRun(
			"auto-b",
			makeRun({ id: "rb1", automationId: "auto-b", status: "success" }),
			TMP_DIR,
		);

		const failures = readAllRuns({ status: "failure" }, TMP_DIR);
		expect(failures.length).toBe(1);
		expect(failures[0]!.id).toBe("ra1");
	});

	test("returns empty when runs directory does not exist", () => {
		const emptyDir = join(TMP_DIR, "no-runs");
		mkdirSync(emptyDir, { recursive: true });
		const runs = readAllRuns(undefined, emptyDir);
		expect(runs.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Automation ID validation (path traversal prevention)
// ---------------------------------------------------------------------------

describe("automation id validation", () => {
	test("rejects path traversal IDs", () => {
		const run = makeRun({ automationId: "../../etc/passwd" });
		expect(() => appendRun("../../etc/passwd", run, TMP_DIR)).toThrow(
			/Invalid automation ID/,
		);
	});

	test("rejects empty string", () => {
		const run = makeRun({ automationId: "" });
		expect(() => appendRun("", run, TMP_DIR)).toThrow(
			/Invalid automation ID/,
		);
	});

	test("rejects IDs with slashes", () => {
		const run = makeRun({ automationId: "foo/bar" });
		expect(() => appendRun("foo/bar", run, TMP_DIR)).toThrow(
			/Invalid automation ID/,
		);
	});

	test("rejects IDs with dots", () => {
		const run = makeRun({ automationId: "foo.bar" });
		expect(() => appendRun("foo.bar", run, TMP_DIR)).toThrow(
			/Invalid automation ID/,
		);
	});

	test("rejects IDs with uppercase letters", () => {
		const run = makeRun({ automationId: "My-Auto" });
		expect(() => appendRun("My-Auto", run, TMP_DIR)).toThrow(
			/Invalid automation ID/,
		);
	});

	test("rejects IDs with leading hyphens", () => {
		const run = makeRun({ automationId: "-leading" });
		expect(() => appendRun("-leading", run, TMP_DIR)).toThrow(
			/Invalid automation ID/,
		);
	});

	test("rejects IDs with trailing hyphens", () => {
		const run = makeRun({ automationId: "trailing-" });
		expect(() => appendRun("trailing-", run, TMP_DIR)).toThrow(
			/Invalid automation ID/,
		);
	});

	test("accepts valid kebab-case automation IDs", () => {
		const run = makeRun({ automationId: "daily-report" });
		appendRun("daily-report", run, TMP_DIR);
		const runs = readRuns("daily-report", undefined, TMP_DIR);
		expect(runs.length).toBe(1);
	});

	test("accepts single-segment automation IDs", () => {
		const run = makeRun({ automationId: "cleanup" });
		appendRun("cleanup", run, TMP_DIR);
		const runs = readRuns("cleanup", undefined, TMP_DIR);
		expect(runs.length).toBe(1);
	});

	test("accepts automation IDs with numbers", () => {
		const run = makeRun({ automationId: "report-2025" });
		appendRun("report-2025", run, TMP_DIR);
		const runs = readRuns("report-2025", undefined, TMP_DIR);
		expect(runs.length).toBe(1);
	});

	test("validation applies to readRuns", () => {
		expect(() => readRuns("../../etc/passwd", undefined, TMP_DIR)).toThrow(
			/Invalid automation ID/,
		);
	});

	test("validation applies to updateRun", () => {
		const run = makeRun({ automationId: "../../etc/passwd" });
		expect(() => updateRun("../../etc/passwd", run, TMP_DIR)).toThrow(
			/Invalid automation ID/,
		);
	});
});
