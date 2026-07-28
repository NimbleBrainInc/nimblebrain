import {
	describe,
	expect,
	it,
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
} from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";
import { getValidator } from "../../src/config/index.ts";
import { deriveServerName } from "../../src/bundles/paths.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { startBundleSource } from "../../src/bundles/startup.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import type { BundleRef } from "../../src/bundles/types.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `nimblebrain-remote-integ-${Date.now()}`);

function ensureTestDir() {
	if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
}

afterAll(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

interface MockRemoteServer {
	url: string;
	port: number;
	close: () => void;
}

function createMcpServer(toolCount: number): Server {
	const mcpServer = new Server(
		{ name: "integ-echo", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);

	const tools = Array.from({ length: toolCount }, (_, i) => ({
		name: `integ_tool_${i}`,
		description: `Integration test tool ${i}`,
		inputSchema: {
			type: "object" as const,
			properties: { input: { type: "string" } },
		},
	}));

	mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
	mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => ({
		content: [{ type: "text", text: `Executed: ${req.params.name}` }],
	}));

	return mcpServer;
}

function startMockRemoteServer(toolCount = 2): MockRemoteServer {
	const transports: WebStandardStreamableHTTPServerTransport[] = [];
	const servers: Server[] = [];

	const httpServer = Bun.serve({
		port: 0,
		async fetch(req: Request) {
			const url = new URL(req.url);
			if (url.pathname !== "/mcp") {
				return new Response("Not found", { status: 404 });
			}

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
		port: httpServer.port,
		close() {
			httpServer.stop(true);
			for (const t of transports) t.close().catch(() => {});
			for (const s of servers) s.close().catch(() => {});
		},
	};
}

// ---------------------------------------------------------------------------
// 1. Config parsing → schema validation → source creation (full pipeline)
// ---------------------------------------------------------------------------

describe("Remote integration: config → validate → load → tools", () => {
	let mockServer: MockRemoteServer;

	beforeEach(() => {
		ensureTestDir();
		mockServer = startMockRemoteServer(3);
	});

	afterEach(() => {
		mockServer?.close();
	});

	it("config with url entry passes schema validation and starts a working source", async () => {
		// Step 1: Build a config object with a url bundle
		const config = {
			bundles: [
				{
					url: mockServer.url,
					serverName: "validated-remote",
				},
			],
		};

		// Step 2: Validate against JSON Schema (same validator used at startup)
		const validate = getValidator();
		expect(validate(config)).toBe(true);

		// Step 3: Start bundle source from the validated ref
		const registry = new ToolRegistry();
		const ref: BundleRef = config.bundles[0] as BundleRef;
		const meta = await startBundleSource(ref, registry, new NoopEventSink(), undefined, { allowInsecureRemotes: true, wsId: "ws_test" });

		expect(meta).not.toBeNull();
		expect(meta.meta).not.toBeNull();
		expect(meta.meta!.version).toBe("remote (3 tools)");
		expect(registry.hasSource("validated-remote")).toBe(true);

		// Step 4: Verify tools are actually callable
		const tools = await registry.availableTools();
		expect(tools.length).toBe(3);
		expect(tools[0]!.name).toContain("integ_tool_");

		await registry.removeSource("validated-remote");
	}, 15_000);

	it("config with url + transport + auth validates and source starts", async () => {
		const config = {
			bundles: [
				{
					url: mockServer.url,
					serverName: "authed-remote",
					transport: {
						type: "streamable-http",
						auth: { type: "bearer", token: "test-token-123" },
						headers: { "X-Custom": "value" },
					},
				},
			],
		};

		// Schema validation
		const validate = getValidator();
		expect(validate(config)).toBe(true);

		// Start source (auth headers won't affect our mock server)
		const registry = new ToolRegistry();
		const ref: BundleRef = config.bundles[0] as BundleRef;
		const meta = await startBundleSource(ref, registry, new NoopEventSink(), undefined, { allowInsecureRemotes: true, wsId: "ws_test" });

		expect(meta).not.toBeNull();
		expect(registry.hasSource("authed-remote")).toBe(true);

		await registry.removeSource("authed-remote");
	}, 15_000);

	it("config with url entry that fails connection does not leave orphan in registry", async () => {
		const config = {
			bundles: [
				{
					url: "http://127.0.0.1:1/mcp",
					serverName: "dead-remote",
				},
			],
		};

		const validate = getValidator();
		expect(validate(config)).toBe(true);

		const registry = new ToolRegistry();
		const ref: BundleRef = config.bundles[0] as BundleRef;

		const results = await Promise.allSettled([startBundleSource(ref, registry, new NoopEventSink(), undefined, { allowInsecureRemotes: true, wsId: "ws_test" })]);
		expect(results[0]!.status).toBe("rejected");
		expect(registry.hasSource("dead-remote")).toBe(false);
	}, 20_000);

	it("keepRegisteredOnStartFailure leaves an unreachable url bundle registered and retryable", async () => {
		// The boot-loop contract. An installed bundle whose endpoint is unreachable
		// during startup must stay in the registry: an absent source is invisible to
		// the agent's tool list, `nb__status`, HealthMonitor, and the unhealthy
		// gauge — and the only path that revives it needs a tool call the model
		// cannot make against a tool it was never shown.
		const registry = new ToolRegistry();
		const ref: BundleRef = { url: "http://127.0.0.1:1/mcp", serverName: "boot-down-remote" };

		const results = await Promise.allSettled([
			startBundleSource(ref, registry, new NoopEventSink(), undefined, {
				allowInsecureRemotes: true,
				wsId: "ws_test",
				keepRegisteredOnStartFailure: true,
			}),
		]);

		// The caller still learns the start failed — this changes registry
		// retention, not the reported outcome.
		expect(results[0]!.status).toBe("rejected");
		expect(registry.hasSource("boot-down-remote")).toBe(true);

		const source = registry.getSource("boot-down-remote") as McpSource;
		// Down, but NOT deliberately stopped. `isStopped()` is what HealthMonitor
		// reads to mark a source terminal, and `removeSource` would have set it via
		// stop() — so this assertion is the one that proves the source will actually
		// be reconnected rather than merely being visible.
		expect(source.isAlive()).toBe(false);
		expect(source.isStopped()).toBe(false);

		await registry.removeSource("boot-down-remote");
	}, 20_000);
});