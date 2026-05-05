import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { createSystemTools } from "../../src/tools/system-tools.ts";
import type { ManageBundleContext } from "../../src/tools/system-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

const noopSink = new NoopEventSink();
const wsId = "ws_upgrade_test";
const bundleName = "@testscope/upgradeable";

/**
 * Write a fake manifest into the mpak cache so getBundleManifest() works.
 */
function writeFakeBundle(
  mpakHome: string,
  name: string,
  version: string,
): void {
  const safeName = name.replace("@", "").replace("/", "-");
  const cacheDir = join(mpakHome, "cache", safeName);
  mkdirSync(cacheDir, { recursive: true });
  const manifest = {
    manifest_version: "0.4",
    name,
    version,
    description: "Test bundle",
    author: { name: "Test" },
    server: {
      type: "node",
      entry_point: "server.js",
      mcp_config: { command: "node", args: ["${__dirname}/server.js"] },
    },
  };
  writeFileSync(join(cacheDir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(
    join(cacheDir, ".mpak-meta.json"),
    JSON.stringify({ version, pulledAt: new Date().toISOString(), platform: { os: "darwin", arch: "arm64" } }),
  );
}

async function makeRegistry() {
  const registry = new ToolRegistry();
  const source = await makeInProcessSource("test", [
    {
      name: "ping",
      description: "Ping",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ content: textContent("pong"), isError: false }),
    },
  ]);
  registry.addSource(source);
  return registry;
}

async function buildTools(opts: {
  mpakHome: string;
  workDir: string;
  lifecycle: BundleLifecycleManager;
}) {
  const registry = await makeRegistry();
  const store = new WorkspaceStore(opts.workDir);
  const ctx: ManageBundleContext = {
    getWorkspaceId: () => wsId,
    workspaceStore: store,
    workDir: opts.workDir,
    configDir: undefined,
    eventSink: noopSink,
  };
  const tools = await createSystemTools(
    () => registry,
    undefined,
    undefined,
    opts.lifecycle,
    undefined,
    undefined,
    undefined,
    undefined,
    noopSink,
    undefined,
    undefined,
    opts.mpakHome,
    undefined,
    undefined,
    undefined,
    undefined,
    ctx,
  );
  return { tools, registry };
}

// ---------------------------------------------------------------------------
// manage_app action=upgrade
// ---------------------------------------------------------------------------

describe("manage_app action=upgrade", () => {
  let workDir: string;
  let mpakHome: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-upgrade-test-"));
    mpakHome = mkdtempSync(join(tmpdir(), "nb-upgrade-mpak-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(mpakHome, { recursive: true, force: true });
  });

  it("upgrade requires lifecycle context", async () => {
    const registry = await makeRegistry();
    const tools = await createSystemTools(() => registry);
    const result = await tools.execute("manage_app", {
      action: "upgrade",
      name: bundleName,
    });
    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("lifecycle context");
  });

  it("upgrade requires workspace context (via manageBundleCtx)", async () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    const registry = await makeRegistry();
    // Pass lifecycle but no manageBundleCtx — should fail at the
    // shared guard that checks both before dispatching any action.
    const tools = await createSystemTools(
      () => registry,
      undefined,
      undefined,
      lifecycle,
    );
    const result = await tools.execute("manage_app", {
      action: "upgrade",
      name: bundleName,
    });
    expect(result.isError).toBe(true);
    expect(extractText(result.content)).toContain("lifecycle context");
  });

  it("upgrade action is listed in tool schema", async () => {
    const registry = await makeRegistry();
    const tools = await createSystemTools(() => registry);
    const allTools = await tools.tools();
    const manageApp = allTools.find((t) => t.name === "nb__manage_app");
    expect(manageApp).toBeDefined();
    const schema = manageApp!.inputSchema as { properties: { action: { enum: string[] } } };
    expect(schema.properties.action.enum).toContain("upgrade");
  });
});

// ---------------------------------------------------------------------------
// check_updates tool
// ---------------------------------------------------------------------------

