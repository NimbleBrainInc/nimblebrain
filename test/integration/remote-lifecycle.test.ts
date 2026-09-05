import { describe, expect, it, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

		const meta = await startBundleSource(ref, registry, new NoopEventSink(), {
			allowInsecureRemotes: true,
			wsId: "ws_test",
		});

		expect(meta).not.toBeNull();
		expect(meta.meta).not.toBeNull();
		expect(meta.meta!.version).toBe("remote (2 tools)");
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

		const meta = await startBundleSource(ref, registry, new NoopEventSink(), {
			allowInsecureRemotes: true,
			wsId: "ws_test",
		});
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
			startBundleSource(ref, registry, new NoopEventSink(), {
				allowInsecureRemotes: true,
				wsId: "ws_test",
			}),
		]);

		expect(results[0]!.status).toBe("rejected");
		expect(registry.hasSource("bad-remote")).toBe(false);
	}, 20_000);

	it("url bundle without static auth + missing wsId throws (no silent ws_default fallback)", async () => {
		// Credential-boundary guard: URL bundles that will open an OAuth flow
		// must be workspace-scoped. A silent `?? "ws_default"` fallback would
		// pool OAuth tokens across workspaces, so startBundleSource hard-errors
		// instead. If someone refactors and weakens the check to a default,
		// this test fails — which is the whole point.
		const registry = new ToolRegistry();
		const ref: BundleRef = {
			url: mockServer.url,
			serverName: "no-ws",
			// no transport.auth — triggers OAuth provider path
		};

		await expect(
			startBundleSource(ref, registry, new NoopEventSink(), {
				allowInsecureRemotes: true,
				// wsId intentionally omitted
			}),
		).rejects.toThrow(/requires opts\.workspaceContext.*opts\.wsId/);
		expect(registry.hasSource("no-ws")).toBe(false);
	}, 15_000);

	it("url bundle WITH static auth starts without wsId (no OAuth provider needed)", async () => {
		// Complement to the above: when static auth is present, no OAuth
		// provider is constructed, so missing wsId is not a credential-
		// boundary concern. Confirms the wsId requirement is scoped exactly
		// to the path that would otherwise leak credentials.
		const registry = new ToolRegistry();
		const ref: BundleRef = {
			url: mockServer.url,
			serverName: "static-auth",
			transport: { type: "streamable-http", auth: { type: "bearer", token: "t" } },
		};

		const meta = await startBundleSource(ref, registry, new NoopEventSink(), {
			allowInsecureRemotes: true,
			// wsId intentionally omitted — allowed here
		});
		expect(meta).not.toBeNull();
		expect(registry.hasSource("static-auth")).toBe(true);

		await registry.removeSource("static-auth");
	}, 15_000);

});
