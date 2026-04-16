import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLocalBundle } from "../../src/bundles/resolve.ts";

const testDir = join(tmpdir(), `nimblebrain-resolve-${Date.now()}`);

afterAll(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("resolveLocalBundle", () => {
	it("resolves relative paths against configDir when provided", () => {
		// Simulate: configDir = /tmp/.../workdir, bundle at /tmp/.../mcp-servers/hello
		const workDir = join(testDir, "project", "workdir");
		const bundleDir = join(testDir, "project", "mcp-servers", "hello");
		mkdirSync(workDir, { recursive: true });
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(join(bundleDir, "manifest.json"), "{}");

		// Relative path as it would appear in config inside workdir
		const result = resolveLocalBundle("../mcp-servers/hello", workDir);
		expect(result).not.toBeNull();
		expect(result).toBe(join(workDir, "../mcp-servers/hello"));
	});

	it("returns null when relative path does not exist from configDir", () => {
		const workDir = join(testDir, "empty-workdir");
		mkdirSync(workDir, { recursive: true });

		const result = resolveLocalBundle("../nonexistent", workDir);
		expect(result).toBeNull();
	});

	it("falls back to CWD resolution when no configDir provided", () => {
		// Absolute paths should still work
		const bundleDir = join(testDir, "absolute-bundle");
		mkdirSync(bundleDir, { recursive: true });

		const result = resolveLocalBundle(bundleDir);
		expect(result).toBe(bundleDir);
	});
});
