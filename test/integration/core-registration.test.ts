import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";


const testDir = join(tmpdir(), `nimblebrain-core-reg-${Date.now()}`);

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

// =============================================================================
// 1. Runtime has nb__ tools after startup
// =============================================================================

describe("nb-core registration in Runtime", () => {
	it("registry contains 'nb' source after startup", () => {
		const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
		expect(registry.hasSource("nb")).toBe(true);
	});

	it("nb__ tools appear in availableTools()", async () => {
		const tools = await runtime.availableTools();
		const coreTools = tools.filter((t) => t.name.startsWith("nb__"));
		expect(coreTools.length).toBeGreaterThanOrEqual(6);
		const names = coreTools.map((t) => t.name).sort();
		expect(names).toContain("nb__manage_identity");
	});

	it("nb__ tools are callable via ToolRegistry.execute()", async () => {
		const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
		const result = await runWithRequestContext(
			{ identity: null, workspaceId: TEST_WORKSPACE_ID, workspaceAgents: null, workspaceModelOverride: null },
			() => registry.execute({
				id: "test-core-exec",
				name: "nb__list_apps",
				input: {},
			}),
		);
		expect(result.isError).toBe(false);
		const data = result.structuredContent as Record<string, unknown>;
		expect(data.apps).toBeDefined();
		expect(Array.isArray(data.apps)).toBe(true);
	});
});

// =============================================================================
// 2. Resource serving via GET /v1/apps/nb/resources/:path
// =============================================================================

describe("GET /v1/apps/nb/resources/:path", () => {
	it("returns HTML for conversations", async () => {
		const res = await fetch(
			`${baseUrl}/v1/apps/nb/resources/conversations`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/html");
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("postMessage");
	});

	it("returns HTML for usage-dashboard", async () => {
		const res = await fetch(
			`${baseUrl}/v1/apps/nb/resources/usage-dashboard`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/html");
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("Usage");
	});

	it("returns HTML for all 7 core resources", async () => {
		const resources = [
			"conversations",
			"app-nav",
			"settings-link",
			"usage-bar",
			"usage-dashboard",
			"settings",
			"model-selector",
		];
		for (const name of resources) {
			const res = await fetch(
				`${baseUrl}/v1/apps/nb/resources/${name}`,
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toBe("text/html");
			const html = await res.text();
			expect(html).toContain("<!DOCTYPE html>");
		}
	});

	it("returns 404 for unknown core resource", async () => {
		const res = await fetch(
			`${baseUrl}/v1/apps/nb/resources/unknown`,
		);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("resource_not_found");
	});
});

// =============================================================================
// 3. Tool call proxy with server=nb
// =============================================================================

describe("POST /v1/tools/call with server=nb", () => {
	it("calls nb__list_apps and returns data", async () => {
		const res = await fetch(`${baseUrl}/v1/tools/call`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				server: "nb",
				tool: "list_apps",
				arguments: {},
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.isError).toBe(false);
		expect(Array.isArray(body.content)).toBe(true);
	});

	it("returns 404 for unknown tool on nb server", async () => {
		const res = await fetch(`${baseUrl}/v1/tools/call`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				server: "nb",
				tool: "nonexistent_tool",
				arguments: {},
			}),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("tool_not_found");
	});
});
