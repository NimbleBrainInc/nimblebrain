import { describe, expect, it, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { startBundleSource } from "../../src/bundles/startup.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import {
	installTestCredentialStore,
	resetTestCredentialStore,
} from "../helpers/credential-store.ts";

const testDir = join(tmpdir(), `nimblebrain-lifecycle-${Date.now()}`);

// Every path here reaches `seedInstance`, which derives the boot Connection
// state from the OAuth token record — a key in the credential store.
beforeEach(() => {
	installTestCredentialStore(testDir);
});

afterEach(() => {
	resetTestCredentialStore();
});

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

// ---------------------------------------------------------------------------
// Helper: a real MCP server over Streamable HTTP, the shape every connector
// now has. The lifecycle owns remote connections only — there is no local
// bundle to unpack or subprocess to spawn.
// ---------------------------------------------------------------------------

interface MockRemoteServer {
	url: string;
	close: () => void;
}

function startMockRemoteServer(): MockRemoteServer {
	const transports: WebStandardStreamableHTTPServerTransport[] = [];
	const servers: Server[] = [];

	const httpServer = Bun.serve({
		port: 0,
		async fetch(req: Request) {
			if (new URL(req.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });

			const mcpServer = new Server(
				{ name: "remote-echo", version: "0.1.0" },
				{ capabilities: { tools: {} } },
			);
			mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
				tools: [
					{
						name: "echo",
						description: "Echo input",
						inputSchema: {
							type: "object" as const,
							properties: { message: { type: "string" } },
						},
					},
				],
			}));
			mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => ({
				content: [{ type: "text", text: `Echo: ${req.params.arguments?.message}` }],
			}));
			servers.push(mcpServer);

			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
			});
			transports.push(transport);
			await mcpServer.connect(transport);
			return transport.handleRequest(req);
		},
	});

	return {
		url: `http://localhost:${httpServer.port}/mcp`,
		close() {
			httpServer.stop(true);
			for (const t of transports) t.close().catch(() => {});
			for (const s of servers) s.close().catch(() => {});
		},
	};
}

const SERVER_NAME = "remote-echo";
const WS = "ws_test";

/**
 * Connect the mock server and record it on the lifecycle, as the install path
 * does. Static bearer auth keeps the seeded connection `running`: without a
 * credential on the ref, `seedUrlConnectionState` correctly reports
 * `not_authenticated` until an OAuth flow completes.
 */
async function connectAndSeed(
	lifecycle: BundleLifecycleManager,
	registry: ToolRegistry,
	url: string,
): Promise<BundleRef> {
	const ref: BundleRef = {
		url,
		serverName: SERVER_NAME,
		transport: { type: "streamable-http", auth: { type: "bearer", token: "t" } },
	};
	const { meta } = await startBundleSource(ref, registry, new NoopEventSink(), {
		allowInsecureRemotes: true,
		wsId: WS,
	});
	await lifecycle.seedInstance(SERVER_NAME, url, ref, meta ?? undefined, WS);
	return ref;
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — uninstall", () => {
	let mockServer: MockRemoteServer;

	beforeEach(() => {
		setupTestDir();
		mockServer = startMockRemoteServer();
	});

	afterEach(() => {
		mockServer?.close();
	});

	it("uninstalls a connector: source removed, config updated, event emitted", async () => {
		const configPath = join(testDir, "nimblebrain-uninstall.json");
		writeFileSync(
			configPath,
			JSON.stringify({ bundles: [{ url: mockServer.url, serverName: SERVER_NAME }] }, null, 2),
		);

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath, true);
		await connectAndSeed(lifecycle, registry, mockServer.url);

		expect(registry.hasSource(SERVER_NAME)).toBe(true);

		await lifecycle.uninstall(SERVER_NAME, registry, WS);

		expect(registry.hasSource(SERVER_NAME)).toBe(false);
		expect(JSON.parse(readFileSync(configPath, "utf-8")).bundles).toHaveLength(0);
		expect(eventTypes(sink)).toContain("bundle.uninstalled");
		expect(lifecycle.getInstance(SERVER_NAME, WS)).toBeUndefined();
	}, 15_000);

	it("does not delete data directories on uninstall", async () => {
		const configPath = join(testDir, "nimblebrain-data.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		// A data directory that must survive uninstall — credentials are config,
		// data is not.
		const dataDir = join(testDir, "data", "echo");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, "records.json"), "[]");

		const registry = new ToolRegistry();
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), configPath, true);
		await connectAndSeed(lifecycle, registry, mockServer.url);
		await lifecycle.uninstall(SERVER_NAME, registry, WS);

		expect(existsSync(join(dataDir, "records.json"))).toBe(true);
	}, 15_000);

	it("uninstall leaves the config file valid JSON and no temp files behind", async () => {
		const configPath = join(testDir, "nimblebrain-atomic.json");
		writeFileSync(
			configPath,
			JSON.stringify(
				{ bundles: [{ url: mockServer.url, serverName: SERVER_NAME }, { url: "https://other.test/mcp" }] },
				null,
				2,
			),
		);

		const registry = new ToolRegistry();
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), configPath, true);
		await connectAndSeed(lifecycle, registry, mockServer.url);
		await lifecycle.uninstall(SERVER_NAME, registry, WS);

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.bundles).toHaveLength(1);
		expect(config.bundles[0].url).toBe("https://other.test/mcp");
		expect(readdirSync(testDir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
	}, 15_000);

	it("uninstall for a nonexistent server name is a silent no-op", async () => {
		const registry = new ToolRegistry();
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), undefined, true);

		await lifecycle.uninstall("completely-nonexistent-server", registry, WS);

		expect(lifecycle.getInstance("completely-nonexistent-server", WS)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Start / Stop / state transitions
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — start and stop", () => {
	let mockServer: MockRemoteServer;

	beforeEach(() => {
		setupTestDir();
		mockServer = startMockRemoteServer();
	});

	afterEach(() => {
		mockServer?.close();
	});

	it("stop transitions state to stopped", async () => {
		const registry = new ToolRegistry();
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), undefined, true);
		await connectAndSeed(lifecycle, registry, mockServer.url);
		const instance = lifecycle.getInstance(SERVER_NAME, WS)!;
		expect(instance.state).toBe("running");

		await lifecycle.stopBundle(SERVER_NAME, WS, registry);
		expect(instance.state).toBe("stopped");

		await registry.removeSource(SERVER_NAME);
	}, 15_000);

	it("start transitions a stopped connector back to running", async () => {
		const registry = new ToolRegistry();
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), undefined, true);
		await connectAndSeed(lifecycle, registry, mockServer.url);
		const instance = lifecycle.getInstance(SERVER_NAME, WS)!;

		await lifecycle.stopBundle(SERVER_NAME, WS, registry);
		expect(instance.state).toBe("stopped");

		await lifecycle.startBundle(SERVER_NAME, WS, registry);
		expect(instance.state).toBe("running");

		await registry.removeSource(SERVER_NAME);
	}, 15_000);

	it("a dead connector requires an explicit startBundle to run again", async () => {
		const registry = new ToolRegistry();
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), undefined, true);
		await connectAndSeed(lifecycle, registry, mockServer.url);
		const instance = lifecycle.getInstance(SERVER_NAME, WS)!;

		lifecycle.transition(instance, "dead");
		expect(instance.state).toBe("dead");

		await lifecycle.startBundle(SERVER_NAME, WS, registry);
		expect(instance.state).toBe("running");

		await registry.removeSource(SERVER_NAME);
	}, 15_000);
});

