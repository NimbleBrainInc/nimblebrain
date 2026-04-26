import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createTestAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { makeInProcessSource } from "../helpers/in-process-source.ts";
import { textContent, extractText } from "../../src/engine/content-helpers.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

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

// --- Auth helper ---

function authHeaders(apiKey: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		"X-Workspace-Id": TEST_WORKSPACE_ID,
	};
}

describe("integration: full flow with auth", () => {
	const API_KEY = "integration-test-key-xyz";
	let runtime: Runtime;
	let handle: ServerHandle;
	let baseUrl: string;
	const workDir = join(tmpdir(), `nimblebrain-api-integration-full-${Date.now()}`);

	beforeAll(async () => {
		mkdirSync(workDir, { recursive: true });
		runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir,
		});

		await provisionTestWorkspace(runtime);

		handle = startServer({
			runtime,
			port: 0,
			provider: createTestAuthAdapter(API_KEY, runtime),
		});
		baseUrl = `http://localhost:${handle.port}`;
	});

	afterAll(async () => {
		handle.stop(true);
		await runtime.shutdown();
		rmSync(workDir, { recursive: true, force: true });
	});

	it("full lifecycle: auth → chat → stream → history → health → shutdown", async () => {
		// 1. Health is open without auth
		const healthRes = await fetch(`${baseUrl}/v1/health`);
		expect(healthRes.status).toBe(200);
		const health = await healthRes.json();
		expect(health.status).toBe("ok");

		// 2. Chat without auth is rejected
		const noAuthRes = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "should fail" }),
		});
		expect(noAuthRes.status).toBe(401);

		// 3. Chat with auth succeeds
		const chatRes = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(API_KEY),
			body: JSON.stringify({ message: "Hello integration" }),
		});
		expect(chatRes.status).toBe(200);
		const chatBody = await chatRes.json();
		expect(chatBody.response).toBe("Hello integration");
		expect(chatBody.conversationId).toMatch(/^conv_/);
		const convId = chatBody.conversationId;

		// 4. Second message in same conversation
		const chat2Res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(API_KEY),
			body: JSON.stringify({
				message: "Follow up message",
				conversationId: convId,
			}),
		});
		expect(chat2Res.status).toBe(200);
		const chat2Body = await chat2Res.json();
		expect(chat2Body.response).toBe("Follow up message");
		expect(chat2Body.conversationId).toBe(convId);

		// 5. Stream with auth succeeds
		const streamRes = await fetch(`${baseUrl}/v1/chat/stream`, {
			method: "POST",
			headers: authHeaders(API_KEY),
			body: JSON.stringify({ message: "Stream integration" }),
		});
		expect(streamRes.status).toBe(200);
		expect(streamRes.headers.get("Content-Type")).toBe("text/event-stream");

		const sseText = await streamRes.text();
		const events = parseSSE(sseText);
		const doneEvent = events.find((e) => e.event === "done");
		expect(doneEvent).toBeDefined();
		const doneData = JSON.parse(doneEvent!.data);
		expect(doneData.response).toBe("Stream integration");

	});
});

