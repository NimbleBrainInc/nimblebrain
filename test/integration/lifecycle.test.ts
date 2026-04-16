import { describe, expect, it, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleInstance } from "../../src/bundles/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const testDir = join(tmpdir(), `nimblebrain-lifecycle-${Date.now()}`);

function setupTestDir() {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	mkdirSync(testDir, { recursive: true });
}

afterAll(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

function makeEventCollector(): EventSink & { events: EngineEvent[] } {
	const events: EngineEvent[] = [];
	return {
		events,
		emit(event: EngineEvent) {
			events.push(event);
		},
	};
}

function eventTypes(collector: { events: EngineEvent[] }): string[] {
	return collector.events.map((e) => e.type);
}

/** Create a minimal echo MCP server bundle on disk with a valid MCPB manifest. */
function createEchoBundleOnDisk(dir: string, opts?: { withUiMeta?: boolean; withUpjack?: boolean }): string {
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

	const meta: Record<string, unknown> = {};
	if (opts?.withUiMeta) {
		meta["ai.nimblebrain/host"] = {
			host_version: "1.0",
			name: "Echo App",
			icon: "echo-icon",
			placements: [
				{ slot: "main", resourceUri: "ui://echo/main", label: "Echo App", icon: "echo-icon", route: "echo" },
			],
		};
	}
	if (opts?.withUpjack) {
		meta["ai.nimblebrain/upjack"] = { entities: [] };
	}

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
		...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
	};
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
	return dir;
}

// ---------------------------------------------------------------------------
// Install tests
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — install local bundle", () => {
	beforeEach(setupTestDir);

	it("installs a local bundle: source registered, config updated, event emitted", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-install"));
		const configPath = join(testDir, "nimblebrain.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");

		// Source registered in registry
		expect(registry.hasSource(instance.serverName)).toBe(true);

		// Instance state is running
		expect(instance.state).toBe("running");
		expect(instance.version).toBe("1.0.0");
		expect(instance.type).toBe("plain");

		// Config file updated
		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.bundles).toHaveLength(1);
		expect(config.bundles[0].path).toBe(bundleDir);

		// Event emitted
		expect(eventTypes(sink)).toContain("bundle.installed");
		const installEvent = sink.events.find((e) => e.type === "bundle.installed");
		expect(installEvent!.data.serverName).toBe(instance.serverName);

		// Cleanup
		await registry.removeSource(instance.serverName);
	}, 15_000);

	it("installs with UI metadata: metadata extracted and stored", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-ui"), { withUiMeta: true });
		const configPath = join(testDir, "nimblebrain-ui.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");

		// UI metadata extracted from manifest
		expect(instance.ui).not.toBeNull();
		expect(instance.ui!.name).toBe("Echo App");
		expect(instance.ui!.icon).toBe("echo-icon");
		expect(instance.ui!.placements).toHaveLength(1);
		expect(instance.ui!.placements![0].resourceUri).toBe("ui://echo/main");

		// Config entry includes ui
		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.bundles[0].ui).toBeDefined();
		expect(config.bundles[0].ui.name).toBe("Echo App");

		// Install event includes ui
		const installEvent = sink.events.find((e) => e.type === "bundle.installed");
		expect((installEvent!.data.ui as { name: string }).name).toBe("Echo App");

		await registry.removeSource(instance.serverName);
	}, 15_000);

	it("installs an Upjack bundle: type detected correctly", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-upjack"), { withUpjack: true });
		const configPath = join(testDir, "nimblebrain-upjack.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");

		expect(instance.type).toBe("upjack");

		const installEvent = sink.events.find((e) => e.type === "bundle.installed");
		expect(installEvent!.data.type).toBe("upjack");

		await registry.removeSource(instance.serverName);
	}, 15_000);
});

