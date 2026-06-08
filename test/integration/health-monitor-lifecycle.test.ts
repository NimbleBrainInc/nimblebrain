import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { log } from "../../src/cli/log.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { HealthMonitor } from "../../src/tools/health-monitor.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

/**
 * End-to-end integration of HealthMonitor's crash detection with the
 * bundle lifecycle's `transition()` funnel (issue #194).
 *
 * Unit tests cover `transition()` in isolation. This file exercises
 * the wiring that lives in `src/api/server.ts`:
 *
 *   HealthMonitor.check() observes !isAlive()
 *     → reportSourceTransition(source, "crashed")
 *       → source.getWorkspaceId() lookup
 *         → lifecycle.recordCrash(name, wsId)
 *           → transition(running → crashed)
 *             → log.warn fires once
 *             → instance.state === "crashed"
 *
 * Repeats the resolution to verify the (name, wsId) keying — same
 * server name in two workspaces, only the crashed one transitions.
 */

const testDir = join(tmpdir(), `nb-health-monitor-lifecycle-${Date.now()}`);

function setupTestDir() {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
}

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

function makeSink(): EventSink & { events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}

function createEchoBundleOnDisk(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
  const serverCode = `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server({ name: "echo-test", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
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
      mcp_config: { command: "node", args: ["${__dirname}/server.cjs"] },
    },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/**
 * Wire a HealthMonitor exactly the way `startServer` does — single hook
 * doing (name, wsId) resolution against the lifecycle. Mirroring the
 * production adapter shape is the point of this test file.
 */
function buildAdaptedMonitor(
  sources: McpSource[],
  lifecycle: BundleLifecycleManager,
  eventSink: EventSink,
): HealthMonitor {
  return new HealthMonitor(sources, eventSink, {
    // Short check interval so the test doesn't have to wait the 30s default,
    // though tests drive `check()` manually below; setting this defensively
    // in case anyone later switches to timer-driven assertions.
    checkIntervalMs: 1000,
    baseDelayMs: 1, // skip the real exponential backoff in restart attempts
    reportSourceTransition: (source, to) => {
      const wsId = source.getWorkspaceId();
      if (!wsId) return;
      const inst = lifecycle.getInstances().find((i) => i.serverName === source.name && i.wsId === wsId);
      if (!inst) return;
      if (to === "crashed") lifecycle.recordCrash(inst.serverName, inst.wsId);
      else if (to === "running") lifecycle.recordRecovery(inst.serverName, inst.wsId);
      else lifecycle.recordDead(inst.serverName, inst.wsId);
    },
  });
}

/** Force-mark an McpSource dead so HealthMonitor's `isAlive()` check
 *  returns false on the next sweep. Mirrors what `transport.onclose`
 *  does on a real subprocess crash, without the test having to find
 *  and SIGKILL the child PID.
 *
 *  Also stubs `restart()` to fail so the HealthMonitor's restart
 *  attempt doesn't immediately bounce the source back to healthy
 *  (which would flip `BundleInstance.state` back to running before
 *  the test's assertions can observe `crashed`). Production behavior
 *  on a real fatal crash with no recovery path matches this. */
function markSourceCrashed(source: McpSource): void {
  // McpSource keeps `dead` and `restart` accessible; casts here let the
  // test simulate a transport-level crash plus an irrecoverable bundle
  // (e.g. config invalid, vendor outage) without dragging in real
  // subprocess kill semantics or vendor-dependent retry behavior.
  const internal = source as unknown as {
    dead: boolean;
    restart: () => Promise<boolean>;
  };
  internal.dead = true;
  internal.restart = async () => false;
}

describe("HealthMonitor ↔ BundleLifecycleManager — end-to-end crash chain", () => {
  let originalWorkDir: string | undefined;
  let originalWarn: (msg: string) => void;
  let warnCalls: string[];

  beforeEach(() => {
    setupTestDir();
    originalWorkDir = process.env.NB_WORK_DIR;
    process.env.NB_WORK_DIR = testDir;
    originalWarn = log.warn;
    warnCalls = [];
    log.warn = (msg) => {
      warnCalls.push(msg);
    };
  });

  afterEach(() => {
    if (originalWorkDir === undefined) delete process.env.NB_WORK_DIR;
    else process.env.NB_WORK_DIR = originalWorkDir;
    log.warn = originalWarn;
  });

  it(
    "detected crash flows through reportSourceTransition → recordCrash → transition → warn",
    async () => {
      const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-chain"));
      const registry = new ToolRegistry();
      const sink = makeSink();
      const lifecycle = new BundleLifecycleManager(sink, undefined);
      // Provide the wsId-bearing deps factory so the spawned McpSource
      // carries a workspaceId. Resolver/rateLimit are never called
      // because the test never executes a tool call.
      lifecycle.setBundleMcpDepsFactory((wsId) => ({
        workspaceId: wsId,
        // biome-ignore lint/suspicious/noExplicitAny: test stubs, never invoked
        hostResources: {} as any,
        // biome-ignore lint/suspicious/noExplicitAny: test stubs, never invoked
        rateLimit: {} as any,
      }));

      const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");
      expect(instance.state).toBe("running");

      const source = registry.getSources().find((s) => s.name === instance.serverName);
      expect(source).toBeInstanceOf(McpSource);
      expect((source as McpSource).getWorkspaceId()).toBe("ws_test");

      const monitor = buildAdaptedMonitor([source as McpSource], lifecycle, sink);

      // Reset any boot-time logs so the assertions below see only the
      // transition output we're testing.
      warnCalls.length = 0;

      // Simulate the transport-level crash that production HealthMonitor
      // would see when a subprocess dies (transport.onclose → dead=true).
      markSourceCrashed(source as McpSource);

      await monitor.check();

      // BundleInstance.state reflects the crash, NOT a stale "running".
      expect(instance.state).toBe("crashed");
      // Exactly one operator-facing warn fired (the first-failure signal
      // — subsequent sweeps must NOT re-warn).
      expect(warnCalls.length).toBe(1);
      expect(warnCalls[0]).toContain("crashed");
      expect(warnCalls[0]).toContain(instance.serverName);

      // Subsequent sweeps with no recovery must not produce additional warns
      // (record.state guard inside checkOne — already in restarting/dead).
      await monitor.check();
      await monitor.check();
      expect(warnCalls.length).toBe(1);

      await registry.removeSource(instance.serverName);
    },
    30_000,
  );

  it(
    "same serverName in two workspaces: crash only updates the matching wsId's instance",
    async () => {
      const bundleDirA = createEchoBundleOnDisk(join(testDir, "echo-wsA"));
      const bundleDirB = createEchoBundleOnDisk(join(testDir, "echo-wsB"));

      const registryA = new ToolRegistry();
      const registryB = new ToolRegistry();
      const sink = makeSink();
      const lifecycle = new BundleLifecycleManager(sink, undefined);
      lifecycle.setBundleMcpDepsFactory((wsId) => ({
        workspaceId: wsId,
        // biome-ignore lint/suspicious/noExplicitAny: test stubs, never invoked
        hostResources: {} as any,
        // biome-ignore lint/suspicious/noExplicitAny: test stubs, never invoked
        rateLimit: {} as any,
      }));

      const instA = await lifecycle.installLocal(bundleDirA, registryA, "ws_alpha");
      const instB = await lifecycle.installLocal(bundleDirB, registryB, "ws_beta");

      // Both instances share the same serverName because the manifest
      // names match. The pre-#194 lookup keyed on name alone would
      // collapse them; the (name, wsId) key keeps them distinct.
      expect(instA.serverName).toBe(instB.serverName);

      const sourceA = registryA.getSources().find((s) => s.name === instA.serverName) as McpSource;
      const sourceB = registryB.getSources().find((s) => s.name === instB.serverName) as McpSource;
      expect(sourceA.getWorkspaceId()).toBe("ws_alpha");
      expect(sourceB.getWorkspaceId()).toBe("ws_beta");

      const monitor = buildAdaptedMonitor([sourceA, sourceB], lifecycle, sink);

      warnCalls.length = 0;

      // Crash ONLY workspace alpha's instance.
      markSourceCrashed(sourceA);

      await monitor.check();

      expect(instA.state).toBe("crashed");
      // The cross-workspace bug pre-fix: instB.state would also flip
      // because the lookup matched on name only and hit whichever
      // instance came first in iteration. With (name, wsId) keying, B
      // stays running.
      expect(instB.state).toBe("running");
      expect(warnCalls.length).toBe(1);

      await registryA.removeSource(instA.serverName);
      await registryB.removeSource(instB.serverName);
    },
    30_000,
  );
});
