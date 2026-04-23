import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { startServer } from "../../../src/api/server.ts";
import type { ServerHandle } from "../../../src/api/server.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

/**
 * Integration tests for per-user request rate limiting on chat and tool-call endpoints.
 * Uses a dedicated server with low limits (3 chat, 3 tools) to verify:
 * - 429 when limit is exceeded
 * - Rate limiting doesn't bleed to unrelated endpoints
 * - Correct error shape and Retry-After header
 */

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-rate-limit-${Date.now()}`);

// Set low limits so tests can exhaust them quickly
const originalChatLimit = process.env.NB_CHAT_RATE_LIMIT;
const originalToolLimit = process.env.NB_TOOL_RATE_LIMIT;

beforeAll(async () => {
	process.env.NB_CHAT_RATE_LIMIT = "3";
	process.env.NB_TOOL_RATE_LIMIT = "3";

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

	// Restore env
	if (originalChatLimit === undefined) delete process.env.NB_CHAT_RATE_LIMIT;
	else process.env.NB_CHAT_RATE_LIMIT = originalChatLimit;
	if (originalToolLimit === undefined) delete process.env.NB_TOOL_RATE_LIMIT;
	else process.env.NB_TOOL_RATE_LIMIT = originalToolLimit;
});

describe("chat rate limiting", () => {
	it("returns 429 after exceeding chat limit", async () => {
		// Exhaust the limit
		for (let i = 0; i < 3; i++) {
			const res = await fetch(`${baseUrl}/v1/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
				body: JSON.stringify({ message: `msg ${i}`, workspaceId: TEST_WORKSPACE_ID }),
			});
			expect(res.status).toBe(200);
		}

		// Next request should be rate-limited
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ message: "over limit", workspaceId: TEST_WORKSPACE_ID }),
		});

		expect(res.status).toBe(429);
		const body = await res.json();
		expect(body.error).toBe("rate_limited");
		expect(body.message).toBe("Rate limit exceeded");
		expect(res.headers.get("Retry-After")).toBe("60");
	});

	it("does not rate-limit unrelated endpoints when chat is exhausted", async () => {
		// Chat is already exhausted from the previous test.
		// Health endpoint should still work.
		const healthRes = await fetch(`${baseUrl}/v1/health`);
		expect(healthRes.status).toBe(200);
	});
});

describe("tool-call rate limiting", () => {
	it("returns 429 after exceeding tool-call limit", async () => {
		// Exhaust the limit — these return 400/404 but still count
		for (let i = 0; i < 3; i++) {
			await fetch(`${baseUrl}/v1/tools/call`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
				body: JSON.stringify({ server: "x", tool: "y", arguments: {} }),
			});
		}

		const res = await fetch(`${baseUrl}/v1/tools/call`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
			body: JSON.stringify({ server: "x", tool: "y", arguments: {} }),
		});

		expect(res.status).toBe(429);
		const body = await res.json();
		expect(body.error).toBe("rate_limited");
	});

	it("does not rate-limit shell or file endpoints when tools/call is exhausted", async () => {
		// tools/call is exhausted, but /v1/shell should still work
		const shellRes = await fetch(`${baseUrl}/v1/shell`, {
			headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
		});
		expect(shellRes.status).toBe(200);
	});
});
