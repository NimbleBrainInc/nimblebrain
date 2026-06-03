import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { createManageAppsTool } from "../../src/tools/app-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

/**
 * Integration coverage for the org-scoped `manage_apps` tool: org-admin
 * gating, org-wide aggregation (deduped by bundle name), and the upgrade
 * no-op path. The full force-pull + re-spawn-everywhere path needs a real
 * registry + subprocess and is validated manually against `dev:worktree`; no
 * registry is reachable here, so `checkForUpdate` returns null (the
 * already-latest branch). The Runtime is stubbed to the tool's actual usage.
 */

const ADMIN: UserIdentity = {
  id: "usr_admin",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "admin",
  preferences: {},
};
const MEMBER: UserIdentity = {
  id: "usr_member",
  email: "member@example.test",
  displayName: "Member",
  orgRole: "member",
  preferences: {},
};

const REG_META = { version: "0.1.0", ui: null, briefing: null, type: "plain" as const };

interface Harness {
  workDir: string;
  lifecycle: BundleLifecycleManager;
  toolFor: (identity: UserIdentity | null) => ReturnType<typeof createManageAppsTool>;
}

function buildHarness(): Harness {
  const workDir = mkdtempSync(join(tmpdir(), "nb-app-upgrade-"));
  // mpakHome matches production layout so the tool's getMpak() resolves the
  // same (empty) cache → checkForUpdate returns null for uncached apps.
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined, false, join(workDir, "apps"));
  const registry = new ToolRegistry();
  const runtime = {
    getLifecycle: () => lifecycle,
    getWorkDir: () => workDir,
    getMpakHome: () => join(workDir, "apps"),
    getRegistryForWorkspace: (_id: string) => registry,
  } as unknown as Runtime;
  const toolFor = (identity: UserIdentity | null) =>
    createManageAppsTool({ runtime, getIdentity: () => identity });
  return { workDir, lifecycle, toolFor };
}

describe("manage_apps org-admin gating", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });
  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("denies every action to a non-admin member", async () => {
    for (const action of ["list", "check_updates", "upgrade"]) {
      const r = await h.toolFor(MEMBER).handler({ action, bundleName: "@x/y" });
      expect(r.isError).toBe(true);
      expect((r.structuredContent as { error?: string }).error).toBe("permission_denied");
    }
  });

  test("denies an unauthenticated caller", async () => {
    const r = await h.toolFor(null).handler({ action: "list" });
    expect(r.isError).toBe(true);
  });
});

describe("manage_apps list / check_updates", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });
  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("aggregates registry apps deduped by bundle name, excluding local installs", async () => {
    // Same registry app in two workspaces → one row, workspaceCount 2.
    h.lifecycle.seedInstance("echo", "@nimblebraininc/echo", { name: "@nimblebraininc/echo" }, REG_META, "ws_a");
    h.lifecycle.seedInstance("echo", "@nimblebraininc/echo", { name: "@nimblebraininc/echo" }, REG_META, "ws_b");
    // A local dev bundle must NOT appear — it has no registry version.
    h.lifecycle.seedInstance("local-dev", "/dev/foo", { path: "/dev/foo" }, undefined, "ws_a");

    const r = await h.toolFor(ADMIN).handler({ action: "list" });
    expect(r.isError).toBe(false);
    const apps = (r.structuredContent as { apps: Array<{ bundleName: string; workspaceCount: number }> })
      .apps;
    expect(apps).toHaveLength(1);
    expect(apps[0]?.bundleName).toBe("@nimblebraininc/echo");
    expect(apps[0]?.workspaceCount).toBe(2);
  });

  test("list is empty when no registry apps are installed", async () => {
    h.lifecycle.seedInstance("local-dev", "/dev/foo", { path: "/dev/foo" }, undefined, "ws_a");
    const r = await h.toolFor(ADMIN).handler({ action: "list" });
    expect((r.structuredContent as { apps: unknown[] }).apps).toEqual([]);
  });

  test("check_updates reports up to date when no newer version exists", async () => {
    h.lifecycle.seedInstance("echo", "@nimblebraininc/echo", { name: "@nimblebraininc/echo" }, REG_META, "ws_a");
    const r = await h.toolFor(ADMIN).handler({ action: "check_updates" });
    expect(r.isError).toBe(false);
    expect((r.structuredContent as { updates: unknown[] }).updates).toEqual([]);
    expect(extractText(r.content)).toContain("up to date");
  });
});

describe("manage_apps upgrade", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });
  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("requires a bundleName", async () => {
    const r = await h.toolFor(ADMIN).handler({ action: "upgrade" });
    expect(r.isError).toBe(true);
    expect(extractText(r.content)).toContain("bundleName is required");
  });

  test("errors for an app not installed anywhere", async () => {
    const r = await h.toolFor(ADMIN).handler({ action: "upgrade", bundleName: "@nope/none" });
    expect(r.isError).toBe(true);
    expect(extractText(r.content)).toContain("not installed in any workspace");
  });

  // No registry is reachable, so checkForUpdate returns null and upgrade
  // collapses to the no-op branch (which renders "already at the latest
  // version"). The confirmed already-at-latest-WITH-registry path is manual.
  test("upgrade is a successful no-op when no newer version is resolvable", async () => {
    h.lifecycle.seedInstance("echo", "@nimblebraininc/echo", { name: "@nimblebraininc/echo" }, REG_META, "ws_a");
    const r = await h.toolFor(ADMIN).handler({ action: "upgrade", bundleName: "@nimblebraininc/echo" });
    expect(r.isError).toBe(false);
    const sc = r.structuredContent as { ok: boolean; upgraded: boolean; from: string };
    expect(sc.ok).toBe(true);
    expect(sc.upgraded).toBe(false);
    expect(sc.from).toBe("0.1.0");
    expect(extractText(r.content)).toContain("already at the latest version");
  });
});
