import { describe, expect, it, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { PlacementRegistry } from "../../src/runtime/placement-registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { PlacementDeclaration } from "../../src/bundles/types.ts";

const testDir = join(tmpdir(), `nimblebrain-lifecycle-placements-${Date.now()}`);

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

/** Create a minimal echo MCP server bundle on disk with a valid MCPB manifest. */
function createEchoBundleOnDisk(
	dir: string,
	opts?: {
		withPlacements?: PlacementDeclaration[];
		withPrimaryView?: boolean;
		withBothPlacementsAndPrimaryView?: boolean;
	},
): string {
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
	const uiBlock: Record<string, unknown> = {};

	if (opts?.withPlacements) {
		uiBlock.placements = opts.withPlacements;
	}

	if (opts?.withPrimaryView || opts?.withBothPlacementsAndPrimaryView) {
		uiBlock.primaryView = { resourceUri: "ui://echo/main" };
	}

	if (opts?.withBothPlacementsAndPrimaryView && opts?.withPlacements) {
		uiBlock.placements = opts.withPlacements;
		uiBlock.primaryView = { resourceUri: "ui://echo/main" };
	}

	if (Object.keys(uiBlock).length > 0) {
		meta["ai.nimblebrain/host"] = {
			host_version: "1.0",
			name: "Echo App",
			icon: "echo-icon",
			...uiBlock,
		};
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
// Install with placements
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — placement registration on install", () => {
	beforeEach(setupTestDir);

	it("install bundle with placements registers them in PlacementRegistry", async () => {
		const placements: PlacementDeclaration[] = [
			{ slot: "sidebar.apps", resourceUri: "ui://echo/nav", priority: 30, label: "Echo" },
			{ slot: "main", resourceUri: "ui://echo/board", route: "echo", label: "Echo Board" },
		];
		const bundleDir = createEchoBundleOnDisk(
			join(testDir, "echo-placements"),
			{ withPlacements: placements },
		);

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const pr = new PlacementRegistry();
		const lifecycle = new BundleLifecycleManager(sink, undefined);
		lifecycle.setPlacementRegistry(pr);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");

		// Placements extracted into UI meta
		expect(instance.ui).not.toBeNull();
		expect(instance.ui!.placements).toHaveLength(2);

		// Placements registered in PlacementRegistry
		const wsPlacements = pr.forWorkspace("ws_test");
		const sidebarApps = wsPlacements.filter((e) => e.slot === "sidebar.apps");
		expect(sidebarApps).toHaveLength(1);
		expect(sidebarApps[0].resourceUri).toBe("ui://echo/nav");
		expect(sidebarApps[0].serverName).toBe("echo");

		const main = wsPlacements.filter((e) => e.slot === "main");
		expect(main).toHaveLength(1);
		expect(main[0].route).toBe("echo"); // explicit placements keep their declared route

		// Event includes placements
		const installEvent = sink.events.find((e) => e.type === "bundle.installed");
		expect(installEvent!.data.placements).toHaveLength(2);

		await registry.removeSource(instance.serverName);
	}, 15_000);

	it("install bundle with only primaryView (no placements) does not register placements", async () => {
		const bundleDir = createEchoBundleOnDisk(
			join(testDir, "echo-legacy"),
			{ withPrimaryView: true },
		);

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const pr = new PlacementRegistry();
		const lifecycle = new BundleLifecycleManager(sink, undefined);
		lifecycle.setPlacementRegistry(pr);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");

		// primaryView is no longer extracted — only explicit placements are registered
		expect(instance.ui!.placements).toBeUndefined();
		const main = pr.forWorkspace("ws_test").filter((e) => e.slot === "main");
		expect(main).toHaveLength(0);

		await registry.removeSource(instance.serverName);
	}, 15_000);

	it("bundle with both placements and primaryView uses explicit placements", async () => {
		const placements: PlacementDeclaration[] = [
			{ slot: "toolbar.right", resourceUri: "ui://echo/toolbar", priority: 60 },
		];
		const bundleDir = createEchoBundleOnDisk(
			join(testDir, "echo-both"),
			{ withPlacements: placements, withBothPlacementsAndPrimaryView: true },
		);

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const pr = new PlacementRegistry();
		const lifecycle = new BundleLifecycleManager(sink, undefined);
		lifecycle.setPlacementRegistry(pr);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");

		// Explicit placements take precedence — no legacy "main" placement
		const wsPlacements = pr.forWorkspace("ws_test");
		const main = wsPlacements.filter((e) => e.slot === "main");
		expect(main).toHaveLength(0);

		const toolbar = wsPlacements.filter((e) => e.slot === "toolbar.right");
		expect(toolbar).toHaveLength(1);
		expect(toolbar[0].resourceUri).toBe("ui://echo/toolbar");

		await registry.removeSource(instance.serverName);
	}, 15_000);
});

// ---------------------------------------------------------------------------
// Uninstall removes placements
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — placement unregistration on uninstall", () => {
	beforeEach(setupTestDir);

	it("uninstall removes placements from PlacementRegistry", async () => {
		const placements: PlacementDeclaration[] = [
			{ slot: "sidebar.apps", resourceUri: "ui://echo/nav", priority: 30 },
		];
		const bundleDir = createEchoBundleOnDisk(
			join(testDir, "echo-uninstall-placements"),
			{ withPlacements: placements },
		);
		const configPath = join(testDir, "nimblebrain-uninstall-p.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const pr = new PlacementRegistry();
		const lifecycle = new BundleLifecycleManager(sink, configPath);
		lifecycle.setPlacementRegistry(pr);

		const instance = await lifecycle.installLocal(bundleDir, registry, "ws_test");

		// Verify placement exists
		expect(pr.forWorkspace("ws_test").filter((e) => e.slot === "sidebar.apps")).toHaveLength(1);

		// Uninstall by server name
		await lifecycle.uninstall(instance.serverName, registry, "ws_test");

		// Placement gone
		expect(pr.forWorkspace("ws_test")).toHaveLength(0);
	}, 15_000);
});

