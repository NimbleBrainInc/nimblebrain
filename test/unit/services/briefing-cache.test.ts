import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BundleInstance } from "../../../src/bundles/types.ts";
import { BriefingCache, computeBriefingFingerprint } from "../../../src/services/briefing-cache.ts";
import type { BriefingOutput } from "../../../src/services/home-types.ts";

function makeBriefing(overrides?: Partial<BriefingOutput>): BriefingOutput {
	return {
		greeting: "Good afternoon, Test",
		date: "Wednesday, March 25, 2026",
		lede: "All clear.",
		sections: [],
		state: "all-clear",
		generated_at: new Date().toISOString(),
		cached: false,
		...overrides,
	};
}

describe("BriefingCache", () => {
	let cache: BriefingCache;

	beforeEach(() => {
		cache = new BriefingCache(30); // 30 min TTL
	});

	test("initial state: get() returns null", () => {
		expect(cache.get("fp-1")).toBeNull();
	});

	test("set() then get() with the same fingerprint returns the briefing", () => {
		cache.set(makeBriefing(), "fp-1");
		const result = cache.get("fp-1");
		expect(result).not.toBeNull();
		expect(result!.cached).toBe(true);
		expect(result!.greeting).toBe("Good afternoon, Test");
	});

	test("get() with a changed fingerprint returns null — the data moved on", () => {
		cache.set(makeBriefing(), "fp-1");
		expect(cache.get("fp-2")).toBeNull();
	});

	test("re-set with a new fingerprint serves the fresh briefing", () => {
		cache.set(makeBriefing(), "fp-1");
		expect(cache.get("fp-2")).toBeNull();
		cache.set(makeBriefing({ lede: "Updated" }), "fp-2");
		const result = cache.get("fp-2");
		expect(result).not.toBeNull();
		expect(result!.lede).toBe("Updated");
	});

	test("expired cache returns null even when the fingerprint matches", () => {
		const originalNow = Date.now;
		try {
			Date.now = originalNow;
			cache.set(makeBriefing(), "fp-1");
			Date.now = () => originalNow() + 31 * 60 * 1000;
			expect(cache.get("fp-1")).toBeNull();
		} finally {
			Date.now = originalNow;
		}
	});

	test("not expired within TTL", () => {
		const originalNow = Date.now;
		try {
			cache.set(makeBriefing(), "fp-1");
			Date.now = () => originalNow() + 15 * 60 * 1000; // within 30 min TTL
			expect(cache.get("fp-1")).not.toBeNull();
		} finally {
			Date.now = originalNow;
		}
	});
});

/** Minimal BundleInstance — computeBriefingFingerprint reads only these fields. */
function instance(bundleName: string, state: string, entityDataRoot?: string): BundleInstance {
	return { bundleName, state, entityDataRoot } as unknown as BundleInstance;
}

describe("computeBriefingFingerprint", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "briefing-fp-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("is stable when nothing changes", () => {
		const logDir = join(dir, "logs");
		mkdirSync(logDir);
		writeFileSync(join(logDir, "a.jsonl"), "line\n");
		expect(computeBriefingFingerprint(logDir, [])).toBe(computeBriefingFingerprint(logDir, []));
	});

	test("changes when a log file is added", () => {
		const logDir = join(dir, "logs");
		mkdirSync(logDir);
		writeFileSync(join(logDir, "a.jsonl"), "line\n");
		const before = computeBriefingFingerprint(logDir, []);
		writeFileSync(join(logDir, "b.jsonl"), "line\n");
		expect(computeBriefingFingerprint(logDir, [])).not.toBe(before);
	});

	test("changes when a file's content changes", () => {
		const logDir = join(dir, "logs");
		mkdirSync(logDir);
		const file = join(logDir, "a.jsonl");
		writeFileSync(file, "line\n");
		const before = computeBriefingFingerprint(logDir, []);
		writeFileSync(file, "line one\nline two\n");
		expect(computeBriefingFingerprint(logDir, [])).not.toBe(before);
	});

	test("reflects a running bundle's entity data — the issue's core case", () => {
		const logDir = join(dir, "logs");
		mkdirSync(logDir);
		const entityRoot = join(dir, "todo-data");
		mkdirSync(join(entityRoot, "tasks"), { recursive: true });
		writeFileSync(join(entityRoot, "tasks", "t1.json"), "{}");

		const before = computeBriefingFingerprint(logDir, [instance("todo", "running", entityRoot)]);
		writeFileSync(join(entityRoot, "tasks", "t2.json"), "{}");
		const after = computeBriefingFingerprint(logDir, [instance("todo", "running", entityRoot)]);
		expect(after).not.toBe(before);
	});

	test("excludes bundles that are not running", () => {
		const logDir = join(dir, "logs");
		mkdirSync(logDir);
		const withStopped = computeBriefingFingerprint(logDir, [
			instance("todo", "stopped", join(dir, "todo-data")),
		]);
		expect(withStopped).toBe(computeBriefingFingerprint(logDir, []));
	});

	test("missing directories are tolerated, not crashes", () => {
		expect(() =>
			computeBriefingFingerprint(join(dir, "no-logs"), [
				instance("todo", "running", join(dir, "absent")),
			]),
		).not.toThrow();
	});

	test("a dangling symlink in a data dir does not crash the walk", () => {
		const logDir = join(dir, "logs");
		mkdirSync(logDir);
		symlinkSync(join(dir, "does-not-exist"), join(logDir, "broken-link"));
		expect(() => computeBriefingFingerprint(logDir, [])).not.toThrow();
	});

	test("a symlink to a directory is a stable leaf, not infinite recursion", () => {
		const logDir = join(dir, "logs");
		mkdirSync(logDir);
		symlinkSync(dir, join(logDir, "self-link"));
		const fp = computeBriefingFingerprint(logDir, []);
		expect(fp).toBe(computeBriefingFingerprint(logDir, []));
	});
});
