/**
 * Unit tests for `assertPathInWorkspaceBundlesDir` — the guard that confines
 * any LLM-supplied `.mcpb` path to a single workspace's bundles directory.
 *
 * Without this guard, prompt-injected `manage_app({ action: "install",
 * path })` could spawn an arbitrary `.mcpb` archive under the platform user
 * with workspace credentials and `NB_INTERNAL_TOKEN` (for protected refs)
 * attached — see PR review of #170 Critical #1.
 *
 * Pure-logic tests: no Runtime, no HTTP server. Filesystem touched only to
 * exercise the realpath / lexical fallback distinction and the symlink
 * defense.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPathInWorkspaceBundlesDir } from "../../src/bundles/paths.ts";

const workDir = join(tmpdir(), `nb-bundle-path-guard-${Date.now()}`);
const wsId = "ws_test";
const bundlesDir = join(workDir, "workspaces", wsId, "bundles");

beforeAll(() => {
  mkdirSync(bundlesDir, { recursive: true });
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("assertPathInWorkspaceBundlesDir", () => {
  it("accepts a file directly inside the workspace bundles dir", () => {
    const ok = join(bundlesDir, "echo-aaaaaaaaaaaaaaaa.mcpb");
    writeFileSync(ok, "fake");
    expect(() => assertPathInWorkspaceBundlesDir(ok, workDir, wsId)).not.toThrow();
  });

  it("accepts a non-existent file with a path inside the dir (lexical fallback)", () => {
    // Uninstall after manual file deletion is allowed — the persisted
    // workspace.json path was vetted at install time.
    const stillInside = join(bundlesDir, "deleted-already.mcpb");
    expect(() => assertPathInWorkspaceBundlesDir(stillInside, workDir, wsId)).not.toThrow();
  });

  it("rejects an absolute path outside the bundles dir", () => {
    expect(() =>
      assertPathInWorkspaceBundlesDir("/tmp/elsewhere.mcpb", workDir, wsId),
    ).toThrow(/must live inside the workspace bundles directory/);
  });

  it("rejects a traversal path that resolves outside the bundles dir", () => {
    const traversal = join(bundlesDir, "..", "..", "elsewhere.mcpb");
    expect(() => assertPathInWorkspaceBundlesDir(traversal, workDir, wsId)).toThrow(
      /must live inside the workspace bundles directory/,
    );
  });

  it("rejects another workspace's bundles dir", () => {
    // Cross-tenant guard: a bundle uploaded to ws_a must not be installable
    // from ws_b. Even if the LLM in ws_b is told a valid path, the guard
    // bound to ws_b's dir refuses it.
    const otherWs = join(workDir, "workspaces", "ws_other", "bundles");
    mkdirSync(otherWs, { recursive: true });
    const otherBundle = join(otherWs, "neighbor.mcpb");
    writeFileSync(otherBundle, "fake");
    expect(() => assertPathInWorkspaceBundlesDir(otherBundle, workDir, wsId)).toThrow(
      /must live inside the workspace bundles directory/,
    );
  });

  it("rejects a symlink inside bundlesDir that targets outside the dir", () => {
    // Defense: an attacker who can write to bundlesDir (or a previous
    // exploit who got there) cannot escape via a symlink. realpath collapses
    // the link before the prefix check.
    const outside = join(workDir, "not-bundles", "evil.mcpb");
    mkdirSync(join(workDir, "not-bundles"), { recursive: true });
    writeFileSync(outside, "fake");
    const linkInside = join(bundlesDir, "evil-symlink.mcpb");
    symlinkSync(outside, linkInside);
    expect(() => assertPathInWorkspaceBundlesDir(linkInside, workDir, wsId)).toThrow(
      /must live inside the workspace bundles directory/,
    );
  });
});
