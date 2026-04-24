import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createTestAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import {
	constantTimeEqual,
	validateInternalToken,
	INTERNAL_TOKEN_ALLOWED_PATHS,
} from "../../src/api/auth-utils.ts";
import { filterEnvForBundle } from "../../src/bundles/env-filter.ts";
import { DEFAULT_BUNDLES } from "../../src/bundles/defaults.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const API_KEY = "test-api-key-for-internal-auth-12345";
const testDir = join(tmpdir(), `nimblebrain-internal-auth-${Date.now()}`);

beforeAll(async () => {
	mkdirSync(testDir, { recursive: true });
	runtime = await Runtime.start({
		model: { provider: "custom", adapter: createEchoModel() },
		noDefaultBundles: true,
		logging: { disabled: true },
		http: { port: 0, host: "127.0.0.1" },
		workDir: testDir,
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
	rmSync(testDir, { recursive: true, force: true });
});

describe("internal auth token - auth-utils", () => {
	it("validateInternalToken returns null for POST /v1/chat with correct token", () => {
		const token = "test-internal-token";
		const result = validateInternalToken(token, token, "/v1/chat", "POST");
		expect(result).toBeNull();
	});

	it("validateInternalToken returns null for POST /v1/chat/stream with correct token", () => {
		const token = "test-internal-token";
		const result = validateInternalToken(token, token, "/v1/chat/stream", "POST");
		expect(result).toBeNull();
	});

	it("validateInternalToken returns 403 for POST /v1/tools/call with correct token", () => {
		const token = "test-internal-token";
		const result = validateInternalToken(token, token, "/v1/tools/call", "POST");
		expect(result).not.toBeNull();
		expect(result!.status).toBe(403);
	});

	it("validateInternalToken returns 403 for GET /v1/apps/x/resources/y with correct token", () => {
		const token = "test-internal-token";
		const result = validateInternalToken(token, token, "/v1/apps/myapp/resources/primary", "GET");
		expect(result).not.toBeNull();
		expect(result!.status).toBe(403);
	});

	it("validateInternalToken returns 401 for wrong token", () => {
		const result = validateInternalToken("wrong-token", "correct-token", "/v1/chat", "POST");
		expect(result).not.toBeNull();
		expect(result!.status).toBe(401);
	});

	it("validateInternalToken returns 403 for GET /v1/chat (wrong method)", () => {
		const token = "test-internal-token";
		const result = validateInternalToken(token, token, "/v1/chat", "GET");
		expect(result).not.toBeNull();
		expect(result!.status).toBe(403);
	});

	it("INTERNAL_TOKEN_ALLOWED_PATHS contains only chat endpoints", () => {
		expect(INTERNAL_TOKEN_ALLOWED_PATHS.has("/v1/chat")).toBe(true);
		expect(INTERNAL_TOKEN_ALLOWED_PATHS.has("/v1/chat/stream")).toBe(true);
		expect(INTERNAL_TOKEN_ALLOWED_PATHS.has("/v1/tools/call")).toBe(false);
		expect(INTERNAL_TOKEN_ALLOWED_PATHS.has("/v1/events")).toBe(false);
	});
});

describe("internal auth token - server integration", () => {
	it("request with internal token to /v1/chat succeeds (200)", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${handle.internalToken}`,
				"X-Workspace-Id": TEST_WORKSPACE_ID,
			},
			body: JSON.stringify({ message: "Hello from bundle", workspaceId: TEST_WORKSPACE_ID }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.response).toBe("Hello from bundle");
	});

	it("request with internal token to /v1/chat/stream succeeds (200)", async () => {
		const res = await fetch(`${baseUrl}/v1/chat/stream`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${handle.internalToken}`,
				"X-Workspace-Id": TEST_WORKSPACE_ID,
			},
			body: JSON.stringify({ message: "Stream from bundle", workspaceId: TEST_WORKSPACE_ID }),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
	});

	it("request with internal token to /v1/tools/call returns 403", async () => {
		const res = await fetch(`${baseUrl}/v1/tools/call`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${handle.internalToken}`,
				"X-Workspace-Id": TEST_WORKSPACE_ID,
			},
			body: JSON.stringify({ name: "nb__get_config", input: {} }),
		});

		expect(res.status).toBe(403);
	});

	it("request with internal token to /v1/events returns 403", async () => {
		const res = await fetch(`${baseUrl}/v1/events`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${handle.internalToken}`,
				"X-Workspace-Id": TEST_WORKSPACE_ID,
			},
		});

		expect(res.status).toBe(403);
	});

	it("request with wrong internal token returns 401", async () => {
		const res = await fetch(`${baseUrl}/v1/chat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-token-value",
				"X-Workspace-Id": TEST_WORKSPACE_ID,
			},
			body: JSON.stringify({ message: "Should fail", workspaceId: TEST_WORKSPACE_ID }),
		});

		expect(res.status).toBe(401);
	});

	it("internal token is a valid UUID format", () => {
		expect(handle.internalToken).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("runtime exposes internal token via getInternalToken()", () => {
		expect(runtime.getInternalToken()).toBe(handle.internalToken);
	});
});

describe("internal auth token - env isolation", () => {
	it("NB_INTERNAL_TOKEN is hard-denied in env filter", () => {
		const env: Record<string, string> = {
			PATH: "/usr/bin",
			NB_INTERNAL_TOKEN: "secret-token",
		};
		const result = filterEnvForBundle(env, undefined, ["NB_INTERNAL_TOKEN"]);
		expect(result.NB_INTERNAL_TOKEN).toBeUndefined();
	});

	it("default bundles are marked as protected", () => {
		for (const bundle of DEFAULT_BUNDLES) {
			expect(bundle.protected).toBe(true);
		}
	});
});
