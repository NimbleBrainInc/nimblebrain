import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { PermissionStore } from "../../src/permissions/permission-store.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { FileCredentialStore } from "../../src/tools/credential-store.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

/**
 * End-to-end coverage for the boundary the unit tests don't quite
 * cross: writing a per-tool policy via `manage_connectors.set_permissions`
 * and having `ToolRegistry.execute` short-circuit the corresponding
 * call with the structured `tool_permission_denied` error.
 *
 * Each piece has unit coverage (PermissionStore, the gate inside
 * ToolRegistry, and the manage_connectors handlers) but a regression
 * in serialization, key construction, or restart-time hydration would
 * slip past those isolated tests. This file exercises the whole pipe
 * with real stores wired together.
 *
 * The Runtime is stubbed (only the ~5 methods the handlers need) so
 * we don't pay the cost of `Runtime.start()`'s identity / model /
 * transport plumbing for a pure permission-flow test.
 */

const ADMIN: UserIdentity = {
  id: "usr_admin",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

class MockSource implements ToolSource {
  readonly name: string;
  readonly callLog: string[] = [];
  constructor(name: string) {
    this.name = name;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async tools(): Promise<Tool[]> {
    return [
      {
        name: `${this.name}__safe_read`,
        description: "Safe read.",
        inputSchema: {},
        source: this.name,
      },
      {
        name: `${this.name}__destructive_write`,
        description: "Destructive write.",
        inputSchema: {},
        source: this.name,
      },
    ];
  }
  async execute(toolName: string): Promise<ToolResult> {
    this.callLog.push(toolName);
    return { content: textContent(`mock ${toolName} ok`), isError: false };
  }
}

interface Harness {
  workDir: string;
  wsId: string;
  workspaceStore: WorkspaceStore;
  credStore: FileCredentialStore;
  registryStore: RegistryStore;
  permissionStore: PermissionStore;
  lifecycle: BundleLifecycleManager;
  registry: ToolRegistry;
  source: MockSource;
  tool: ReturnType<typeof createManageConnectorsTool>;
}

async function buildHarness(): Promise<Harness> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-policy-e2e-"));
  const wsId = "ws_acme";
  const workspaceStore = new WorkspaceStore(workDir);
  const credStore = new FileCredentialStore(workDir);
  const registryStore = new RegistryStore(workDir);
  const permissionStore = new PermissionStore(workDir);
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  const registry = new ToolRegistry();
  const source = new MockSource("mock");
  registry.addSource(source);
  registry.setPermissionContext(wsId, permissionStore);

  // Provision workspace with an admin member so `set_permissions`'
  // workspace-admin gate passes.
  await workspaceStore.create("Acme", wsId.slice(3));
  await workspaceStore.addMember(wsId, ADMIN.id, "admin");

  // Seed an instance for "mock" so `set_permissions`' installed-
  // connector gate passes. The full install path (workspace.json
  // bundle ref + lifecycle.seedInstance) is exercised in
  // connector-tools.test.ts; here we focus on the gate→enforcement
  // boundary.
  lifecycle.seedInstance(
    "mock",
    "mock",
    { url: "https://mock.test/", serverName: "mock" },
    undefined,
    wsId,
  );

  const ctx: ManageConnectorsContext = {
    runtime: {
      getWorkDir: () => workDir,
      getWorkspaceStore: () => workspaceStore,
      getRegistryStore: () => registryStore,
      getPermissionStore: () => permissionStore,
      getLifecycle: () => lifecycle,
      getRegistryForWorkspace: () => registry,
    } as unknown as Runtime,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => wsId,
  };
  const tool = createManageConnectorsTool(ctx);

  return {
    workDir,
    wsId,
    workspaceStore,
    credStore,
    registryStore,
    permissionStore,
    lifecycle,
    registry,
    source,
    tool,
  };
}

describe("policy enforcement: set_permissions → registry.execute", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("disallow round-trip: policy written via tool blocks the call at dispatch", async () => {
    const setResult = await h.tool.handler({
      action: "set_permissions",
      serverName: "mock",
      scope: "workspace",
      tools: { destructive_write: "disallow" },
    });
    expect(setResult.isError).toBe(false);

    const callResult = await h.registry.execute({
      name: "mock__destructive_write",
      input: {},
    });
    expect(callResult.isError).toBe(true);
    expect(callResult.structuredContent).toMatchObject({
      error: "tool_permission_denied",
      connector: "mock",
      tool: "destructive_write",
      scope: "workspace",
    });
    // Source's execute was never invoked — gate short-circuited first.
    expect(h.source.callLog).toEqual([]);
  });

  test("allow round-trip: explicit allow lets the same tool through", async () => {
    await h.tool.handler({
      action: "set_permissions",
      serverName: "mock",
      scope: "workspace",
      tools: { safe_read: "allow" },
    });

    const result = await h.registry.execute({ name: "mock__safe_read", input: {} });
    expect(result.isError).toBe(false);
    expect(h.source.callLog).toEqual(["safe_read"]);
  });

  test("default-allow: tools without a recorded policy pass through", async () => {
    // Set policy on a sibling tool only — destructive_write stays default.
    await h.tool.handler({
      action: "set_permissions",
      serverName: "mock",
      scope: "workspace",
      tools: { safe_read: "disallow" },
    });

    // safe_read is now blocked.
    const blocked = await h.registry.execute({ name: "mock__safe_read", input: {} });
    expect(blocked.isError).toBe(true);

    // destructive_write was never written; default-allow lets it through.
    const allowed = await h.registry.execute({
      name: "mock__destructive_write",
      input: {},
    });
    expect(allowed.isError).toBe(false);
  });

  test("rotate: setting the same tool to allow lets a previously-blocked call through", async () => {
    await h.tool.handler({
      action: "set_permissions",
      serverName: "mock",
      scope: "workspace",
      tools: { safe_read: "disallow" },
    });
    expect((await h.registry.execute({ name: "mock__safe_read", input: {} })).isError).toBe(true);

    await h.tool.handler({
      action: "set_permissions",
      serverName: "mock",
      scope: "workspace",
      tools: { safe_read: "allow" },
    });
    const result = await h.registry.execute({ name: "mock__safe_read", input: {} });
    expect(result.isError).toBe(false);
  });

  test("get_permissions reflects the persisted state after set_permissions", async () => {
    await h.tool.handler({
      action: "set_permissions",
      serverName: "mock",
      scope: "workspace",
      tools: { destructive_write: "disallow" },
    });
    const getResult = await h.tool.handler({
      action: "get_permissions",
      serverName: "mock",
      scope: "workspace",
    });
    expect(getResult.isError).toBe(false);
    expect(getResult.structuredContent).toMatchObject({
      scope: "workspace",
      serverName: "mock",
      tools: { destructive_write: "disallow" },
    });
  });

  test("policies survive PermissionStore re-instantiation (restart hydration)", async () => {
    await h.tool.handler({
      action: "set_permissions",
      serverName: "mock",
      scope: "workspace",
      tools: { destructive_write: "disallow" },
    });

    // Simulate process restart: the file-backed store is the source of
    // truth. A fresh PermissionStore on the same workDir must see the
    // persisted policy. Wire it into a fresh registry and confirm the
    // gate still fires.
    const freshStore = new PermissionStore(h.workDir);
    const freshRegistry = new ToolRegistry();
    const freshSource = new MockSource("mock");
    freshRegistry.addSource(freshSource);
    freshRegistry.setPermissionContext(h.wsId, freshStore);

    const result = await freshRegistry.execute({
      name: "mock__destructive_write",
      input: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "tool_permission_denied",
      tool: "destructive_write",
    });
    expect(freshSource.callLog).toEqual([]);
  });
});
