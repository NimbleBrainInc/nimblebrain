/**
 * Unit tests for credential cleanup on workspace bundle uninstall.
 *
 * Targets `src/bundles/workspace-ops.ts:uninstallBundleFromWorkspace`,
 * the live path consumed by system-tools via ManageBundleContext. (A
 * dead duplicate previously existed in `src/runtime/workspace-runtime.ts`;
 * deleted in #195's slugify cleanup.) Must clean up the workspace-scoped
 * credential file as part of uninstall (best-effort — failures log a
 * warning but do not fail the uninstall).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstallBundleFromWorkspace } from "../../src/bundles/workspace-ops.ts";
import {
  getWorkspaceCredentials,
  saveWorkspaceCredential,
} from "../../src/config/workspace-credentials.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";

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

// `newsapi` is the legacy short-slug deriveServerName result for
// `@nimblebraininc/newsapi`. After #195 the catalog install path
// persists a slug like `dev-mpak-nimblebraininc-newsapi`; the test
// uses the legacy short slug to match what `system-tools` resolves
// from `deriveServerName(bundleName)` as the back-compat fallback
// when `ref.serverName` is absent on a pre-#195 install.
const SERVER_NAME = "newsapi";

describe("uninstallBundleFromWorkspace — credential cleanup", () => {
  test("removes the credential file for the uninstalled bundle", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
    expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toEqual({
      api_key: "sk-abc",
    });

    const registry = new ToolRegistry();
    registry.addSource(makeStubSource(SERVER_NAME));

    await uninstallBundleFromWorkspace(WS_A, BUNDLE, SERVER_NAME, registry, { workDir });

    expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toBeNull();
    expect(registry.hasSource(SERVER_NAME)).toBe(false);
  });

  test("does not throw when no credential file exists", async () => {
    const registry = new ToolRegistry();
    registry.addSource(makeStubSource(SERVER_NAME));

    await expect(
      uninstallBundleFromWorkspace(WS_A, BUNDLE, SERVER_NAME, registry, { workDir }),
    ).resolves.toBeUndefined();
    expect(registry.hasSource(SERVER_NAME)).toBe(false);
  });

  test("uninstalling one bundle does not touch credentials of another bundle in the same workspace", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-a", workDir);
    await saveWorkspaceCredential(WS_A, OTHER_BUNDLE, "api_key", "sk-b", workDir);

    const registry = new ToolRegistry();
    registry.addSource(makeStubSource(SERVER_NAME));

    await uninstallBundleFromWorkspace(WS_A, BUNDLE, SERVER_NAME, registry, { workDir });

    expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toBeNull();
    expect(await getWorkspaceCredentials(WS_A, OTHER_BUNDLE, workDir)).toEqual({
      api_key: "sk-b",
    });
  });

  test("uninstalling a bundle in one workspace does not touch the same bundle's credentials in another workspace", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-alpha", workDir);
    await saveWorkspaceCredential(WS_B, BUNDLE, "api_key", "sk-beta", workDir);

    const registry = new ToolRegistry();
    registry.addSource(makeStubSource(SERVER_NAME));

    await uninstallBundleFromWorkspace(WS_A, BUNDLE, SERVER_NAME, registry, { workDir });

    expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toBeNull();
    expect(await getWorkspaceCredentials(WS_B, BUNDLE, workDir)).toEqual({
      api_key: "sk-beta",
    });
  });

  test("throws if the bundle is not registered (no source removal, no credential change)", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);

    const registry = new ToolRegistry();
    // No source registered.

    await expect(
      uninstallBundleFromWorkspace(WS_A, BUNDLE, SERVER_NAME, registry, { workDir }),
    ).rejects.toThrow(/No bundle "newsapi" found in workspace "ws_alpha"/);

    // Credentials preserved (uninstall threw before the cleanup step).
    expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toEqual({
      api_key: "sk-abc",
    });
  });
});
