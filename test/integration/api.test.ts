import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createTestAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-api-test-${Date.now()}`);

beforeAll(async () => {
	mkdirSync(testDir, { recursive: true });
	runtime = await Runtime.start({
		model: { provider: "custom", adapter: createEchoModel() },
		noDefaultBundles: true,
		logging: { disabled: true },
		workDir: testDir,
	});

	await provisionTestWorkspace(runtime);

	handle = startServer({ runtime, port: 0 }); // port 0 = random available port
	baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
	handle.stop(true);
	await runtime.shutdown();
	rmSync(testDir, { recursive: true, force: true });
});

describe("POST /v1/chat", () => {
	it("returns valid ChatResult", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "Hello there", workspaceId: TEST_WORKSPACE_ID }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.response).toBe("Hello there");
		expect(body.conversationId).toMatch(/^conv_/);
		expect(body.stopReason).toBe("complete");
		expect(body.inputTokens).toBeGreaterThan(0);
		expect(body.outputTokens).toBeGreaterThan(0);
	});

	it("returns 400 for invalid JSON body", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: "not json",
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("bad_request");
		expect(body.message).toContain("Invalid JSON");
	});

	it("returns 400 when message is missing", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ conversationId: "abc", workspaceId: TEST_WORKSPACE_ID }),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("bad_request");
		expect(body.message).toContain("message");
	});
});

describe("POST /v1/chat/stream", () => {
	it("delivers SSE events ending with done", async () => {
		const res = await fetch(`${baseUrl}/v1/chat/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "Stream me", workspaceId: TEST_WORKSPACE_ID }),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");

		const text = await res.text();
		const events = parseSSE(text);

		// Must end with a done event
		const lastEvent = events[events.length - 1];
		expect(lastEvent?.event).toBe("done");

		// done event should contain the full ChatResult
		const doneData = JSON.parse(lastEvent!.data);
		expect(doneData.response).toBe("Stream me");
		expect(doneData.conversationId).toMatch(/^conv_/);
		expect(doneData.stopReason).toBe("complete");
	});

	it("includes text.delta events", async () => {
		const res = await fetch(`${baseUrl}/v1/chat/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "Delta test", workspaceId: TEST_WORKSPACE_ID }),
		});

		const text = await res.text();
		const events = parseSSE(text);
		const deltas = events.filter((e) => e.event === "text.delta");

		// EchoModelAdapter emits one chunk with the full text
		expect(deltas.length).toBeGreaterThanOrEqual(1);
	});

	it("done event includes usage object with all TurnUsage fields", async () => {
		const res = await fetch(`${baseUrl}/v1/chat/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "Usage test", workspaceId: TEST_WORKSPACE_ID }),
		});

		const text = await res.text();
		const events = parseSSE(text);
		const doneEvent = events.find((e) => e.event === "done");
		expect(doneEvent).toBeDefined();

		const doneData = JSON.parse(doneEvent!.data);

		// usage object must be present
		expect(doneData.usage).toBeDefined();
		expect(typeof doneData.usage).toBe("object");

		// All TurnUsage fields present
		expect(typeof doneData.usage.inputTokens).toBe("number");
		expect(typeof doneData.usage.outputTokens).toBe("number");
		expect(typeof doneData.usage.cacheReadTokens).toBe("number");
		expect(typeof doneData.usage.costUsd).toBe("number");
		expect(typeof doneData.usage.model).toBe("string");
		expect(typeof doneData.usage.llmMs).toBe("number");
		expect(typeof doneData.usage.iterations).toBe("number");

		// costUsd should be a valid number (not NaN)
		expect(Number.isFinite(doneData.usage.costUsd)).toBe(true);

		// model should be a non-empty string
		expect(doneData.usage.model.length).toBeGreaterThan(0);
	});

	it("done event preserves existing fields alongside usage (backward compat)", async () => {
		const res = await fetch(`${baseUrl}/v1/chat/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "Compat test", workspaceId: TEST_WORKSPACE_ID }),
		});

		const text = await res.text();
		const events = parseSSE(text);
		const doneEvent = events.find((e) => e.event === "done");
		const doneData = JSON.parse(doneEvent!.data);

		// Existing fields still present
		expect(doneData.response).toBe("Compat test");
		expect(doneData.conversationId).toMatch(/^conv_/);
		expect(doneData.stopReason).toBe("complete");
		expect(typeof doneData.inputTokens).toBe("number");
		expect(typeof doneData.outputTokens).toBe("number");
		expect(Array.isArray(doneData.toolCalls)).toBe(true);

		// usage is additional, not replacing
		expect(doneData.usage).toBeDefined();
	});
});

describe("GET /v1/health", () => {
	it("returns status ok with bundle health summary", async () => {
		const res = await fetch(`${baseUrl}/v1/health`);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
		expect(body.uptime).toBeUndefined();
		expect(Array.isArray(body.bundles)).toBe(true);
		// Each bundle entry should have name and state (not just a string)
		for (const b of body.bundles) {
			expect(typeof b.name).toBe("string");
			expect(typeof b.state).toBe("string");
		}
	});
});

describe("concurrent requests", () => {
	it("10 concurrent POST /v1/chat produce 10 correct independent responses", async () => {
		const messages = Array.from({ length: 10 }, (_, i) => `Message ${i}`);

		const results = await Promise.all(
			messages.map((message) =>
				fetch(`${baseUrl}/v1/chat`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
					body: JSON.stringify({ message, workspaceId: TEST_WORKSPACE_ID }),
				}).then((res) => res.json()),
			),
		);

		// All should succeed with correct echo responses
		for (let i = 0; i < 10; i++) {
			expect(results[i].response).toBe(`Message ${i}`);
			expect(results[i].conversationId).toMatch(/^conv_/);
		}

		// All conversation IDs should be unique (independent requests)
		const convIds = new Set(results.map((r) => r.conversationId));
		expect(convIds.size).toBe(10);
	});
});

describe("unknown routes", () => {
	it("returns 404 for unknown route", async () => {
		// Supply a valid workspace header so requireWorkspace middleware doesn't
		// short-circuit with 400 on sub-Honos using "*" — we're testing the
		// 404 handler, not workspace resolution.
		const res = await fetch(`${baseUrl}/v1/nonexistent`, {
			headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
		});

		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("not_found");
		expect(body.message).toBe("Not found");
	});
});

describe("Bearer token authentication", () => {
	let authHandle: ServerHandle;
	let authRuntime: Runtime;
	let authUrl: string;
	const TEST_API_KEY = "test-secret-key-12345";
	const authDir = join(tmpdir(), `nimblebrain-api-auth-${Date.now()}`);

	beforeAll(async () => {
		mkdirSync(authDir, { recursive: true });
		authRuntime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir: authDir,
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
		rmSync(authDir, { recursive: true, force: true });
	});

	it("accepts requests in dev mode (no auth adapter)", async () => {
		// The main server (dev mode) should accept all requests
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "no auth needed", workspaceId: TEST_WORKSPACE_ID }),
		});
		expect(res.status).toBe(200);
	});

	it("returns 200 with valid Bearer token", async () => {
		const res = await fetch(`${authUrl}/v1/chat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${TEST_API_KEY}`,
				"X-Workspace-Id": TEST_WORKSPACE_ID,
			},
			body: JSON.stringify({ message: "authed", workspaceId: TEST_WORKSPACE_ID }),
		});
		expect(res.status).toBe(200);
	});

	it("returns 401 when Authorization header is missing", async () => {
		const res = await fetch(`${authUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "no header", workspaceId: TEST_WORKSPACE_ID }),
		});
		expect(res.status).toBe(401);
		const body = await res.text();
		expect(body).toBe("");
	});

	it("returns 401 with wrong Bearer token", async () => {
		const res = await fetch(`${authUrl}/v1/chat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-key-entirely",
			},
			body: JSON.stringify({ message: "bad key", workspaceId: TEST_WORKSPACE_ID }),
		});
		expect(res.status).toBe(401);
		const body = await res.text();
		expect(body).toBe("");
	});

	it("returns 401 with malformed header (no Bearer prefix)", async () => {
		const res = await fetch(`${authUrl}/v1/chat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: TEST_API_KEY,
			},
			body: JSON.stringify({ message: "no prefix", workspaceId: TEST_WORKSPACE_ID }),
		});
		expect(res.status).toBe(401);
		const body = await res.text();
		expect(body).toBe("");
	});

	it("GET /v1/health returns 200 regardless of auth", async () => {
		const res = await fetch(`${authUrl}/v1/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

});

describe("POST /v1/tools/call", () => {
	it("returns 400 when server or tool missing", async () => {
		const res = await fetch(`${baseUrl}/v1/tools/call`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("bad_request");
	});

	it("returns 404 for unknown server", async () => {
		const res = await fetch(`${baseUrl}/v1/tools/call`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({
				server: "nonexistent",
				tool: "some_tool",
				arguments: {},
			}),
		});

		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("tool_not_found");
		expect(body.details.server).toBe("nonexistent");
		expect(body.details.tool).toBe("some_tool");
	});
});

describe("GET /v1/events", () => {
	it("returns SSE stream with correct headers and receives data", async () => {
		// Use the SSE manager directly to verify the endpoint works
		// The fetch API with SSE is tricky in tests, so we verify headers
		// via a short read and verify the manager unit tests cover broadcast logic

		const controller = new AbortController();

		// Broadcast a heartbeat to the manager so the SSE client gets data quickly
		setTimeout(() => {
			handle.sseManager.broadcast("heartbeat", {
				timestamp: new Date().toISOString(),
			});
		}, 50);

		const res = await fetch(`${baseUrl}/v1/events`, {
			signal: controller.signal,
			headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		expect(res.headers.get("Cache-Control")).toBe("no-cache");

		// Read a chunk from the stream
		const reader = res.body!.getReader();
		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);
		expect(text).toContain("event: heartbeat");

		controller.abort();
		reader.cancel().catch(() => {}); // Cleanup
	});
});

describe("SSE Event Manager", () => {
	it("broadcasts events to connected clients", async () => {
		// Import the SSE manager directly for unit testing
		const { SseEventManager } = await import("../../src/api/events.ts");
		const manager = new SseEventManager(60_000); // Long heartbeat to avoid noise

		const stream = manager.addClient();
		const reader = stream.getReader();

		// Broadcast a test event
		manager.broadcast("bundle.installed", {
			name: "test-app",
			bundleName: "@test/app",
			status: "running",
		});

		const { value, done } = await reader.read();
		expect(done).toBe(false);

		const text = new TextDecoder().decode(value);
		expect(text).toContain("event: bundle.installed");
		expect(text).toContain('"name":"test-app"');

		reader.cancel();
		manager.stop();
	});

	it("broadcasts to multiple clients", async () => {
		const { SseEventManager } = await import("../../src/api/events.ts");
		const manager = new SseEventManager(60_000);

		const stream1 = manager.addClient();
		const stream2 = manager.addClient();
		const reader1 = stream1.getReader();
		const reader2 = stream2.getReader();

		expect(manager.clientCount).toBe(2);

		manager.broadcast("data.changed", {
			server: "tasks",
			tool: "create_task",
			timestamp: new Date().toISOString(),
		});

		const [r1, r2] = await Promise.all([reader1.read(), reader2.read()]);

		const text1 = new TextDecoder().decode(r1.value);
		const text2 = new TextDecoder().decode(r2.value);

		expect(text1).toContain("event: data.changed");
		expect(text2).toContain("event: data.changed");
		expect(text1).toContain('"server":"tasks"');
		expect(text2).toContain('"tool":"create_task"');

		reader1.cancel();
		reader2.cancel();
		manager.stop();
	});

	it("cleans up disconnected clients", async () => {
		const { SseEventManager } = await import("../../src/api/events.ts");
		const manager = new SseEventManager(60_000);

		const stream = manager.addClient();
		const reader = stream.getReader();

		expect(manager.clientCount).toBe(1);

		// Cancel the reader (simulate disconnect)
		await reader.cancel();

		// Broadcast should clean up the disconnected client
		manager.broadcast("heartbeat", { timestamp: new Date().toISOString() });

		// After broadcast cleans up, client count should be 0
		expect(manager.clientCount).toBe(0);

		manager.stop();
	});

	it("emits only bundle and data.changed events via EventSink interface", async () => {
		const { SseEventManager } = await import("../../src/api/events.ts");
		const manager = new SseEventManager(60_000);

		const stream = manager.addClient();
		const reader = stream.getReader();

		// Emit a run.start event — should NOT be forwarded
		manager.emit({
			type: "run.start",
			data: { runId: "test" },
		});

		// Emit a bundle.crashed event — SHOULD be forwarded
		manager.emit({
			type: "bundle.crashed",
			data: { serverName: "weather", bundleName: "@test/weather" },
		});

		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);

		// Should only contain the bundle.crashed event
		expect(text).toContain("event: bundle.crashed");
		expect(text).not.toContain("run.start");

		reader.cancel();
		manager.stop();
	});
});

// =============================================================================
// Auth enforcement on new endpoints
// =============================================================================

describe("auth enforcement on new endpoints", () => {
	let authHandle2: ServerHandle;
	let authRuntime2: Runtime;
	let authUrl2: string;
	const TEST_KEY = "test-api-key-for-new-endpoints";
	const authDir2 = join(tmpdir(), `nimblebrain-api-auth2-${Date.now()}`);

	beforeAll(async () => {
		mkdirSync(authDir2, { recursive: true });
		authRuntime2 = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir: authDir2,
		});

		await provisionTestWorkspace(authRuntime2);

		authHandle2 = startServer({
			runtime: authRuntime2,
			port: 0,
			provider: createTestAuthAdapter(TEST_KEY, authRuntime2),
		});
		authUrl2 = `http://localhost:${authHandle2.port}`;
	});

	afterAll(async () => {
		authHandle2.stop(true);
		await authRuntime2.shutdown();
		rmSync(authDir2, { recursive: true, force: true });
	});

	it("POST /v1/tools/call returns 401 without Bearer token", async () => {
		const res = await fetch(`${authUrl2}/v1/tools/call`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ server: "test", tool: "tool", arguments: {} }),
		});
		expect(res.status).toBe(401);
	});

	it("GET /v1/events returns 401 without Bearer token", async () => {
		const res = await fetch(`${authUrl2}/v1/events`);
		expect(res.status).toBe(401);
	});
});

// --- SSE parsing helper ---

interface SSEEvent {
	event: string;
	data: string;
}

function parseSSE(text: string): SSEEvent[] {
	const events: SSEEvent[] = [];
	const blocks = text.split("\n\n").filter((b) => b.trim());

	for (const block of blocks) {
		const lines = block.split("\n");
		let event = "";
		let data = "";

		for (const line of lines) {
			if (line.startsWith("event: ")) {
				event = line.slice(7);
			} else if (line.startsWith("data: ")) {
				data = line.slice(6);
			}
		}

		if (event) {
			events.push({ event, data });
		}
	}

	return events;
}