// ---------------------------------------------------------------------------
// seedInstance / getInstances
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — instance tracking", () => {
	it("seedInstance records the ref's UI and derives the connection state", async () => {
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), undefined);

		await lifecycle.seedInstance(
			"ipinfo",
			"https://ipinfo.example.com/mcp",
			{
				url: "https://ipinfo.example.com/mcp",
				serverName: "ipinfo",
				ui: { name: "IPInfo", icon: "globe" },
			},
			undefined,
			"ws_test",
		);

		const instance = lifecycle.getInstance("ipinfo", "ws_test")!;
		expect(instance).toBeDefined();
		expect(instance.ui?.name).toBe("IPInfo");
		// No credential on the ref and no persisted tokens: the connector is
		// installed but not connected, and the seeded state says so.
		expect(instance.state).toBe("not_authenticated");
		expect(lifecycle.getInstances()).toHaveLength(1);
	});

	it("seedInstance prefers the manifest name over the config label", async () => {
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), undefined);

		await lifecycle.seedInstance(
			"crm",
			"https://crm.example.com/mcp",
			{ url: "https://crm.example.com/mcp", serverName: "crm" },
			{
				manifestName: "ai.nimblebrain/crm",
				version: "0.1.0",
				ui: null,
				briefing: {
					facets: [{ name: "deals", label: "Deals", type: "delta", tool: "crm__deals" }],
				},
			},
			"ws_eng",
		);

		const instance = lifecycle.getInstance("crm", "ws_eng")!;
		expect(instance.bundleName).toBe("ai.nimblebrain/crm");
		expect(instance.configKey).toBe("https://crm.example.com/mcp");
		expect(instance.version).toBe("0.1.0");
		expect(instance.briefing?.facets).toHaveLength(1);
		expect(instance.wsId).toBe("ws_eng");
	});

	it("seedInstance retains the ref so a source can be reconstructed on demand", async () => {
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), undefined);
		const ref: BundleRef = {
			url: "https://crm.example.com/mcp",
			serverName: "crm",
			scopes: ["read"],
		};

		await lifecycle.seedInstance("crm", ref.url, ref, undefined, "ws_eng");

		expect(lifecycle.getInstance("crm", "ws_eng")?.ref).toEqual(ref);
	});

	it("getInstance returns undefined for an unknown server name", () => {
		const lifecycle = new BundleLifecycleManager(makeEventCollector(), undefined);
		expect(lifecycle.getInstance("nonexistent", "ws_test")).toBeUndefined();
	});
});