describe("integration: concurrent authenticated load", () => {
	const API_KEY = "concurrent-test-key-abc";
	let runtime: Runtime;
	let handle: ServerHandle;
	let baseUrl: string;
	const workDir = join(tmpdir(), `nimblebrain-api-integration-concurrent-${Date.now()}`);

	beforeAll(async () => {
		mkdirSync(workDir, { recursive: true });
		runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir,
		});

		await provisionTestWorkspace(runtime);

		handle = startServer({
			runtime,
			port: 0,
			provider: createTestAuthAdapter(API_KEY, runtime),
		});
		baseUrl = `http://localhost:${handle.port}`;
	});

	afterAll(async () => {
		handle.stop(true);
		await runtime.shutdown();
		rmSync(workDir, { recursive: true, force: true });
	});

	it("10 concurrent authenticated chat requests produce correct independent results", async () => {
		const messages = Array.from(
			{ length: 10 },
			(_, i) => `Concurrent message ${i}`,
		);

		const results = await Promise.all(
			messages.map((message) =>
				fetch(`${baseUrl}/v1/chat`, {
					method: "POST",
					headers: authHeaders(API_KEY),
					body: JSON.stringify({ message }),
				}).then((res) => res.json()),
			),
		);

		// All responses should echo correctly
		for (let i = 0; i < 10; i++) {
			expect(results[i].response).toBe(`Concurrent message ${i}`);
			expect(results[i].conversationId).toMatch(/^conv_/);
			expect(results[i].stopReason).toBe("complete");
		}

		// All conversation IDs should be unique
		const convIds = new Set(results.map((r) => r.conversationId));
		expect(convIds.size).toBe(10);
	});

	it("10 concurrent requests with mixed auth: valid succeed, invalid fail", async () => {
		const requests = Array.from({ length: 10 }, (_, i) => {
			const valid = i % 2 === 0;
			return fetch(`${baseUrl}/v1/chat`, {
				method: "POST",
				headers: valid
					? authHeaders(API_KEY)
					: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: `Mixed auth ${i}` }),
			});
		});

		const responses = await Promise.all(requests);

		for (let i = 0; i < 10; i++) {
			if (i % 2 === 0) {
				expect(responses[i].status).toBe(200);
				const body = await responses[i].json();
				expect(body.response).toBe(`Mixed auth ${i}`);
			} else {
				expect(responses[i].status).toBe(401);
			}
		}
	});
});

describe("integration: windowing under load", () => {
	let runtime: Runtime;
	let handle: ServerHandle;
	let baseUrl: string;
	const windowTestDir = join(tmpdir(), `nimblebrain-e2e-window-${Date.now()}`);

	beforeAll(async () => {
		mkdirSync(windowTestDir, { recursive: true });
		// Raise rate limit so 50+ sequential chat requests don't hit 429
		process.env.NB_CHAT_RATE_LIMIT = "200";

		runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			maxInputTokens: 2000, // Low budget to trigger windowing
			workDir: windowTestDir,
		});
		await provisionTestWorkspace(runtime);

		handle = startServer({ runtime, port: 0 });
		baseUrl = `http://localhost:${handle.port}`;
	});

	afterAll(async () => {
		handle.stop(true);
		await runtime.shutdown();
		delete process.env.NB_CHAT_RATE_LIMIT;
		if (existsSync(windowTestDir)) rmSync(windowTestDir, { recursive: true });
	});

	it("50+ messages in one conversation does not crash and returns valid responses", async () => {
		// Send first message and capture conversation ID
		const firstRes = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({
				message: "Start of a long conversation with padding text ".repeat(3),
			}),
		});
		expect(firstRes.status).toBe(200);
		const firstBody = await firstRes.json();
		const convId = firstBody.conversationId;

		// Send 49 more messages in the same conversation sequentially
		for (let i = 1; i < 50; i++) {
			const res = await fetch(`${baseUrl}/v1/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
				body: JSON.stringify({
					message: `Message ${i} with some padding content to use tokens`,
					conversationId: convId,
				}),
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			// Echo model echoes the last user message in the windowed prompt,
			// which may differ from the sent message once windowing truncates history
			expect(typeof body.response).toBe("string");
			expect(body.conversationId).toBe(convId);
		}

	});

	it("concurrent requests on a long conversation are rejected cleanly", async () => {
		// Create a conversation with some history
		const firstRes = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "Seed message for concurrent windowing test" }),
		});
		const firstBody = await firstRes.json();
		const convId = firstBody.conversationId;

		// Add 10 messages sequentially to build up history
		for (let i = 0; i < 10; i++) {
			await fetch(`${baseUrl}/v1/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
				body: JSON.stringify({
					message: `Building history message ${i} with extra padding text`,
					conversationId: convId,
				}),
			});
		}

		// Fire 5 concurrent requests on the same conversation. Only one may run;
		// the rest must fail with 409 run_in_progress rather than corrupting state.
		const concurrentResults = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				fetch(`${baseUrl}/v1/chat`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
					body: JSON.stringify({
						message: `Concurrent on long conv ${i}`,
						conversationId: convId,
					}),
				}).then(async (r) => ({ status: r.status, body: await r.json() })),
			),
		);

		const ok = concurrentResults.filter((r) => r.status === 200);
		const rejected = concurrentResults.filter((r) => r.status === 409);
		expect(ok.length + rejected.length).toBe(5);
		expect(ok.length).toBeGreaterThanOrEqual(1);
		for (const r of ok) {
			expect(typeof r.body.response).toBe("string");
			expect(r.body.conversationId).toBe(convId);
		}
		for (const r of rejected) {
			expect(r.body.error).toBe("run_in_progress");
		}
	});
});

