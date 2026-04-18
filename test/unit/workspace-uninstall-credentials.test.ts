/**
 * Unit tests for credential cleanup on workspace bundle uninstall.
 *
 * Covers both exported `uninstallBundleFromWorkspace` paths:
 *  - `src/bundles/workspace-ops.ts` (consumed by system-tools via ManageBundleContext)
 *  - `src/runtime/workspace-runtime.ts` (exported for runtime/JIT paths)
 *
 * Both must clean up the workspace-scoped credential file as part of uninstall
 * (best-effort — failures log a warning but do not fail the uninstall).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { uninstallBundleFromWorkspace as uninstallOps } from "../../src/bundles/workspace-ops.ts";
import {
  getWorkspaceCredentials,
  saveWorkspaceCredential,
} from "../../src/config/workspace-credentials.ts";
import { uninstallBundleFromWorkspace as uninstallRuntime } from "../../src/runtime/workspace-runtime.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const BUNDLE = "@nimblebraininc/newsapi";
const OTHER_BUNDLE = "@acme/other";
const WS_A = "ws_alpha";
const WS_B = "ws_beta";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-uninstall-creds-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Minimal in-memory ToolSource stub. Stop is a no-op. */
function makeStubSource(name: string): ToolSource {
  return {
    name,
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async tools(): Promise<Tool[]> {
      return [];
    },
    async execute(): Promise<never> {
      throw new Error("not implemented");
    },
  };
}

// Both implementations share the same semantics — run the same test matrix
// against each to ensure parity.
const variants: ReadonlyArray<{
  label: string;
  uninstall: (
    wsId: string,
    bundleName: string,
    registry: ToolRegistry,
    opts?: { workDir?: string },
  ) => Promise<void>;
}> = [
  { label: "workspace-ops.ts", uninstall: uninstallOps },
  { label: "workspace-runtime.ts", uninstall: uninstallRuntime },
];

for (const { label, uninstall } of variants) {
  describe(`uninstallBundleFromWorkspace (${label}) — credential cleanup`, () => {
    test("removes the credential file for the uninstalled bundle", async () => {
      // Seed credentials.
      await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
      expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toEqual({
        api_key: "sk-abc",
      });

      // Register a stub source whose name matches the derived server name.
      // `newsapi` is the deriveServerName result for `@nimblebraininc/newsapi`.
      const registry = new ToolRegistry();
      registry.addSource(makeStubSource("newsapi"));

      await uninstall(WS_A, BUNDLE, registry, { workDir });

      // Credential file gone.
      expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toBeNull();
      // Source removed from registry.
      expect(registry.hasSource("newsapi")).toBe(false);
    });

    test("does not throw when no credential file exists", async () => {
      // No credentials saved for this bundle.
      const registry = new ToolRegistry();
      registry.addSource(makeStubSource("newsapi"));

      await expect(uninstall(WS_A, BUNDLE, registry, { workDir })).resolves.toBeUndefined();
      expect(registry.hasSource("newsapi")).toBe(false);
    });

    test("uninstalling one bundle does not touch credentials of another bundle in the same workspace", async () => {
      await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-a", workDir);
      await saveWorkspaceCredential(WS_A, OTHER_BUNDLE, "api_key", "sk-b", workDir);

      const registry = new ToolRegistry();
      registry.addSource(makeStubSource("newsapi"));

      await uninstall(WS_A, BUNDLE, registry, { workDir });

      // Target bundle's credentials are gone.
      expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toBeNull();
      // Other bundle's credentials are untouched.
      expect(await getWorkspaceCredentials(WS_A, OTHER_BUNDLE, workDir)).toEqual({
        api_key: "sk-b",
      });
    });

    test("uninstalling a bundle in one workspace does not touch the same bundle's credentials in another workspace", async () => {
      await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-alpha", workDir);
      await saveWorkspaceCredential(WS_B, BUNDLE, "api_key", "sk-beta", workDir);

      const registry = new ToolRegistry();
      registry.addSource(makeStubSource("newsapi"));

      await uninstall(WS_A, BUNDLE, registry, { workDir });

      expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toBeNull();
      expect(await getWorkspaceCredentials(WS_B, BUNDLE, workDir)).toEqual({
        api_key: "sk-beta",
      });
    });

    test("throws if the bundle is not registered (no source removal, no credential change)", async () => {
      // Pre-seed credentials to verify they're NOT removed when uninstall
      // bails out early on "not registered".
      await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);

      const registry = new ToolRegistry();
      // No source registered.

      await expect(uninstall(WS_A, BUNDLE, registry, { workDir })).rejects.toThrow(
        /No bundle "newsapi" found in workspace "ws_alpha"/,
      );

      // Credentials preserved (uninstall threw before the cleanup step).
      expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toEqual({
        api_key: "sk-abc",
      });
    });
  });
}
