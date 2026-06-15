/**
 * Regression: the outbound-OAuth callbacks must stay PUBLIC under adapter auth.
 *
 * `GET /v1/mcp-auth/callback` and `GET /v1/composio-auth/callback` are
 * unauthenticated by design — the vendor's browser returns here with no
 * platform session, and the flow is guarded by the state cookie + flow
 * registry, not by `requireAuth`. A wildcard `authed.use("*", requireAuth)`
 * inside `authRoutes` once leaked onto every sub-app mounted after it
 * (mcp-auth, composio-auth), so these callbacks 401'd whenever the user's
 * session wasn't present on the callback's landing origin — wedging the
 * connector at "Connecting…" forever. These tests pin the contract: the
 * callbacks are reachable without auth (400 for missing params, never 401),
 * while the genuinely-authenticated route in the same sub-app (logout) still
 * rejects unauthenticated callers.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createTestAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const API_KEY = "test-api-key-oauth-callback-public";
const testDir = join(tmpdir(), `nimblebrain-oauth-callback-${Date.now()}`);

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

	// Adapter (auth-enabled) mode — this is the only mode where the leak
	// manifests; dev mode passes every request through.
	handle = startServer({ runtime, port: 0, provider: createTestAuthAdapter(API_KEY, runtime) });
	baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
	handle.stop(true);
	await runtime.shutdown();
	rmSync(testDir, { recursive: true, force: true });
});

describe("outbound-OAuth callbacks are public under adapter auth", () => {
	it("GET /v1/mcp-auth/callback is reachable without auth (400 missing params, not 401)", async () => {
		const res = await fetch(`${baseUrl}/v1/mcp-auth/callback`);
		expect(res.status).not.toBe(401);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("missing code or state");
	});

	it("GET /v1/composio-auth/callback is reachable without auth (400 missing params, not 401)", async () => {
		const res = await fetch(`${baseUrl}/v1/composio-auth/callback`);
		expect(res.status).not.toBe(401);
		expect(res.status).toBe(400);
	});

	it("GET /v1/auth/callback (WorkOS) stays public — control", async () => {
		const res = await fetch(`${baseUrl}/v1/auth/callback`);
		expect(res.status).not.toBe(401);
	});

	it("/.well-known/oauth-protected-resource stays public — control", async () => {
		const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
		expect(res.status).not.toBe(401);
	});
});

describe("genuinely-authenticated routes still reject unauthenticated callers", () => {
	it("POST /v1/auth/logout without auth returns 401", async () => {
		const res = await fetch(`${baseUrl}/v1/auth/logout`, { method: "POST" });
		expect(res.status).toBe(401);
	});

	it("POST /v1/auth/logout with a valid bearer succeeds", async () => {
		const res = await fetch(`${baseUrl}/v1/auth/logout`, {
			method: "POST",
			headers: { Authorization: `Bearer ${API_KEY}` },
		});
		expect(res.status).not.toBe(401);
	});
});