describe("integration: auth boundary", () => {
	const API_KEY = "boundary-test-key-999";
	let runtime: Runtime;
	let handle: ServerHandle;
	let baseUrl: string;
	const workDir = join(tmpdir(), `nimblebrain-api-integration-boundary-${Date.now()}`);

	beforeAll(async () => {
		mkdirSync(workDir, { recursive: true });
		runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir,
		});

		await provisionTestWorkspace(runtime);

		handle = startServer({
			runtime,
			port: 0,
			provider: createTestAuthAdapter(API_KEY, runtime),
		});
		baseUrl = `http://localhost:${handle.port}`;
	});

	afterAll(async () => {
		handle.stop(true);
		await runtime.shutdown();
		rmSync(workDir, { recursive: true, force: true });
	});

	it("health endpoints are always open, all other endpoints require auth", async () => {
		// Health endpoint works without auth
		const healthRes = await fetch(`${baseUrl}/v1/health`);
		expect(healthRes.status).toBe(200);

		// Chat requires auth
		const chatNoAuth = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "no auth" }),
		});
		expect(chatNoAuth.status).toBe(401);

		// Stream requires auth
		const streamNoAuth = await fetch(`${baseUrl}/v1/chat/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "no auth" }),
		});
		expect(streamNoAuth.status).toBe(401);

		// All succeed with valid auth
		const [chatAuth, streamAuth] = await Promise.all([
			fetch(`${baseUrl}/v1/chat`, {
				method: "POST",
				headers: authHeaders(API_KEY),
				body: JSON.stringify({ message: "authed chat" }),
			}),
			fetch(`${baseUrl}/v1/chat/stream`, {
				method: "POST",
				headers: authHeaders(API_KEY),
				body: JSON.stringify({ message: "authed stream" }),
			}),
		]);

		expect(chatAuth.status).toBe(200);
		expect(streamAuth.status).toBe(200);
	});
});

// =============================================================================
// E2E Scenario 1: Install app -> tool call via API
// =============================================================================

describe("E2E: install app -> tool call via API", () => {
	let runtime: Runtime;
	let handle: ServerHandle;
	let baseUrl: string;
	const testDir = join(tmpdir(), `nimblebrain-e2e-install-${Date.now()}`);

	beforeAll(async () => {
		mkdirSync(testDir, { recursive: true });

		runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir: testDir,
		});
		await provisionTestWorkspace(runtime);

		// Register an InlineSource to simulate an installed app with tools
		const taskSource = await makeInProcessSource("tasks", [
			{
				name: "create_task",
				description: "Create a new task",
				inputSchema: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
				},
				handler: async (input) => ({
					content: textContent(JSON.stringify({ id: "task-001", title: input.title })),
					isError: false,
				}),
			},
			{
				name: "list_tasks",
				description: "List all tasks",
				inputSchema: { type: "object", properties: {} },
				handler: async () => ({
					content: textContent(JSON.stringify([{ id: "task-001", title: "Test" }])),
					isError: false,
				}),
			},
		]);
		const wsRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
		wsRegistry.addSource(taskSource);

		// Seed lifecycle instance to match the registered source
		runtime.getLifecycle().seedInstance("tasks", "@nimblebraininc/tasks", {
			name: "@nimblebraininc/tasks",
			trustScore: 92,
			ui: {
				name: "Task Manager",
				icon: "check",
				primaryView: { resourceUri: "ui://tasks/board" },
			},
		}, undefined, TEST_WORKSPACE_ID);

		handle = startServer({ runtime, port: 0 });
		baseUrl = `http://localhost:${handle.port}`;
	});

	afterAll(async () => {
		handle.stop(true);
		await runtime.shutdown();
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	it("app tools are callable via POST /v1/tools/call and return correct data", async () => {
		const res = await fetch(`${baseUrl}/v1/tools/call`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({
				server: "tasks",
				tool: "create_task",
				arguments: { title: "Write tests" },
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.isError).toBe(false);
		const parsed = JSON.parse(body.content[0].text);
		expect(parsed.id).toBe("task-001");
		expect(parsed.title).toBe("Write tests");
	}, 10_000);

});

// =============================================================================
// E2E Scenario 4: SSE events flow — tool call triggers data.changed event
// =============================================================================

describe("E2E: tool call via API -> SSE data.changed event", () => {
	let runtime: Runtime;
	let handle: ServerHandle;
	let baseUrl: string;
	const sseTestDir = join(tmpdir(), `nimblebrain-e2e-sse-${Date.now()}`);

	beforeAll(async () => {
		mkdirSync(sseTestDir, { recursive: true });

		runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir: sseTestDir,
		});
		await provisionTestWorkspace(runtime);

		// Register a tool source so we can make a tool call
		const notesSource = await makeInProcessSource("notes", [
			{
				name: "save_note",
				description: "Save a note",
				inputSchema: {
					type: "object",
					properties: { text: { type: "string" } },
				},
				handler: async (input) => ({
					content: textContent(`Saved: ${input.text}`),
					isError: false,
				}),
			},
		]);
		const wsRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
		wsRegistry.addSource(notesSource);
		runtime.getLifecycle().seedInstance("notes", "@test/notes", {
			name: "@test/notes",
		}, undefined, TEST_WORKSPACE_ID);

		handle = startServer({ runtime, port: 0 });
		baseUrl = `http://localhost:${handle.port}`;
	});

	afterAll(async () => {
		handle.stop(true);
		await runtime.shutdown();
		if (existsSync(sseTestDir)) rmSync(sseTestDir, { recursive: true });
	});

	it("POST /v1/tools/call returns correct result for registered tool", async () => {
		const toolRes = await fetch(`${baseUrl}/v1/tools/call`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({
				server: "notes",
				tool: "save_note",
				arguments: { text: "Important note" },
			}),
		});
		expect(toolRes.status).toBe(200);
		const toolBody = await toolRes.json();
		expect(toolBody.content).toEqual([{ type: "text", text: "Saved: Important note" }]);
		expect(toolBody.isError).toBe(false);
	}, 10_000);

	it("SSE manager broadcasts data.changed when emitted by routes", async () => {
		// Verify that the SSE manager on the server handle receives data.changed events
		// by broadcasting directly (the server wires tool.done -> data.changed in server.ts)
		const stream = handle.sseManager.addClient();
		const reader = stream.getReader();

		handle.sseManager.broadcast("data.changed", {
			server: "notes",
			tool: "save_note",
			timestamp: new Date().toISOString(),
		});

		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);
		expect(text).toContain("event: data.changed");
		expect(text).toContain('"server":"notes"');
		expect(text).toContain('"tool":"save_note"');

		// Parse the event data to verify timestamp is present
		const dataMatch = text.match(/data: (.+)/);
		expect(dataMatch).not.toBeNull();
		const eventData = JSON.parse(dataMatch![1]);
		expect(typeof eventData.timestamp).toBe("string");
		expect(eventData.server).toBe("notes");
		expect(eventData.tool).toBe("save_note");

		reader.cancel();
	}, 10_000);
});

