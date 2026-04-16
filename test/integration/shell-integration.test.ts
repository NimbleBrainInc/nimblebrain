import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PlacementDeclaration } from "../../src/bundles/types.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Test setup: Runtime + HTTP server + temp directory for bundles
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `nimblebrain-shell-integ-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
	const workDir = join(testDir, "work");
	mkdirSync(workDir, { recursive: true });

	runtime = await Runtime.start({
		model: { provider: "custom", adapter: createEchoModel() },
		noDefaultBundles: true,
		workDir,
		logging: { disabled: true },
	});
	await provisionTestWorkspace(runtime);

	handle = startServer({ runtime, port: 0 });
	baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
	handle.stop(true);
	await runtime.shutdown();
	if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Helper: create a bundle directory on disk
// ---------------------------------------------------------------------------

function createBundleOnDisk(
	name: string,
	opts?: {
		placements?: PlacementDeclaration[];
		primaryView?: boolean;
	},
): string {
	const dir = join(testDir, `bundle-${name}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });

	const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
	const serverCode = `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: "${name}-test", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
`;
	writeFileSync(join(dir, "server.cjs"), serverCode);

	const meta: Record<string, unknown> = {};
	const uiBlock: Record<string, unknown> = {};

	if (opts?.placements) {
		uiBlock.placements = opts.placements;
	}

	if (opts?.primaryView) {
		uiBlock.primaryView = { resourceUri: `ui://${name}/main` };
	}

	if (Object.keys(uiBlock).length > 0) {
		meta["ai.nimblebrain/host"] = {
			host_version: "1.0",
			name: `${name} App`,
			icon: `${name}-icon`,
			...uiBlock,
		};
	}

	const manifest = {
		manifest_version: "0.4",
		name: `@test/${name}`,
		version: "1.0.0",
		description: `${name} test bundle`,
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
// Helper: create MCP client
// ---------------------------------------------------------------------------

async function createMcpClient(): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(
		new URL(`${baseUrl}/mcp`),
		{ requestInit: { headers: {} } },
	);
	const client = new Client({ name: "integ-test", version: "1.0.0" });
	await client.connect(transport);
	return client;
}

// =============================================================================
// 1. Install app → /v1/shell shows placements → uninstall → gone
// =============================================================================

describe("Install/uninstall → /v1/shell placement updates", () => {
	it("install bundle with placements → GET /v1/shell includes them → uninstall → gone", async () => {
		const placements: PlacementDeclaration[] = [
			{ slot: "sidebar.apps", resourceUri: "ui://tasks/nav", priority: 30, label: "Tasks" },
			{ slot: "main", resourceUri: "ui://tasks/board", route: "tasks", label: "Task Board" },
		];
		const bundleDir = createBundleOnDisk("tasks", { placements });

		// Install via lifecycle (direct API since POST /v1/apps/install needs mpak for named)
		const devRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
		const instance = await runtime.getLifecycle().installLocal(bundleDir, devRegistry, TEST_WORKSPACE_ID);
		const serverName = instance.serverName;

		try {
			// GET /v1/shell should now include the tasks placements
			const shellRes = await fetch(`${baseUrl}/v1/shell`);
			expect(shellRes.status).toBe(200);
			const shell = await shellRes.json();

			const tasksPlacements = shell.placements.filter(
				(p: { serverName: string }) => p.serverName === serverName,
			);
			expect(tasksPlacements.length).toBe(2);

			const slots = tasksPlacements.map((p: { slot: string }) => p.slot);
			expect(slots).toContain("sidebar.apps");
			expect(slots).toContain("main");

			// Uninstall
			await runtime.getLifecycle().uninstall(serverName, devRegistry, TEST_WORKSPACE_ID);

			// GET /v1/shell should no longer have tasks placements
			const shellRes2 = await fetch(`${baseUrl}/v1/shell`);
			const shell2 = await shellRes2.json();

			const tasksAfter = shell2.placements.filter(
				(p: { serverName: string }) => p.serverName === serverName,
			);
			expect(tasksAfter.length).toBe(0);
		} catch (err) {
			// Clean up on failure
			try {
				await runtime.getLifecycle().uninstall(serverName, devRegistry, TEST_WORKSPACE_ID);
			} catch {}
			throw err;
		}
	}, 15_000);
});

