/**
 * Tests asserting CORRECT behavior for .mcpb bundle upload fixes.
 *
 * Covers PR #170 review issues that can be tested without mocking the
 * `@nimblebrain/mpak-sdk` import surface:
 *
 * - Fix 1: Path traversal in handleBundleUpload filename
 * - Fix 3b: Uninstall workspace.json filter handles {path} entries
 *
 * Integration coverage for the remaining fixes (Fix 4, 5, 6 — startBundleSource
 * .mcpb branch + installBundleInWorkspace .mcpb-awareness) is deferred until
 * mpak-sdk@>=0.7.0 ships `validateMcpb`. Earlier drafts of this file used
 * `mock.module` to stub the SDK, but bun:test's module mocks are global within
 * the test process, so the stubs leaked across files and broke unrelated tests
 * (system-tools, lifecycle, etc.). Once the SDK exports `validateMcpb`,
 * integration tests for those fixes can land in `test/integration/` where
 * isolation is cheaper and real mpak fixtures can drive end-to-end paths.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Fix 1: Path traversal — uploaded filename must strip directory components
//
// handleBundleUpload joined sanitizeFilename(filename) onto bundlesDir.
// sanitizeFilename only strips control chars / quotes, so "../../etc/foo.mcpb"
// passed through unchanged → written path escaped bundlesDir.
//
// Fix introduces an exported helper `safeBundleFilename` that the handler
// uses to derive on-disk filename. Helper applies path.basename so all
// directory components are stripped.
// ---------------------------------------------------------------------------

describe("Fix 1: path traversal in handleBundleUpload", () => {
	it("safeBundleFilename strips traversal components", async () => {
		const { safeBundleFilename } = await import("../../src/api/handlers.ts");
		const result = safeBundleFilename("../../etc/cron.daily/evil.mcpb");
		// Random suffix appended before .mcpb to prevent collision; the
		// stem is still derived from basename only, so traversal segments
		// are stripped.
		expect(result).toMatch(/^evil-[0-9a-f]{16}\.mcpb$/);
	});

	it("safeBundleFilename strips absolute path components", async () => {
		const { safeBundleFilename } = await import("../../src/api/handlers.ts");
		const result = safeBundleFilename("/tmp/secrets/payload.mcpb");
		expect(result).toMatch(/^payload-[0-9a-f]{16}\.mcpb$/);
	});

	it("joined path with safeBundleFilename stays inside bundlesDir", async () => {
		const { safeBundleFilename } = await import("../../src/api/handlers.ts");
		const bundlesDir = "/home/.nimblebrain/workspaces/ws_dev/bundles";
		const result = join(bundlesDir, safeBundleFilename("../../evil.mcpb"));
		expect(result.startsWith(bundlesDir)).toBe(true);
	});

	it("safeBundleFilename returns a unique name on every call", async () => {
		const { safeBundleFilename } = await import("../../src/api/handlers.ts");
		// Two uploads with the same source filename must not produce the
		// same on-disk path — otherwise the second clobbers the first
		// silently and breaks any install pinned to that path.
		const a = safeBundleFilename("bundle.mcpb");
		const b = safeBundleFilename("bundle.mcpb");
		expect(a).not.toBe(b);
		expect(a).toMatch(/^bundle-[0-9a-f]{16}\.mcpb$/);
		expect(b).toMatch(/^bundle-[0-9a-f]{16}\.mcpb$/);
	});
});

// ---------------------------------------------------------------------------
// Fix 3b: uninstall workspace.json filter must match BOTH variants
//
// The previous filter took a single `target: string` and only matched
// `{name}` entries — path-installed bundles became permanent residents of
// workspace.json even after their tool source was deregistered. The new
// filter takes `{name?, path?}` and dispatches per-variant.
//
// This is a unit test of the filter contract. Production wiring lives in
// uninstallBundleFromWorkspaceViaCtx (system-tools.ts) and is exercised by
// manual testing today; integration coverage tracks with the deferred Fix
// 4/5/6 tests above.
// ---------------------------------------------------------------------------

describe("Fix 3b: uninstall workspace.json filter handles {path} entries", () => {
	function fixedFilter(
		bundles: Array<{ name?: string; path?: string }>,
		target: { name?: string; path?: string },
	): Array<{ name?: string; path?: string }> {
		return bundles.filter((b) => {
			if (target.name && "name" in b) return b.name !== target.name;
			if (target.path && "path" in b) return b.path !== target.path;
			return true;
		});
	}

	it("removing a path-based bundle removes the {path} entry", () => {
		const bundles = [
			{ name: "@acme/hello" },
			{ path: "/uploads/custom.mcpb" },
			{ name: "@acme/world" },
		];

		const result = fixedFilter(bundles, { path: "/uploads/custom.mcpb" });

		expect(result).toHaveLength(2);
		expect(
			result.some((b) => "path" in b && b.path === "/uploads/custom.mcpb"),
		).toBe(false);
	});

	it("removing a named bundle still works", () => {
		const bundles = [
			{ name: "@acme/hello" },
			{ path: "/uploads/custom.mcpb" },
			{ name: "@acme/world" },
		];

		const result = fixedFilter(bundles, { name: "@acme/hello" });

		expect(result).toHaveLength(2);
		expect(
			result.some((b) => "name" in b && b.name === "@acme/hello"),
		).toBe(false);
	});

	it("name-targeted filter does not accidentally match path entries", () => {
		const bundles = [
			{ path: "/uploads/echo.mcpb" },
			{ name: "/uploads/echo.mcpb" },
		];

		const result = fixedFilter(bundles, { name: "/uploads/echo.mcpb" });

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ path: "/uploads/echo.mcpb" });
	});
});