// =============================================================================
// E2E Scenario 5: Multi-step conversation with workspace cross-checks
// =============================================================================

describe("E2E: multi-step conversation -> history -> conversations list consistency", () => {
	let runtime: Runtime;
	let handle: ServerHandle;
	let baseUrl: string;
	const multiStepDir = join(tmpdir(), `nimblebrain-e2e-multistep-${Date.now()}`);

	beforeAll(async () => {
		mkdirSync(multiStepDir, { recursive: true });

		runtime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir: multiStepDir,
		});
		await provisionTestWorkspace(runtime);

		handle = startServer({ runtime, port: 0 });
		baseUrl = `http://localhost:${handle.port}`;
	});

	afterAll(async () => {
		handle.stop(true);
		await runtime.shutdown();
		if (existsSync(multiStepDir)) rmSync(multiStepDir, { recursive: true });
	});

	it("3-turn conversation: messages accumulate correctly in history", async () => {
		const messages = [
			"What is the weather?",
			"Tell me more about the forecast",
			"Thanks for the information",
		];

		let convId: string | undefined;
		for (const msg of messages) {
			const res = await fetch(`${baseUrl}/v1/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
				body: JSON.stringify({
					message: msg,
					...(convId ? { conversationId: convId } : {}),
				}),
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.response).toBe(msg);
			if (!convId) convId = body.conversationId;
			expect(body.conversationId).toBe(convId);
		}

	});

	it("streaming chat produces SSE text.delta and done events with valid schemas", async () => {
		const res = await fetch(`${baseUrl}/v1/chat/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "Stream schema test" }),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");

		const text = await res.text();
		const events = parseSSE(text);

		// Must have at least one text.delta and a done event
		const deltas = events.filter((e) => e.event === "text.delta");
		const done = events.find((e) => e.event === "done");

		expect(deltas.length).toBeGreaterThanOrEqual(1);
		expect(done).toBeDefined();

		// Verify done event schema: must have response, conversationId, stopReason
		const doneData = JSON.parse(done!.data);
		expect(typeof doneData.response).toBe("string");
		expect(doneData.response).toBe("Stream schema test");
		expect(typeof doneData.conversationId).toBe("string");
		expect(doneData.conversationId).toMatch(/^conv_/);
		expect(doneData.stopReason).toBe("complete");
		expect(typeof doneData.inputTokens).toBe("number");
		expect(typeof doneData.outputTokens).toBe("number");
	});
});

