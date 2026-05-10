import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallBundleFromWorkspace } from "../../src/bundles/workspace-ops.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { resolveBundleServerName } from "../../src/tools/system-tools.ts";
import type { ToolSource } from "../../src/tools/types.ts";

/**
 * Pins the contract `uninstallBundleFromWorkspace` was reshaped for in
 * QA round 4: caller passes the *resolved* `serverName` (looked up from
 * `workspace.json#bundles[].serverName` with `deriveServerName` as
 * back-compat fallback), and the function targets that source — not a
 * fresh `deriveServerName(bundleName)` derivation.
 *
 * Without this contract, a bundle installed via the catalog (which
 * persists `slugifyServerName(entry.id)` on the BundleRef) couldn't be
 * uninstalled by `manage_app uninstall @scope/name` — the agent path
 * computed the OLD short slug and missed the registered source.
 */

function makeFakeSource(name: string): ToolSource {
  return {
    name,
    tools: async () => [],
    execute: async () => ({ content: [], isError: false }),
    stop: async () => {},
  };
}

describe("uninstallBundleFromWorkspace", () => {
  test("removes the source whose name matches the resolved serverName, not deriveServerName(bundleName)", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "uninstall-test-"));
    try {
      const registry = new ToolRegistry();
      // Mirror what the catalog install path persists: a slugified
      // canonical reverse-DNS form, distinct from what
      // deriveServerName("@x/echo") would compute (which is "echo").
      const slugifiedServerName = "dev-mpak-x-echo";
      await registry.addSource(makeFakeSource(slugifiedServerName));
      expect(registry.hasSource(slugifiedServerName)).toBe(true);

      // Caller (system-tools.uninstallBundleFromWorkspaceViaCtx) is
      // responsible for resolving the serverName from workspace.json
      // before calling this helper. We pass it through here.
      await uninstallBundleFromWorkspace(
        "ws_acme",
        "@x/echo", // bundleName from manage_app input
        slugifiedServerName, // resolved from ref.serverName
        registry,
        { workDir },
      );

      expect(registry.hasSource(slugifiedServerName)).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("throws when the resolved serverName isn't registered (defends against caller resolving wrong key)", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "uninstall-test-"));
    try {
      const registry = new ToolRegistry();
      await registry.addSource(makeFakeSource("dev-mpak-x-echo"));

      // Caller passes the OLD short-slug derivation by mistake — the
      // helper rejects rather than silently no-oping.
      await expect(
        uninstallBundleFromWorkspace("ws_acme", "@x/echo", "echo", registry, { workDir }),
      ).rejects.toThrow(/No bundle "echo" found/);

      // The real source is unaffected.
      expect(registry.hasSource("dev-mpak-x-echo")).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

/**
 * The helper above pins the contract once the resolved serverName is
 * already in hand. These tests pin the *resolver* itself —
 * `manage_app uninstall`'s lookup against `workspace.json` — so a
 * future refactor that drops the resolver doesn't silently re-introduce
 * the catalog-installed-bundle uninstall regression.
 */
describe("resolveBundleServerName", () => {
  test("returns the persisted slug for a catalog-installed bundle (post-#195)", () => {
    const ws = {
      bundles: [{ name: "@x/echo", serverName: "dev-mpak-x-echo" }],
    };
    expect(resolveBundleServerName("@x/echo", ws)).toBe("dev-mpak-x-echo");
  });

  test("falls back to deriveServerName for legacy refs missing serverName (pre-#195)", () => {
    const ws = {
      bundles: [{ name: "@x/echo" }],
    };
    expect(resolveBundleServerName("@x/echo", ws)).toBe("echo");
  });

  test("falls back to deriveServerName when workspace is null", () => {
    expect(resolveBundleServerName("@x/echo", null)).toBe("echo");
  });

  test("falls back to deriveServerName when bundle isn't in workspace.bundles", () => {
    const ws = {
      bundles: [{ name: "@y/other", serverName: "dev-mpak-y-other" }],
    };
    expect(resolveBundleServerName("@x/echo", ws)).toBe("echo");
  });
});
