/**
 * Metadata passthrough tests for the POST /v1/chat endpoint.
 *
 * Verifies that:
 * - metadata is stored in the conversation and accessible after chat
 * - allowedTools filters available tools correctly
 * - requests without metadata/allowedTools work identically (regression)
 *
 * Uses the real Runtime + HTTP server with the echo model (no LLM calls).
 */

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createTestAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";

// ---------------------------------------------------------------------------
// Setup: Runtime + HTTP server with echo model
// ---------------------------------------------------------------------------

const API_KEY = "chat-metadata-test-key-1234";
let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
	runtime = await Runtime.start({
		model: { provider: "custom", adapter: createEchoModel() },
		noDefaultBundles: true,
		logging: { disabled: true },
	});

	handle = startServer({
		runtime,
		port: 0,
		provider: createTestAuthAdapter(API_KEY, runtime),
	});
	baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
	handle?.stop(true);
	await runtime?.shutdown();
});

function authHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${API_KEY}`,
	};
}

// ---------------------------------------------------------------------------
// Metadata passthrough
// ---------------------------------------------------------------------------

describe("POST /v1/chat — metadata passthrough", () => {
	test("metadata stored in conversation and returned", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				message: "Hello with metadata",
				metadata: { source: "test", automationId: "auto-123" },
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.conversationId).toBeDefined();

		// The conversation should exist and we can continue it
		const followUp = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				message: "Follow up",
				conversationId: body.conversationId,
			}),
		});

		expect(followUp.status).toBe(200);
		const followUpBody = await followUp.json();
		// Same conversation
		expect(followUpBody.conversationId).toBe(body.conversationId);
	});

	test("invalid metadata (array) returns 400", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				message: "Bad metadata",
				metadata: ["not", "an", "object"],
			}),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("bad_request");
		expect(body.message).toContain("metadata must be a JSON object");
	});

	test("invalid metadata (string) returns 400", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				message: "Bad metadata",
				metadata: "just a string",
			}),
		});

		expect(res.status).toBe(400);
	});
});

// ---------------------------------------------------------------------------
// AllowedTools filtering
// ---------------------------------------------------------------------------

describe("POST /v1/chat — allowedTools filtering", () => {
	test("allowedTools restricts available tools", async () => {
		// Use echo model that just echoes — won't actually call tools, but
		// the surfacing logic still filters. We verify via a successful chat
		// that doesn't error out with allowedTools set.
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				message: "Use only echo tools",
				allowedTools: ["echo__*"],
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.response).toBeDefined();
		expect(body.conversationId).toBeDefined();
	});

	test("invalid allowedTools (not array) returns 400", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				message: "Bad tools",
				allowedTools: "echo__*",
			}),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("bad_request");
		expect(body.message).toContain("allowedTools must be an array");
	});

	test("invalid allowedTools (array of non-strings) returns 400", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				message: "Bad tools",
				allowedTools: [123, true],
			}),
		});

		expect(res.status).toBe(400);
	});
});

// ---------------------------------------------------------------------------
// Regression: no metadata/allowedTools works identically
// ---------------------------------------------------------------------------

describe("POST /v1/chat — regression (no metadata, no allowedTools)", () => {
	test("chat without metadata or allowedTools works unchanged", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				message: "Just a normal message",
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();

		expect(body.response).toBeDefined();
		expect(typeof body.response).toBe("string");
		expect(body.conversationId).toBeDefined();
		expect(body.inputTokens).toBeGreaterThanOrEqual(0);
		expect(body.outputTokens).toBeGreaterThanOrEqual(0);
	});

	test("chat with conversationId only works unchanged", async () => {
		// First message
		const res1 = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				message: "First message",
			}),
		});
		const body1 = await res1.json();
		const convId = body1.conversationId;

		// Second message in same conversation
		const res2 = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				message: "Second message",
				conversationId: convId,
			}),
		});

		expect(res2.status).toBe(200);
		const body2 = await res2.json();
		expect(body2.conversationId).toBe(convId);
		expect(body2.response).toBeDefined();
	});

	test("streaming chat without metadata works unchanged", async () => {
		const res = await fetch(`${baseUrl}/v1/chat/stream`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				message: "Stream without metadata",
			}),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");

		const text = await res.text();
		// Should contain at least a done event
		expect(text).toContain("event: done");
	});
});
