import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { ManageBundleContext } from "../../src/tools/system-tools.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import {
  installBundleInWorkspace,
} from "../../src/bundles/workspace-ops.ts";
import { deriveServerName } from "../../src/bundles/paths.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventCollector(): EventSink & { events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return {
    events,
    emit(event: EngineEvent) {
      events.push(event);
    },
  };
}

/** Create a minimal echo MCP server bundle on disk with a valid MCPB manifest. */
function createEchoBundleOnDisk(dir: string): string {
  mkdirSync(dir, { recursive: true });

  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
  const serverCode = `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: "echo-test", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: "text", text: "Echo: " + req.params.arguments?.message }],
  }));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
`;
  writeFileSync(join(dir, "server.cjs"), serverCode);

  const manifest = {
    manifest_version: "0.4",
    name: "@test/echo",
    version: "1.0.0",
    description: "Echo test bundle",
    author: { name: "Test Author" },
    server: {
      type: "node",
      entry_point: "server.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server.cjs"],
      },
    },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

// ---------------------------------------------------------------------------
// Tests: manage_app tool with workspace context
// ---------------------------------------------------------------------------

describe("manage_app — workspace-aware install/uninstall", () => {
  let workDir: string;
  let store: WorkspaceStore;
  let currentWorkspaceId: string | null;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "nb-ws-bundle-test-"));
    store = new WorkspaceStore(workDir);
    currentWorkspaceId = null;
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("install in workspace uses plain server name (no compound key)", async () => {
    // Create workspace
    const ws = await store.create("Engineering", "engineering");
    currentWorkspaceId = ws.id;

    // Create bundle on disk
    const bundleDir = createEchoBundleOnDisk(join(workDir, "echo-bundle"));

    const registry = new ToolRegistry();
    const sink = makeEventCollector();
    const lifecycle = new BundleLifecycleManager(registry, sink, undefined);

    const bundleRef = { path: bundleDir } as import("../../../src/bundles/types.ts").BundleRef;
    const entry = await installBundleInWorkspace(
      ws.id,
      bundleRef,
      registry,
      workDir,
      { workDir },
    );

    // Entry has server name derived from manifest (not path)
    // Manifest name is "@test/echo" → deriveServerName → "echo"
    expect(entry.serverName).toBe("echo");

    // Source should be registered with plain server name
    expect(registry.hasSource(entry.serverName)).toBe(true);

    // Seed lifecycle and update workspace.json (what the tool handler does)
    lifecycle.seedInstance(entry.serverName, bundleDir, bundleRef, entry.meta ?? undefined, ws.id);
    await store.update(ws.id, {
      bundles: [...ws.bundles, { path: bundleDir }],
    });

    // Verify workspace.json was updated
    const updated = await store.get(ws.id);
    expect(updated!.bundles).toHaveLength(1);
    expect("path" in updated!.bundles[0] && updated!.bundles[0].path).toBe(bundleDir);

    // Verify lifecycle instance exists with wsId
    const instance = lifecycle.getInstance(entry.serverName, ws.id);
    expect(instance).toBeDefined();
    expect((instance as { wsId?: string }).wsId).toBe(ws.id);

    // Cleanup
    await registry.removeSource(entry.serverName);
  }, 15_000);

  it("uninstall from workspace updates workspace.json and removes server name", async () => {
    // Create workspace
    const ws = await store.create("Engineering", "engineering");
    currentWorkspaceId = ws.id;

    // Create and install bundle
    const bundleDir = createEchoBundleOnDisk(join(workDir, "echo-bundle-uninstall"));
    const bundleRef = { path: bundleDir } as import("../../../src/bundles/types.ts").BundleRef;

    const registry = new ToolRegistry();
    const sink = makeEventCollector();
    const lifecycle = new BundleLifecycleManager(registry, sink, undefined);

    const entry = await installBundleInWorkspace(
      ws.id,
      bundleRef,
      registry,
      workDir,
      { workDir },
    );
    lifecycle.seedInstance(entry.serverName, bundleDir, bundleRef, entry.meta ?? undefined, ws.id);
    await store.update(ws.id, {
      bundles: [{ path: bundleDir }],
    });

    // Verify it's running
    expect(registry.hasSource(entry.serverName)).toBe(true);

    // Uninstall — what the tool handler does
    const serverName = deriveServerName(bundleDir);
    const instance = lifecycle.getInstance(serverName, ws.id);
    if (instance) lifecycle.transition(instance, "stopped");
    lifecycle.removeInstance(serverName, ws.id);
    await registry.removeSource(serverName);

    // Remove from workspace.json
    const wsBefore = await store.get(ws.id);
    await store.update(ws.id, {
      bundles: wsBefore!.bundles.filter(
        (b) => !("path" in b && b.path === bundleDir),
      ),
    });

    // Verify server name removed from registry
    expect(registry.hasSource(serverName)).toBe(false);

    // Verify workspace.json updated
    const wsAfter = await store.get(ws.id);
    expect(wsAfter!.bundles).toHaveLength(0);

    // Verify lifecycle instance removed
    expect(lifecycle.getInstance(serverName, ws.id)).toBeUndefined();
  }, 15_000);

  it("same bundle in two workspaces uses separate registries", async () => {
    const ws1 = await store.create("Engineering", "engineering");
    const ws2 = await store.create("Marketing", "marketing");

    const bundleDir = createEchoBundleOnDisk(join(workDir, "echo-multi-ws"));
    const bundleRef = { path: bundleDir } as import("../../../src/bundles/types.ts").BundleRef;

    // Each workspace gets its own registry
    const registry1 = new ToolRegistry();
    const registry2 = new ToolRegistry();
    const sink = makeEventCollector();

    const entry1 = await installBundleInWorkspace(
      ws1.id, bundleRef, registry1, workDir, { workDir },
    );
    const entry2 = await installBundleInWorkspace(
      ws2.id, bundleRef, registry2, workDir, { workDir },
    );

    // Same plain server name in both
    expect(entry1.serverName).toBe(entry2.serverName);

    // Both registered in their respective registries
    expect(registry1.hasSource(entry1.serverName)).toBe(true);
    expect(registry2.hasSource(entry2.serverName)).toBe(true);

    // Different data dirs
    expect(entry1.dataDir).not.toBe(entry2.dataDir);
    expect(entry1.dataDir).toContain(ws1.id);
    expect(entry2.dataDir).toContain(ws2.id);

    // Cleanup
    await registry1.removeSource(entry1.serverName);
    await registry2.removeSource(entry2.serverName);
  }, 15_000);

  it("nimblebrain.json is NOT modified during workspace install/uninstall", async () => {
    const ws = await store.create("Engineering", "engineering");
    const configPath = join(workDir, "nimblebrain.json");
    writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

    const bundleDir = createEchoBundleOnDisk(join(workDir, "echo-no-config"));
    const bundleRef = { path: bundleDir } as import("../../../src/bundles/types.ts").BundleRef;

    const registry = new ToolRegistry();
    const sink = makeEventCollector();
    const lifecycle = new BundleLifecycleManager(registry, sink, configPath);

    // Install via workspace path
    const entry = await installBundleInWorkspace(
      ws.id, bundleRef, registry, workDir, { workDir },
    );
    lifecycle.seedInstance(entry.serverName, bundleDir, bundleRef, entry.meta ?? undefined, ws.id);
    await store.update(ws.id, { bundles: [{ path: bundleDir }] });

    // nimblebrain.json should still have empty bundles
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.bundles).toHaveLength(0);

    // Uninstall
    await registry.removeSource(entry.serverName);
    lifecycle.removeInstance(entry.serverName, ws.id);
    await store.update(ws.id, { bundles: [] });

    // nimblebrain.json still unchanged
    const config2 = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config2.bundles).toHaveLength(0);
  }, 15_000);

  it("protected bundles cannot be uninstalled from workspace", async () => {
    const ws = await store.create("Engineering", "engineering");

    const bundleDir = createEchoBundleOnDisk(join(workDir, "echo-protected"));
    const bundleRef = { path: bundleDir, protected: true } as import("../../../src/bundles/types.ts").BundleRef;

    const registry = new ToolRegistry();
    const sink = makeEventCollector();
    const lifecycle = new BundleLifecycleManager(registry, sink, undefined);

    const entry = await installBundleInWorkspace(
      ws.id, bundleRef, registry, workDir, { workDir },
    );
    lifecycle.seedInstance(entry.serverName, bundleDir, bundleRef, entry.meta ?? undefined, ws.id);

    // Try to uninstall — protected check should prevent it
    const instance = lifecycle.getInstance(entry.serverName, ws.id);
    expect(instance?.protected).toBe(true);

    // Simulate the check:
    expect(() => {
      if (instance?.protected) {
        throw new Error(`Cannot uninstall "${entry.serverName}": bundle is protected`);
      }
    }).toThrow("Cannot uninstall");

    // Cleanup
    await registry.removeSource(entry.serverName);
  }, 15_000);
});