// ---------------------------------------------------------------------------
// Uninstall tests
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — uninstall", () => {
	beforeEach(setupTestDir);

	it("uninstalls a normal bundle: source removed, config updated, event emitted", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-uninstall"));
		const configPath = join(testDir, "nimblebrain-uninstall.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");
		const serverName = instance.serverName;

		// Verify installed
		expect(registry.hasSource(serverName)).toBe(true);

		// Now uninstall by server name (same as API: DELETE /v1/apps/:name)
		await lifecycle.uninstall(serverName, registry, "ws_test");

		// Source removed
		expect(registry.hasSource(serverName)).toBe(false);

		// Config updated (bundles array empty)
		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.bundles).toHaveLength(0);

		// Event emitted
		expect(eventTypes(sink)).toContain("bundle.uninstalled");

		// Instance no longer tracked (installLocal stores without wsId)
		expect(lifecycle.getInstances().find(i => i.serverName === serverName)).toBeUndefined();
	}, 15_000);

	it("rejects uninstall of a protected bundle", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-protected"));
		const configPath = join(testDir, "nimblebrain-protected.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");

		// Mark as protected
		instance.protected = true;

		// Attempt uninstall should throw
		let error: Error | null = null;
		try {
			await lifecycle.uninstall(instance.serverName, registry, "ws_test");
		} catch (e) {
			error = e as Error;
		}

		expect(error).not.toBeNull();
		expect(error!.message).toContain("protected");

		// Source should still be registered
		expect(registry.hasSource(instance.serverName)).toBe(true);

		// No uninstalled event
		expect(eventTypes(sink)).not.toContain("bundle.uninstalled");

		await registry.removeSource(instance.serverName);
	}, 15_000);

	it("does not delete data directories on uninstall", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-data-preserve"));
		const configPath = join(testDir, "nimblebrain-data.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		// Create a fake data directory that should survive uninstall
		const dataDir = join(testDir, "data", "echo");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, "records.json"), "[]");

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath);

		await lifecycle.installLocal(bundleDir, registry, "ws_test");
		await lifecycle.uninstall(bundleDir, registry, "ws_test");

		// Data directory should still exist
		expect(existsSync(dataDir)).toBe(true);
		expect(existsSync(join(dataDir, "records.json"))).toBe(true);
	}, 15_000);
});

// ---------------------------------------------------------------------------
// Start / Stop tests
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — start and stop", () => {
	beforeEach(setupTestDir);

	it("stop transitions state to stopped", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-stop"));
		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");
		expect(instance.state).toBe("running");

		await lifecycle.stopBundle(instance.serverName, "ws_test", registry);
		expect(instance.state).toBe("stopped");

		await registry.removeSource(instance.serverName);
	}, 15_000);

	it("start transitions a stopped bundle back to running", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-restart"));
		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");
		await lifecycle.stopBundle(instance.serverName, "ws_test", registry);
		expect(instance.state).toBe("stopped");

		await lifecycle.startBundle(instance.serverName, "ws_test", registry);
		expect(instance.state).toBe("running");

		await registry.removeSource(instance.serverName);
	}, 15_000);
});

// ---------------------------------------------------------------------------
// State machine tests
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — state transitions", () => {
	beforeEach(setupTestDir);

	it("recordCrash transitions to crashed and emits event", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-crash"));
		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");
		expect(instance.state).toBe("running");

		lifecycle.recordCrash(instance.serverName, "ws_test");
		expect(instance.state).toBe("crashed");
		expect(eventTypes(sink)).toContain("bundle.crashed");

		await registry.removeSource(instance.serverName);
	}, 15_000);

	it("recordRecovery transitions crashed to running and emits event", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-recover"));
		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");
		lifecycle.recordCrash(instance.serverName, "ws_test");

		lifecycle.recordRecovery(instance.serverName, "ws_test");
		expect(instance.state).toBe("running");
		expect(eventTypes(sink)).toContain("bundle.recovered");

		await registry.removeSource(instance.serverName);
	}, 15_000);

	it("recordDead transitions to dead and emits event", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-dead"));
		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");
		lifecycle.recordCrash(instance.serverName, "ws_test");

		lifecycle.recordDead(instance.serverName, "ws_test");
		expect(instance.state).toBe("dead");
		expect(eventTypes(sink)).toContain("bundle.dead");

		await registry.removeSource(instance.serverName);
	}, 15_000);

	it("dead bundle requires explicit startBundle to run again", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-dead-restart"));
		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");
		lifecycle.recordDead(instance.serverName, "ws_test");
		expect(instance.state).toBe("dead");

		// Explicit startBundle should bring it back
		await lifecycle.startBundle(instance.serverName, "ws_test", registry);
		expect(instance.state).toBe("running");

		await registry.removeSource(instance.serverName);
	}, 15_000);
});

