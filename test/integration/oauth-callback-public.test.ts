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
import { _resetComposioConfigForTest } from "../../src/composio/sdk.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createTestAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const API_KEY = "test-api-key-oauth-callback-public";
const testDir = join(tmpdir(), `nimblebrain-oauth-callback-${Date.now()}`);
const savedComposioApiKey = process.env.COMPOSIO_API_KEY;

beforeAll(async () => {
	mkdirSync(testDir, { recursive: true });
	// The Composio callback route is owned by the Composio managed-connector
	// provider and mounted only when the provider is registered — i.e. only when
	// Composio is configured. Configure it so the public-callback contract below
	// (reachable without auth) actually has a route to exercise.
	process.env.COMPOSIO_API_KEY = "test-composio-key-oauth-callback-public";
	_resetComposioConfigForTest();
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
	if (savedComposioApiKey === undefined) delete process.env.COMPOSIO_API_KEY;
	else process.env.COMPOSIO_API_KEY = savedComposioApiKey;
	_resetComposioConfigForTest();
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

// The safety of the authenticated route groups' `authed.use("*", requireAuth)`
// wildcards (resources/tools/chat/bootstrap/mcp) rests on a MOUNT-ORDER
// invariant in app.ts: every public/special route is registered BEFORE the
// authenticated tail, so the leaked `/*` matcher never reaches them. That
// invariant is enforced by comments today. Pin it under CI: a reorder, or a
// new leaking wildcard mounted ahead of these, flips them to 401 and fails
// here instead of reaching production.
// Real platform GET routes only. The bare test server has no Caddy/ALB in
// front, so liveness paths (/healthz, /readyz) aren't platform routes here and
// an unregistered path falls through to a late authenticated `.use("*")` and
// 401s — a harness artifact, not the invariant under test.
const PUBLIC_GET_ROUTES = [
	"/.well-known/oauth-protected-resource",
	"/.well-known/oauth-authorization-server",
	"/v1/auth/callback",
	"/v1/mcp-auth/callback",
	"/v1/composio-auth/callback",
];

describe("public/special routes stay reachable without auth (mount-order invariant)", () => {
	for (const path of PUBLIC_GET_ROUTES) {
		it(`GET ${path} is not 401`, async () => {
			const res = await fetch(`${baseUrl}${path}`);
			expect(res.status).not.toBe(401);
		});
	}
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
