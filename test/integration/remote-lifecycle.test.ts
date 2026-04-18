import { describe, expect, it, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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
import { ToolRegistry } from "../../src/tools/registry.ts";
import { deriveServerName } from "../../src/bundles/paths.ts";
import { startBundleSource } from "../../src/bundles/startup.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import type { BundleRef } from "../../src/bundles/types.ts";

const testDir = join(tmpdir(), `nimblebrain-remote-lifecycle-${Date.now()}`);

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
// Helper: spin up a real MCP server over Streamable HTTP
// ---------------------------------------------------------------------------

interface MockRemoteServer {
	url: string;
	close: () => void;
}

function createMcpServer(toolCount: number): Server {
	const mcpServer = new Server(
		{ name: "remote-echo", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);

	const tools = Array.from({ length: toolCount }, (_, i) => ({
		name: `tool_${i}`,
		description: `Test tool ${i}`,
		inputSchema: {
			type: "object" as const,
			properties: { input: { type: "string" } },
		},
	}));

	mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools,
	}));

	mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => ({
		content: [
			{ type: "text", text: `Executed: ${req.params.name}` },
		],
	}));

	return mcpServer;
}

function startMockRemoteServer(toolCount = 2): MockRemoteServer {
	// Track transports and servers for cleanup
	const transports: WebStandardStreamableHTTPServerTransport[] = [];
	const servers: Server[] = [];

	const httpServer = Bun.serve({
		port: 0, // random port
		async fetch(req: Request) {
			const url = new URL(req.url);
			if (url.pathname !== "/mcp") {
				return new Response("Not found", { status: 404 });
			}

			// Create a fresh Server + Transport per request (stateless mode)
			const mcpServer = createMcpServer(toolCount);
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
			for (const t of transports) {
				t.close().catch(() => {});
			}
			for (const s of servers) {
				s.close().catch(() => {});
			}
		},
	};
}

// ---------------------------------------------------------------------------
// installRemote tests
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — installRemote", () => {
	let mockServer: MockRemoteServer;

	beforeEach(() => {
		setupTestDir();
		mockServer = startMockRemoteServer(3);
	});

	afterEach(() => {
		mockServer?.close();
	});

	it("installs a remote bundle: source registered, config updated, event emitted", async () => {
		const configPath = join(testDir, "nimblebrain.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath, true);

		const instance = await lifecycle.installRemote(
			mockServer.url,
			"remote-echo",
			registry,
			"ws_test",
		);

		// Source registered in registry
		expect(registry.hasSource("remote-echo")).toBe(true);

		// Instance state is running
		expect(instance.state).toBe("running");
		expect(instance.version).toBe("remote (3 tools)");
		expect(instance.type).toBe("plain");
		expect(instance.bundleName).toBe(mockServer.url);

		// Config file updated
		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.bundles).toHaveLength(1);
		expect(config.bundles[0].url).toBe(mockServer.url);
		expect(config.bundles[0].serverName).toBe("remote-echo");

		// Event emitted with remote: true
		expect(eventTypes(sink)).toContain("bundle.installed");
		const installEvent = sink.events.find((e) => e.type === "bundle.installed");
		expect(installEvent!.data.serverName).toBe("remote-echo");
		expect(installEvent!.data.remote).toBe(true);

		// Cleanup
		await registry.removeSource("remote-echo");
	}, 15_000);

	it("installs with transport config and trust score", async () => {
		const configPath = join(testDir, "nimblebrain-transport.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath, true);

		const instance = await lifecycle.installRemote(
			mockServer.url,
			"remote-echo",
			registry,
			"ws_test",
			{ type: "streamable-http" },
			{ name: "Remote Echo", icon: "cloud" },
			85,
		);

		expect(instance.trustScore).toBe(85);
		expect(instance.ui?.name).toBe("Remote Echo");

		// Config includes transport and trustScore
		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.bundles[0].transport).toEqual({ type: "streamable-http" });
		expect(config.bundles[0].trustScore).toBe(85);
		expect(config.bundles[0].ui.name).toBe("Remote Echo");

		await registry.removeSource("remote-echo");
	}, 15_000);

	it("does not duplicate config entries on repeated install", async () => {
		const configPath = join(testDir, "nimblebrain-dedup.json");
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, configPath, true);

		await lifecycle.installRemote(mockServer.url, "remote-echo", registry, "ws_test");
		await registry.removeSource("remote-echo");
		await lifecycle.installRemote(mockServer.url, "remote-echo", registry, "ws_test");

		const config = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(config.bundles).toHaveLength(1);

		await registry.removeSource("remote-echo");
	}, 15_000);
});