// ---------------------------------------------------------------------------
// Atomic config write tests
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — atomic config writes", () => {
	beforeEach(setupTestDir);

	it("config writes are atomic (valid JSON after concurrent-safe write)", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-atomic"));
		const configPath = join(testDir, "nimblebrain-atomic.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath);

		await lifecycle.installLocal(bundleDir, registry, "ws_test");

		// Read config — should be valid JSON with the bundle entry
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw);
		expect(config.bundles).toHaveLength(1);
		expect(config.bundles[0].path).toBe(bundleDir);

		// No temp files should remain
		const dirContents = require("node:fs").readdirSync(testDir) as string[];
		const tmpFiles = dirContents.filter((f: string) => f.endsWith(".tmp"));
		expect(tmpFiles).toHaveLength(0);

		await registry.removeSource("echo");
	}, 15_000);

	it("install does not duplicate entries on repeated calls", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-idempotent"));
		const configPath = join(testDir, "nimblebrain-idem.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath);

		await lifecycle.installLocal(bundleDir, registry, "ws_test");

		// Read config after first install
		let config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.bundles).toHaveLength(1);

		// Clean up the source so we can install again
		await registry.removeSource("echo");

		// Second install (same path)
		await lifecycle.installLocal(bundleDir, registry, "ws_test");

		// Should still be 1 entry (atomicConfigAdd deduplicates)
		config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.bundles).toHaveLength(1);

		await registry.removeSource("echo");
	}, 15_000);
});

