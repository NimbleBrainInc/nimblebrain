import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

/**
 * Integration coverage for the `manage_connectors` upgrade surface added in the
 * PR #168 revival: `check_updates` (registry-only filtering) and `upgrade`
 * (admin gating + no-op). The Runtime is stubbed to the handlers' actual usage
 * — the full re-spawn against a live mpak registry is out of scope here; these
 * pin the routing, filtering, and authorization that wrap `lifecycle.upgrade`.
 *
 * No registry is reachable, so `checkForUpdate` returns null for every
 * (uncached) bundle — which is exactly the "already up to date" branch.
 */

const ADMIN: UserIdentity = {
  id: "usr_admin",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};
const OUTSIDER: UserIdentity = {
  id: "usr_outsider",
  email: "out@example.test",
  displayName: "Outsider",
  orgRole: "member",
  preferences: {},
};

const WS_ID = "ws_helix";

interface Harness {
  workDir: string;
  lifecycle: BundleLifecycleManager;
  workspaceStore: WorkspaceStore;
  toolFor: (identity: UserIdentity | null) => ReturnType<typeof createManageConnectorsTool>;
}

async function buildHarness(): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-conn-upgrade-"));
  const workspaceStore = new WorkspaceStore(workDir);
  // mpakHome matches production layout (join(workDir, "apps")) so the lifecycle
  // and the handlers' getMpak() resolve the same cache singleton.
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined, false, join(workDir, "apps"));
  const registry = new ToolRegistry();

  await workspaceStore.create("Helix", "helix");
  await workspaceStore.addMember(WS_ID, ADMIN.id, "admin");

  const runtime = {
    getWorkDir: () => workDir,
    getWorkspaceStore: () => workspaceStore,
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: (_id: string) => registry,
  } as unknown as Runtime;

  const toolFor = (identity: UserIdentity | null) => {
    const ctx: ManageConnectorsContext = {
      runtime,
      getIdentity: () => identity,
      getWorkspaceId: () => WS_ID,
    };
    return createManageConnectorsTool(ctx);
  };

  return { workDir, lifecycle, workspaceStore, toolFor };
}

describe("manage_connectors check_updates", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("reports nothing to check when only non-registry bundles are installed", async () => {
    h.lifecycle.seedInstance("local-dev", "/dev/foo", { path: "/dev/foo" }, undefined, WS_ID);
    const result = await h.toolFor(ADMIN).handler({ action: "check_updates" });
    expect(result.isError).toBe(false);
    expect(extractText(result.content)).toContain("No registry bundles");
    expect((result.structuredContent as { updates: unknown[] }).updates).toEqual([]);
  });

  test("checks registry bundles and reports up to date when no newer version exists", async () => {
    h.lifecycle.seedInstance(
      "echo",
      "@nimblebraininc/echo",
      { name: "@nimblebraininc/echo" },
      { version: "1.0.0", ui: null, briefing: null, type: "plain", httpProxy: null },
      WS_ID,
    );
    const result = await h.toolFor(ADMIN).handler({ action: "check_updates" });
    expect(result.isError).toBe(false);
    expect(extractText(result.content)).toContain("up to date");
    expect((result.structuredContent as { updates: unknown[] }).updates).toEqual([]);
  });
});

describe("manage_connectors upgrade", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("errors for a bundle that isn't installed", async () => {
    const result = await h.toolFor(ADMIN).handler({ action: "upgrade", serverName: "nope" });
    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("not installed");
  });

  test("requires workspace admin role", async () => {
    h.lifecycle.seedInstance("echo", "@nimblebraininc/echo", { name: "@nimblebraininc/echo" }, undefined, WS_ID);
    const result = await h.toolFor(OUTSIDER).handler({ action: "upgrade", serverName: "echo" });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error?: string }).error).toBe("permission_denied");
  });

  test("rejects upgrading a non-registry bundle", async () => {
    h.lifecycle.seedInstance("local-dev", "/dev/foo", { path: "/dev/foo" }, undefined, WS_ID);
    const result = await h.toolFor(ADMIN).handler({ action: "upgrade", serverName: "local-dev" });
    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("not a registry install");
  });

  test("reports already-latest as a successful no-op", async () => {
    h.lifecycle.seedInstance(
      "echo",
      "@nimblebraininc/echo",
      { name: "@nimblebraininc/echo" },
      { version: "1.0.0", ui: null, briefing: null, type: "plain", httpProxy: null },
      WS_ID,
    );
    const result = await h.toolFor(ADMIN).handler({ action: "upgrade", serverName: "echo" });
    expect(result.isError).toBe(false);
    const sc = result.structuredContent as { ok: boolean; upgraded: boolean; from: string };
    expect(sc.ok).toBe(true);
    expect(sc.upgraded).toBe(false);
    expect(sc.from).toBe("1.0.0");
    expect(extractText(result.content)).toContain("already at the latest version");
  });
});