// ---------------------------------------------------------------------------
// Failed remote connection
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager — remote connection failure", () => {
	beforeEach(setupTestDir);

	it("failed remote connection throws (not fatal to startup via allSettled)", async () => {
		const registry = new ToolRegistry();
		const sink = makeEventCollector();
		const lifecycle = new BundleLifecycleManager(sink, undefined, true);

		let error: Error | null = null;
		try {
			await lifecycle.installRemote(
				"http://127.0.0.1:1/mcp", // port 1 — connection refused
				"bad-remote",
				registry,
				"ws_test",
			);
		} catch (e) {
			error = e as Error;
		}

		expect(error).not.toBeNull();
		// Source should not be registered
		expect(registry.hasSource("bad-remote")).toBe(false);
		// No install event emitted
		expect(eventTypes(sink)).not.toContain("bundle.installed");
	}, 20_000);
});

// ---------------------------------------------------------------------------
// Startup with url entries in config (startBundleSource)
// ---------------------------------------------------------------------------

describe("startBundleSource — remote url entries", () => {
	let mockServer: MockRemoteServer;

	beforeEach(() => {
		setupTestDir();
		mockServer = startMockRemoteServer(2);
	});

	afterEach(() => {
		mockServer?.close();
	});

	it("starts a remote bundle from a url BundleRef", async () => {
		const registry = new ToolRegistry();
		const ref: BundleRef = {
			url: mockServer.url,
			serverName: "startup-remote",
		};

		const meta = await startBundleSource(ref, registry, new NoopEventSink(), undefined, { allowInsecureRemotes: true });

		expect(meta).not.toBeNull();
		expect(meta.meta).not.toBeNull();
		expect(meta.meta!.version).toBe("remote (2 tools)");
		expect(meta.meta!.type).toBe("plain");
		expect(registry.hasSource("startup-remote")).toBe(true);

		// Tools are available
		const tools = await registry.availableTools();
		expect(tools.length).toBe(2);

		await registry.removeSource("startup-remote");
	}, 15_000);

	it("derives serverName from url when serverName not provided", async () => {
		const registry = new ToolRegistry();
		const ref: BundleRef = {
			url: mockServer.url,
		};

		const meta = await startBundleSource(ref, registry, new NoopEventSink(), undefined, { allowInsecureRemotes: true });
		expect(meta).not.toBeNull();

		// deriveServerName on a URL will produce something like "mcp"
		const expected = deriveServerName(mockServer.url);
		expect(registry.hasSource(expected)).toBe(true);

		await registry.removeSource(expected);
	}, 15_000);

	it("failed remote startup is caught by allSettled (not fatal)", async () => {
		const registry = new ToolRegistry();
		const ref: BundleRef = {
			url: "http://127.0.0.1:1/mcp",
			serverName: "bad-remote",
		};

		// startBundleSource throws — but callers use allSettled
		const results = await Promise.allSettled([
			startBundleSource(ref, registry, new NoopEventSink(), undefined, { allowInsecureRemotes: true }),
		]);

		expect(results[0]!.status).toBe("rejected");
		expect(registry.hasSource("bad-remote")).toBe(false);
	}, 20_000);

	it("handles mix of name, path, and url entries via allSettled", async () => {
		const registry = new ToolRegistry();

		// Only url ref will succeed; name/path refs will fail (no mpak, no local bundle)
		const refs: BundleRef[] = [
			{ name: "@nonexistent/bundle" },
			{ path: "/nonexistent/path" },
			{ url: mockServer.url, serverName: "mix-remote" },
		];

		const results = await Promise.allSettled(
			refs.map((ref) => startBundleSource(ref, registry, new NoopEventSink(), undefined, { allowInsecureRemotes: true })),
		);

		// First two fail, third succeeds
		expect(results[0]!.status).toBe("rejected");
		expect(results[1]!.status).toBe("rejected");
		expect(results[2]!.status).toBe("fulfilled");

		expect(registry.hasSource("mix-remote")).toBe(true);

		await registry.removeSource("mix-remote");
	}, 15_000);
});
