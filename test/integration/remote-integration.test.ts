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
});

// ---------------------------------------------------------------------------
// 2. (Removed — POST /v1/apps/install endpoint deleted)

describe.skip("Remote integration: POST /v1/apps/install with url", () => {
	let mockServer: MockRemoteServer;
	let runtime: Runtime;
	let handle: ServerHandle;
	let baseUrl: string;

	beforeEach(async () => {
		ensureTestDir();
		mockServer = startMockRemoteServer(4);

		const configPath = join(testDir, `config-api-${Date.now()}.json`);
		writeFileSync(configPath, JSON.stringify({ bundles: [] }, null, 2));

		runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			configPath,
		});

		handle = startServer({ runtime, port: 0 });
		baseUrl = `http://localhost:${handle.port}`;
	});

	afterEach(async () => {
		handle?.stop(true);
		await runtime?.shutdown();
		mockServer?.close();
	});

	it("installs a remote bundle via API and returns correct response", async () => {
		const res = await fetch(`${baseUrl}/v1/apps/install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url: mockServer.url,
				serverName: "api-remote",
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();

		expect(body.name).toBe("api-remote");
		expect(body.bundleName).toBe(mockServer.url);
		expect(body.status).toBe("running");
		expect(body.type).toBe("plain");
		expect(body.toolCount).toBe(4);
	}, 15_000);

	it("installs a remote bundle with transport config via API", async () => {
		const res = await fetch(`${baseUrl}/v1/apps/install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url: mockServer.url,
				serverName: "api-remote-transport",
				transport: { type: "streamable-http" },
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.name).toBe("api-remote-transport");
		expect(body.toolCount).toBe(4);
	}, 15_000);

	it("installed remote bundle appears in GET /v1/apps", async () => {
		// Install first
		const installRes = await fetch(`${baseUrl}/v1/apps/install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url: mockServer.url,
				serverName: "api-listed",
			}),
		});
		expect(installRes.status).toBe(200);

		// List apps
		const listRes = await fetch(`${baseUrl}/v1/apps`);
		expect(listRes.status).toBe(200);
		const body = await listRes.json();
		const apps = body.apps as Array<{ name: string; status: string; tools: number }>;

		const remote = apps.find((a) => a.name === "api-listed");
		expect(remote).toBeDefined();
		expect(remote!.status).toBe("running");
		expect(remote!.toolCount).toBe(4);
	}, 15_000);

	it("derives serverName from url when not provided", async () => {
		const res = await fetch(`${baseUrl}/v1/apps/install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: mockServer.url }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		// The route derives a name from the URL
		expect(body.name).toBeTruthy();
		expect(body.name.length).toBeGreaterThan(0);
		expect(body.toolCount).toBe(4);
	}, 15_000);

	it("returns error for unreachable remote URL", async () => {
		const res = await fetch(`${baseUrl}/v1/apps/install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url: "http://127.0.0.1:1/mcp",
				serverName: "unreachable",
			}),
		});

		// Should be a 4xx or 5xx error, not 200
		expect(res.status).toBeGreaterThanOrEqual(400);
	}, 20_000);
});

// ---------------------------------------------------------------------------
// 3. Mixed config startup: name + path + url via Runtime.start
// ---------------------------------------------------------------------------

describe("Remote integration: registering remote bundles in workspace registry", () => {
	let mockServer: MockRemoteServer;

	beforeEach(() => {
		ensureTestDir();
		mockServer = startMockRemoteServer(2);
	});

	afterEach(() => {
		mockServer?.close();
	});

	it("remote bundle can be registered into a workspace registry and provides tools", async () => {
		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			allowInsecureRemotes: true,
		});
		await provisionTestWorkspace(runtime);

		// Register a remote bundle into the workspace registry
		const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
		const ref: BundleRef = { url: mockServer.url, serverName: "runtime-remote" };
		await startBundleSource(ref, registry, new NoopEventSink(), undefined, { allowInsecureRemotes: true, wsId: "ws_test" });

		expect(registry.hasSource("runtime-remote")).toBe(true);

		// Verify tools are available via the registry
		const tools = await registry.availableTools();
		const remoteTools = tools.filter((t) => t.name.includes("integ_tool_"));
		expect(remoteTools.length).toBe(2);

		await registry.removeSource("runtime-remote");
		await runtime.shutdown();
	}, 15_000);

	it("failed remote bundle does not pollute registry while successful one registers", async () => {
		const runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			allowInsecureRemotes: true,
		});
		await provisionTestWorkspace(runtime);

		const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);

		// Try to register a bad remote (should fail)
		const badRef: BundleRef = { url: "http://127.0.0.1:1/mcp", serverName: "bad-remote" };
		const badResult = await Promise.allSettled([
			startBundleSource(badRef, registry, new NoopEventSink(), undefined, { allowInsecureRemotes: true, wsId: "ws_test" }),
		]);
		expect(badResult[0]!.status).toBe("rejected");
		expect(registry.hasSource("bad-remote")).toBe(false);

		// Register a good remote (should succeed)
		const goodRef: BundleRef = { url: mockServer.url, serverName: "good-remote" };
		await startBundleSource(goodRef, registry, new NoopEventSink(), undefined, { allowInsecureRemotes: true, wsId: "ws_test" });
		expect(registry.hasSource("good-remote")).toBe(true);

		await registry.removeSource("good-remote");
		await runtime.shutdown();
	}, 25_000);
});