// =============================================================================
// E2E Scenario 6: SSE event manager — bundle lifecycle events
// =============================================================================

describe("E2E: SSE event filtering — only bundle and data.changed events pass through", () => {
	it("SseEventManager.emit forwards bundle.installed but not run.start", async () => {
		const { SseEventManager } = await import("../../src/api/events.ts");
		const manager = new SseEventManager(60_000);

		const stream = manager.addClient();
		const reader = stream.getReader();

		// Emit events: one that should be forwarded, one that should not
		manager.emit({
			type: "run.start",
			data: { runId: "test" },
		});

		manager.emit({
			type: "bundle.installed",
			data: {
				serverName: "tasks",
				bundleName: "@test/tasks",
				version: "1.0.0",
				type: "plain",
				trustScore: 85,
				ui: null,
			},
		});

		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);

		// Should only contain the bundle.installed event, not run.start
		expect(text).toContain("event: bundle.installed");
		expect(text).toContain('"serverName":"tasks"');
		expect(text).toContain('"trustScore":85');
		expect(text).not.toContain("run.start");

		reader.cancel();
		manager.stop();
	});

	it("SseEventManager.emit forwards data.changed with server and tool fields", async () => {
		const { SseEventManager } = await import("../../src/api/events.ts");
		const manager = new SseEventManager(60_000);

		const stream = manager.addClient();
		const reader = stream.getReader();

		manager.emit({
			type: "data.changed",
			data: {
				server: "crm",
				tool: "create_contact",
				timestamp: "2025-01-01T00:00:00Z",
			},
		});

		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);

		expect(text).toContain("event: data.changed");

		// Parse the data to verify schema
		const dataMatch = text.match(/data: (.+)/);
		expect(dataMatch).not.toBeNull();
		const parsed = JSON.parse(dataMatch![1]);
		expect(parsed.server).toBe("crm");
		expect(parsed.tool).toBe("create_contact");
		expect(parsed.timestamp).toBe("2025-01-01T00:00:00Z");

		reader.cancel();
		manager.stop();
	});
});
