import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-appctx-${Date.now()}`);

beforeAll(async () => {
	mkdirSync(testDir, { recursive: true });
	runtime = await Runtime.start({
		model: { provider: "custom", adapter: createEchoModel() },
		noDefaultBundles: true,
		logging: { disabled: true },
		workDir: testDir,
	});

	await provisionTestWorkspace(runtime);

	handle = startServer({ runtime, port: 0 });
	baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
	handle.stop(true);
	await runtime.shutdown();
	rmSync(testDir, { recursive: true, force: true });
});

describe("POST /v1/chat with appContext", () => {
	it("succeeds when appContext is provided", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({
				message: "Hello from app",
				appContext: { appName: "my-app", serverName: "my-server" },
				workspaceId: TEST_WORKSPACE_ID,
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.response).toBe("Hello from app");
		expect(body.conversationId).toMatch(/^conv_/);
	});

	it("succeeds without appContext (backwards compatible)", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "No context", workspaceId: TEST_WORKSPACE_ID }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.response).toBe("No context");
		expect(body.conversationId).toMatch(/^conv_/);
	});
});

describe("POST /v1/chat/stream with appContext", () => {
	it("succeeds when appContext is provided", async () => {
		const res = await fetch(`${baseUrl}/v1/chat/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({
				message: "Stream with context",
				appContext: { appName: "my-app", serverName: "my-server" },
				workspaceId: TEST_WORKSPACE_ID,
			}),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");

		const text = await res.text();
		// Verify we got a done event with the echoed response
		expect(text).toContain("event: done");
		expect(text).toContain("Stream with context");
	});

	it("succeeds without appContext (backwards compatible)", async () => {
		const res = await fetch(`${baseUrl}/v1/chat/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "Stream no context", workspaceId: TEST_WORKSPACE_ID }),
		});

		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("event: done");
		expect(text).toContain("Stream no context");
	});
});