// ---------------------------------------------------------------------------
// nb-core placements (unit test, no Runtime.start needed)
// ---------------------------------------------------------------------------

describe("nb-core placements via PlacementRegistry", () => {
	it("registers ambient core placements across multiple slots", () => {
		// Representative payload — the registry doesn't care about the
		// specific URIs, only that ambient (no wsId) entries surface for
		// any workspace and stay tagged with their serverName. The actual
		// per-source placements in production are declared by each
		// platform source's factory and registered via `Runtime.start()`.
		const pr = new PlacementRegistry();

		const NB_CORE_PLACEMENTS: PlacementDeclaration[] = [
			{ slot: "main", resourceUri: "ui://core/usage-dashboard", route: "usage", label: "Usage", icon: "📊" },
			{ slot: "sidebar", resourceUri: "ui://core/home-nav", route: "home", label: "Home", icon: "🏠" },
		];
		pr.register("nb", NB_CORE_PLACEMENTS);

		// Ambient entries show up for any workspace the user is in.
		const all = pr.forWorkspace("ws_any");
		expect(all).toHaveLength(2);

		// All belong to core
		for (const entry of all) {
			expect(entry.serverName).toBe("nb");
		}

		// Slot filtering returns the right entries.
		expect(all.filter((e) => e.slot === "main")).toHaveLength(1);
		expect(all.filter((e) => e.slot === "sidebar")).toHaveLength(1);
	});

	it("bundle placements coexist with nb-core placements", () => {
		const pr = new PlacementRegistry();

		pr.register("nb", [
			{ slot: "sidebar.apps", resourceUri: "ui://core/app-nav", priority: 20 },
		]);
		pr.register(
			"tasks",
			[
				{ slot: "sidebar.apps", resourceUri: "ui://tasks/nav", priority: 30 },
				{ slot: "main", resourceUri: "ui://tasks/board", route: "tasks" },
			],
			"ws_test",
		);

		const wsEntries = pr.forWorkspace("ws_test");
		const sidebarApps = wsEntries.filter((e) => e.slot === "sidebar.apps");
		expect(sidebarApps).toHaveLength(2);
		expect(sidebarApps[0].serverName).toBe("nb"); // priority 20
		expect(sidebarApps[1].serverName).toBe("tasks"); // priority 30

		expect(wsEntries).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// extractUiMeta includes placements
// ---------------------------------------------------------------------------

describe("extractUiMeta — placements extraction", () => {
	it("extracts placements from manifest metadata", () => {
		// Use the exported extractUiMeta function indirectly via lifecycle install
		// We test the extraction by checking BundleInstance.ui after install
		// (already covered above), but also test the function shape directly
		// by importing it.
		const { extractUiMeta } = require("../../src/bundles/lifecycle.ts") as {
			extractUiMeta: (manifest: { _meta?: Record<string, unknown> }) => { placements?: PlacementDeclaration[] } | null;
		};

		const manifest = {
			_meta: {
				"ai.nimblebrain/host": {
					host_version: "1.0",
					name: "TestApp",
					icon: "test",
					placements: [
						{ slot: "main", resourceUri: "ui://test/page", route: "test" },
					],
				},
			},
		};

		const meta = extractUiMeta(manifest as never);
		expect(meta).not.toBeNull();
		expect(meta!.placements).toHaveLength(1);
		expect(meta!.placements![0].slot).toBe("main");
	});

	it("returns null placements when manifest has none", () => {
		const { extractUiMeta } = require("../../src/bundles/lifecycle.ts") as {
			extractUiMeta: (manifest: { _meta?: Record<string, unknown> }) => { placements?: PlacementDeclaration[] } | null;
		};

		const manifest = {
			_meta: {
				"ai.nimblebrain/host": {
					host_version: "1.0",
					name: "TestApp",
					icon: "test",
					primaryView: { resourceUri: "ui://test/main" },
				},
			},
		};

		const meta = extractUiMeta(manifest as never);
		expect(meta).not.toBeNull();
		expect(meta!.placements).toBeUndefined();
	});
});
