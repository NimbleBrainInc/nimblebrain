import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createTestAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolSource, Tool } from "../../src/tools/types.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Fake tool source for testing
// ---------------------------------------------------------------------------
class FakeToolSource implements ToolSource {
	readonly name = "fake";

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	async tools(): Promise<Tool[]> {
		return [
			{
				name: "fake__echo",
				description: "Echoes input back",
				inputSchema: {
					type: "object",
					properties: { text: { type: "string" } },
					required: ["text"],
				},
				source: "inline",
			},
		];
	}

	async execute(
		toolName: string,
		input: Record<string, unknown>,
	): Promise<ToolResult> {
		if (toolName === "echo") {
			return { content: textContent(String(input.text)), isError: false };
		}
		return { content: textContent(`Unknown tool: ${toolName}`), isError: true };
	}
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-mcp-endpoint-${Date.now()}`);

beforeAll(async () => {
	mkdirSync(testDir, { recursive: true });

	runtime = await Runtime.start({
		model: { provider: "custom", adapter: createEchoModel() },
		noDefaultBundles: true,
		logging: { disabled: true },
		workDir: testDir,
	});
	await provisionTestWorkspace(runtime);

	// Register a fake tool source so we have tools to list/call.
	const wsRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
	wsRegistry.addSource(new FakeToolSource());

	handle = startServer({ runtime, port: 0 });
	baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
	handle.stop(true);
	await runtime.shutdown();
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Helper: create an MCP client connected to the /mcp endpoint
// ---------------------------------------------------------------------------
async function createMcpClient(
	opts: { headers?: Record<string, string> } = {},
): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(
		new URL(`${baseUrl}/mcp`),
		{
			requestInit: {
				headers: {
					"x-workspace-id": TEST_WORKSPACE_ID,
					...(opts.headers ?? {}),
				},
			},
		},
	);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(transport);
	return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("MCP Server Endpoint (/mcp)", () => {
	it("client connects and lists tools", async () => {
		const client = await createMcpClient();
		try {
			const result = await client.listTools();
			expect(result.tools.length).toBeGreaterThan(0);

			// Should include our fake__echo tool
			const echoTool = result.tools.find((t) => t.name === "fake__echo");
			expect(echoTool).toBeDefined();
			expect(echoTool!.description).toBe("Echoes input back");
		} finally {
			await client.close();
		}
	});

	it("client calls a tool", async () => {
		const client = await createMcpClient();
		try {
			const result = await client.callTool({
				name: "fake__echo",
				arguments: { text: "hello world" },
			});
			expect(result.isError).toBeFalsy();
			expect(result.content).toEqual([
				{ type: "text", text: "hello world" },
			]);
		} finally {
			await client.close();
		}
	});

	it("tool call with unknown tool returns error", async () => {
		const client = await createMcpClient();
		try {
			const result = await client.callTool({
				name: "fake__nonexistent",
				arguments: {},
			});
			expect(result.isError).toBe(true);
		} finally {
			await client.close();
		}
	});

	it("multiple clients can connect simultaneously", async () => {
		const client1 = await createMcpClient();
		const client2 = await createMcpClient();
		try {
			const [result1, result2] = await Promise.all([
				client1.listTools(),
				client2.listTools(),
			]);
			expect(result1.tools.length).toBeGreaterThan(0);
			expect(result2.tools.length).toBeGreaterThan(0);
		} finally {
			await Promise.all([client1.close(), client2.close()]);
		}
	});
});

describe("MCP Server Auth", () => {
	let authHandle: ServerHandle;
	let authRuntime: Runtime;
	let authUrl: string;
	const TEST_API_KEY = "mcp-test-key-12345";
	const authTestDir = join(tmpdir(), `nimblebrain-mcp-auth-${Date.now()}`);

	beforeAll(async () => {
		mkdirSync(authTestDir, { recursive: true });

		authRuntime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir: authTestDir,
		});

		await provisionTestWorkspace(authRuntime);

		authHandle = startServer({
			runtime: authRuntime,
			port: 0,
			provider: createTestAuthAdapter(TEST_API_KEY, authRuntime),
		});
		authUrl = `http://localhost:${authHandle.port}`;
	});

	afterAll(async () => {
		authHandle.stop(true);
		await authRuntime.shutdown();
		if (existsSync(authTestDir)) rmSync(authTestDir, { recursive: true });
	});

	it("returns 401 for unauthenticated POST /mcp", async () => {
		const res = await fetch(`${authUrl}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0.0" },
				},
				id: 1,
			}),
		});
		expect(res.status).toBe(401);
	});

	it("authenticated client can connect and list tools", async () => {
		const transport = new StreamableHTTPClientTransport(
			new URL(`${authUrl}/mcp`),
			{
				requestInit: {
					headers: {
						Authorization: `Bearer ${TEST_API_KEY}`,
						"x-workspace-id": TEST_WORKSPACE_ID,
					},
				},
			},
		);
		const client = new Client({ name: "auth-test", version: "1.0.0" });
		await client.connect(transport);
		try {
			const result = await client.listTools();
			expect(result.tools.length).toBeGreaterThan(0);
		} finally {
			await client.close();
		}
	});
});