// =============================================================================
// 2. Bundle with placements → appears in /v1/shell
// =============================================================================

describe("Bundle with placements → /v1/shell", () => {
	it("bundle with main placement appears in /v1/shell", async () => {
		const bundleDir = createBundleOnDisk("placedapp", {
			placements: [
				{ slot: "main", resourceUri: "ui://placedapp/main", label: "placedapp App", icon: "placedapp-icon", route: "placedapp" },
			],
		});
		const devRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
		const instance = await runtime.getLifecycle().installLocal(bundleDir, devRegistry, TEST_WORKSPACE_ID);
		const serverName = instance.serverName;

		try {
			const res = await fetch(`${baseUrl}/v1/shell`);
			const body = await res.json();

			const entries = body.placements.filter(
				(p: { serverName: string }) => p.serverName === serverName,
			);
			expect(entries.length).toBe(1);
			expect(entries[0].slot).toBe("main");
			expect(entries[0].resourceUri).toBe("ui://placedapp/main");
			expect(entries[0].label).toBe("placedapp App");

			await runtime.getLifecycle().uninstall(serverName, devRegistry, TEST_WORKSPACE_ID);
		} catch (err) {
			try {
				await runtime.getLifecycle().uninstall(serverName, devRegistry, TEST_WORKSPACE_ID);
			} catch {}
			throw err;
		}
	}, 15_000);
});

// =============================================================================
// 3. MCP client → /mcp → lists nb__ tools → calls nb__list_apps
// =============================================================================

describe("MCP client e2e with nb tools", () => {
	it("listTools includes nb__ prefixed tools", async () => {
		const client = await createMcpClient();
		try {
			const result = await client.listTools();
			const coreTools = result.tools.filter((t) => t.name.startsWith("nb__"));
			expect(coreTools.length).toBeGreaterThanOrEqual(7);

			const names = coreTools.map((t) => t.name).sort();
			expect(names).toContain("nb__list_apps");
		} finally {
			await client.close();
		}
	});

	it("listTools includes nb__ system tools", async () => {
		const client = await createMcpClient();
		try {
			const result = await client.listTools();
			const nbTools = result.tools.filter((t) => t.name.startsWith("nb__"));
			expect(nbTools.length).toBeGreaterThanOrEqual(1);

			const names = nbTools.map((t) => t.name);
			expect(names).toContain("nb__search");
		} finally {
			await client.close();
		}
	});

	it("callTool nb__list_apps returns structured data", async () => {
		const client = await createMcpClient();
		try {
			const result = await client.callTool({
				name: "nb__list_apps",
				arguments: {},
			});
			expect(result.isError).toBeFalsy();
			expect(Array.isArray(result.content)).toBe(true);
			const textBlocks = result.content as Array<{ type: string; text: string }>;
			expect(textBlocks[0]!.type).toBe("text");
			// MCP protocol returns content blocks, not structuredContent.
			// The text should contain a human-readable app listing.
			expect(textBlocks[0]!.text.length).toBeGreaterThan(0);
		} finally {
			await client.close();
		}
	});

});

// =============================================================================
// 4. Core tools via Bridge proxy (POST /v1/tools/call server=nb)
// =============================================================================

describe("POST /v1/tools/call — all core tools via Bridge proxy", () => {
	// list_conversations already tested in core-registration.test.ts
	// Test the remaining core tools here

	it("list_apps returns array", async () => {
		const res = await fetch(`${baseUrl}/v1/tools/call`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ server: "nb", tool: "list_apps", arguments: {} }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.isError).toBe(false);
		expect(Array.isArray(body.content)).toBe(true);
	});

});