// ---------------------------------------------------------------------------
// seedInstance / getInstances
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — instance tracking", () => {
	it("seedInstance creates a running instance with ref properties", () => {
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		lifecycle.seedInstance("ipinfo", "@nimblebraininc/ipinfo", {
			name: "@nimblebraininc/ipinfo",
			protected: true,
			trustScore: 92,
			ui: { name: "IPInfo", icon: "globe" },
		}, undefined, "ws_test");

		const instance = lifecycle.getInstance("ipinfo", "ws_test")!;
		expect(instance).toBeDefined();
		expect(instance.state).toBe("running");
		expect(instance.protected).toBe(true);
		expect(instance.trustScore).toBe(92);
		expect(instance.ui?.name).toBe("IPInfo");

		const all = lifecycle.getInstances();
		expect(all).toHaveLength(1);
	});

	it("seedInstance resolves entityDataRoot from dataDir and upjackNamespace", () => {
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		lifecycle.seedInstance(
			"synapse-crm",
			"@nimblebraininc/synapse-crm",
			{ name: "@nimblebraininc/synapse-crm" },
			{
				manifestName: "@nimblebraininc/synapse-crm",
				version: "0.1.0",
				ui: null,
				briefing: { facets: [{ name: "deals", label: "Deals", type: "delta", entity: "deal" }] },
				type: "upjack",
				upjackNamespace: "apps/crm",
			},
			"ws_eng",
			"/data/workspaces/ws_eng/data/nimblebraininc-synapse-crm",
		);

		const instance = lifecycle.getInstance("synapse-crm", "ws_eng")!;
		expect(instance).toBeDefined();
		expect(instance.entityDataRoot).toBe(
			join("/data/workspaces/ws_eng/data/nimblebraininc-synapse-crm", "apps/crm", "data"),
		);
		expect(instance.wsId).toBe("ws_eng");
	});

	it("seedInstance omits entityDataRoot when dataDir is missing", () => {
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		lifecycle.seedInstance(
			"echo",
			"@nimblebraininc/echo",
			{ name: "@nimblebraininc/echo" },
			{
				manifestName: "@nimblebraininc/echo",
				version: "1.0.0",
				ui: null,
				briefing: null,
				type: "plain",
			},
			"ws_test",
		);

		const instance = lifecycle.getInstance("echo", "ws_test")!;
		expect(instance.entityDataRoot).toBeUndefined();
	});

	it("seedInstance omits entityDataRoot when upjackNamespace is missing", () => {
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		lifecycle.seedInstance(
			"plain-srv",
			"@test/plain",
			{ name: "@test/plain" },
			{
				manifestName: "@test/plain",
				version: "1.0.0",
				ui: null,
				briefing: null,
				type: "plain",
			},
			"ws_test",
			"/data/workspaces/ws_test/data/test-plain",
		);

		const instance = lifecycle.getInstance("plain-srv", "ws_test")!;
		expect(instance.entityDataRoot).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Resilience — error path coverage
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — error resilience", () => {
	beforeEach(setupTestDir);

	it("installLocal rejects with corrupt JSON manifest", async () => {
		const bundleDir = join(testDir, "echo-corrupt");
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(join(bundleDir, "manifest.json"), "{ this is not valid JSON !!!}");

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		let error: Error | null = null;
		try {
			await lifecycle.installLocal(bundleDir, registry, "ws_test");
		} catch (e) {
			error = e as Error;
		}

		expect(error).not.toBeNull();
		// Should not leave any source registered
		expect(registry.getSources()).toHaveLength(0);
	});

	it("installLocal rejects when manifest.json is missing", async () => {
		const bundleDir = join(testDir, "echo-no-manifest");
		mkdirSync(bundleDir, { recursive: true });
		// No manifest.json created

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		let error: Error | null = null;
		try {
			await lifecycle.installLocal(bundleDir, registry, "ws_test");
		} catch (e) {
			error = e as Error;
		}

		expect(error).not.toBeNull();
	});

	it("uninstall for nonexistent server name is a silent no-op", async () => {
		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		// Should not throw — lenient behavior for idempotent uninstall
		await lifecycle.uninstall("completely-nonexistent-server", registry, "ws_test");

		// But should still emit uninstalled event (even if nothing was installed)
		// OR be a full no-op — verify whichever is the actual behavior
		expect(lifecycle.getInstances().find(i => i.serverName === "completely-nonexistent-server")).toBeUndefined();
	});

	it("getInstance returns undefined for unknown server name", () => {
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		expect(lifecycle.getInstance("nonexistent", "ws_test")).toBeUndefined();
	});

	it("recordCrash on unknown server does not throw", () => {
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		// Should not throw — graceful no-op for unknown server
		expect(() => lifecycle.recordCrash("unknown-server", "ws_test")).not.toThrow();
	});

	it("state machine rejects invalid transitions", async () => {
		const bundleDir = createEchoBundleOnDisk(join(testDir, "echo-invalid-transition"));
		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");

		// running → recordRecovery should be a no-op (can't recover if not crashed)
		lifecycle.recordRecovery(instance.serverName, "ws_test");
		expect(instance.state).toBe("running"); // Should remain running

		// running → recordDead should transition (crash + dead)
		lifecycle.recordDead(instance.serverName, "ws_test");
		expect(instance.state).toBe("dead");

		await registry.removeSource(instance.serverName);
	}, 15_000);

	it("config file is not corrupted when installLocal fails mid-operation", async () => {
		const configPath = join(testDir, "nimblebrain-resilience.json");
		const initialConfig = { bundles: [{ name: "@test/existing" }] };
		writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath);

		// Try to install a broken bundle (missing server entry_point)
		const brokenDir = join(testDir, "echo-broken-server");
		mkdirSync(brokenDir, { recursive: true });
		writeFileSync(join(brokenDir, "manifest.json"), JSON.stringify({
			manifest_version: "0.4",
			name: "@test/broken",
			version: "1.0.0",
			description: "Broken bundle",
			server: {
				type: "node",
				entry_point: "nonexistent.js",
				mcp_config: {
					command: "node",
					args: ["${__dirname}/nonexistent.js"],
				},
			},
		}));

		try {
			await lifecycle.installLocal(brokenDir, registry, "ws_test");
		} catch {
			// Expected to fail
		}

		// Config should be parseable and not corrupted
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw);
		expect(config.bundles).toBeDefined();
	}, 15_000);
});
