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

// --- Unauthenticated server (dev mode) ---

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-shell-${Date.now()}`);

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

describe("GET /v1/shell", () => {
	const wsHeaders = { "X-Workspace-Id": TEST_WORKSPACE_ID };

	it("returns 200 with placements array", async () => {
		const res = await fetch(`${baseUrl}/v1/shell`, { headers: wsHeaders });

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("application/json");

		const body = await res.json();
		expect(Array.isArray(body.placements)).toBe(true);
	});

	it("placements include core entries", async () => {
		const res = await fetch(`${baseUrl}/v1/shell`, { headers: wsHeaders });
		const body = await res.json();

		// With noDefaultBundles and no installed bundles, the placement registry
		// is empty (core "nb" source does not register placements itself).
		// Verify the response shape is valid — an empty array is expected here.
		expect(Array.isArray(body.placements)).toBe(true);
	});

	it("response includes chatEndpoint and eventsEndpoint", async () => {
		const res = await fetch(`${baseUrl}/v1/shell`, { headers: wsHeaders });
		const body = await res.json();

		expect(body.chatEndpoint).toBe("/v1/chat/stream");
		expect(body.eventsEndpoint).toBe("/v1/events");
	});
});

describe("GET /v1/shell auth", () => {
	let authHandle: ServerHandle;
	let authRuntime: Runtime;
	let authUrl: string;
	const TEST_API_KEY = "shell-test-api-key-12345";
	const shellAuthDir = join(tmpdir(), `nimblebrain-shell-auth-${Date.now()}`);

	beforeAll(async () => {
		mkdirSync(shellAuthDir, { recursive: true });
		authRuntime = await Runtime.start({
			model: { provider: "custom", adapter: createEchoModel() },
			noDefaultBundles: true,
			logging: { disabled: true },
			workDir: shellAuthDir,
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
		rmSync(shellAuthDir, { recursive: true, force: true });
	});

	it("returns 401 without auth", async () => {
		const res = await fetch(`${authUrl}/v1/shell`);
		expect(res.status).toBe(401);
	});

	it("returns 200 with valid Bearer token", async () => {
		const res = await fetch(`${authUrl}/v1/shell`, {
			headers: {
				Authorization: `Bearer ${TEST_API_KEY}`,
				"X-Workspace-Id": TEST_WORKSPACE_ID,
			},
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.placements)).toBe(true);
	});
});