describe("check_updates tool", () => {
  let workDir: string;
  let mpakHome: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-checkup-test-"));
    mpakHome = mkdtempSync(join(tmpdir(), "nb-checkup-mpak-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(mpakHome, { recursive: true, force: true });
  });

  it("check_updates tool is registered", async () => {
    const registry = await makeRegistry();
    const tools = await createSystemTools(() => registry);
    const allTools = await tools.tools();
    const names = allTools.map((t) => t.name);
    expect(names).toContain("nb__check_updates");
  });

  it("check_updates returns empty when no bundles installed", async () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    const { tools } = await buildTools({ mpakHome, workDir, lifecycle });
    const result = await tools.execute("check_updates", {});
    expect(result.isError).toBe(false);
    const text = extractText(result.content);
    expect(text).toContain("up to date");
  });

  it("check_updates reports up-to-date when registry has no newer version", async () => {
    writeFakeBundle(mpakHome, bundleName, "0.1.0");
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    lifecycle.seedInstance(
      "upgradeable",
      bundleName,
      { name: bundleName },
      { version: "0.1.0", ui: null, briefing: null, type: "plain", httpProxy: null },
      wsId,
    );
    const { tools } = await buildTools({ mpakHome, workDir, lifecycle });
    const result = await tools.execute("check_updates", {});
    expect(result.isError).toBe(false);
    // No real registry to query → checkForUpdate returns null → "up to date"
    expect(extractText(result.content)).toContain("up to date");
    expect(result.structuredContent).toBeUndefined();
  });

  it("check_updates only checks registry bundles, skips path-based", async () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    lifecycle.seedInstance(
      "local-bundle",
      "/path/to/bundle",
      { path: "/path/to/bundle" },
      { version: "1.0.0", ui: null, briefing: null, type: "plain", httpProxy: null },
      wsId,
    );
    const { tools } = await buildTools({ mpakHome, workDir, lifecycle });
    const result = await tools.execute("check_updates", {});
    expect(result.isError).toBe(false);
    expect(extractText(result.content)).toContain("up to date");
  });

  it("check_updates skips local bundles even when manifest has scoped name", async () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    // Local bundle whose manifest has a scoped name — previously this would
    // be offered for update because bundleName.startsWith("@") matched.
    lifecycle.seedInstance(
      "foo",
      "/dev/my-bundles/foo",
      { path: "/dev/my-bundles/foo" },
      {
        manifestName: "@myorg/foo",
        version: "0.1.0",
        ui: null,
        briefing: null,
        type: "plain",
        httpProxy: null,
      },
      wsId,
    );
    const instance = lifecycle.getInstance("foo", wsId);
    expect(instance?.bundleName).toBe("@myorg/foo");
    expect(instance?.installSource).toBe("local");

    const { tools } = await buildTools({ mpakHome, workDir, lifecycle });
    const result = await tools.execute("check_updates", {});
    expect(result.isError).toBe(false);
    expect(extractText(result.content)).toContain("up to date");
  });
});

// ---------------------------------------------------------------------------
// installSource field
// ---------------------------------------------------------------------------

describe("installSource on BundleInstance", () => {
  let mpakHome: string;

  beforeEach(() => {
    mpakHome = mkdtempSync(join(tmpdir(), "nb-source-test-"));
  });

  afterEach(() => {
    rmSync(mpakHome, { recursive: true, force: true });
  });

  it("seedInstance sets installSource=registry for named bundles", () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    lifecycle.seedInstance(
      "echo",
      "@nimblebraininc/echo",
      { name: "@nimblebraininc/echo" },
      { version: "1.0.0", ui: null, briefing: null, type: "plain", httpProxy: null },
      wsId,
    );
    const instance = lifecycle.getInstance("echo", wsId);
    expect(instance?.installSource).toBe("registry");
  });

  it("seedInstance sets installSource=local for path bundles", () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    lifecycle.seedInstance(
      "local-dev",
      "/home/dev/bundles/test",
      { path: "/home/dev/bundles/test" },
      { version: "0.1.0", ui: null, briefing: null, type: "plain", httpProxy: null },
      wsId,
    );
    const instance = lifecycle.getInstance("local-dev", wsId);
    expect(instance?.installSource).toBe("local");
  });

  it("seedInstance sets installSource=remote for url bundles", () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    lifecycle.seedInstance(
      "remote-svc",
      "https://api.example.com/mcp",
      { url: "https://api.example.com/mcp" },
      { version: "remote", ui: null, briefing: null, type: "plain", httpProxy: null },
      wsId,
    );
    const instance = lifecycle.getInstance("remote-svc", wsId);
    expect(instance?.installSource).toBe("remote");
  });
});

// ---------------------------------------------------------------------------
// upgrade event emission
// ---------------------------------------------------------------------------

describe("upgrade event emission", () => {
  let mpakHome: string;

  beforeEach(() => {
    mpakHome = mkdtempSync(join(tmpdir(), "nb-event-test-"));
  });

  afterEach(() => {
    rmSync(mpakHome, { recursive: true, force: true });
  });

  it("upgrade returns early when already at latest version", async () => {
    const events: import("../../src/engine/types.ts").EngineEvent[] = [];
    const sink = { emit: (e: import("../../src/engine/types.ts").EngineEvent) => events.push(e) };
    const lifecycle = new BundleLifecycleManager(sink, undefined, false, mpakHome);
    lifecycle.seedInstance(
      "upgradeable",
      bundleName,
      { name: bundleName },
      { version: "0.1.0", ui: null, briefing: null, type: "plain", httpProxy: null },
      wsId,
    );

    const registry = await makeRegistry();
    const fakeSource = await makeInProcessSource("upgradeable", [
      {
        name: "hello",
        description: "Hello",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ content: textContent("hi"), isError: false }),
      },
    ]);
    registry.addSource(fakeSource);

    // No newer version in mpak cache — upgrade should be a no-op
    const result = await lifecycle.upgrade(bundleName, wsId, registry);
    expect(result.from).toBe("0.1.0");
    expect(result.to).toBe("0.1.0");
    expect(result.serverName).toBe("upgradeable");

    // Source untouched, no events emitted
    expect(registry.hasSource("upgradeable")).toBe(true);
    const upgradeEvents = events.filter((e) => e.type === "bundle.upgraded");
    expect(upgradeEvents).toHaveLength(0);
  });

  it("upgrade throws for unknown bundle instance", async () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    const registry = await makeRegistry();

    await expect(
      lifecycle.upgrade("@nonexistent/bundle", wsId, registry),
    ).rejects.toThrow("No bundle instance found");
  });
});

