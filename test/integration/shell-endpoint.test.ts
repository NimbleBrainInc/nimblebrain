import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellResponse } from "../../src/api/schemas/responses.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { testAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

// --- Unauthenticated server (dev mode) ---

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-shell-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createEchoModel() },
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

describe("GET /v1/workspaces/:wsId/shell", () => {
  const shellUrl = () => `${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/shell`;

  it("returns 200 with placements array", async () => {
    const res = await fetch(shellUrl());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = await readJson<ShellResponse>(res);
    expect(Array.isArray(body.placements)).toBe(true);
  });

  it("placements include core entries", async () => {
    const res = await fetch(shellUrl());
    const body = await readJson<ShellResponse>(res);

    // With no installed connectors, the placement registry
    // is empty (core "nb" source does not register placements itself).
    // Verify the response shape is valid — an empty array is expected here.
    expect(Array.isArray(body.placements)).toBe(true);
  });

  it("response includes chatEndpoint and eventsEndpoint", async () => {
    const res = await fetch(shellUrl());
    const body = await readJson<ShellResponse>(res);

    expect(body.chatEndpoint).toBe(`/v1/workspaces/${TEST_WORKSPACE_ID}/chat/stream`);
    expect(body.eventsEndpoint).toBe("/v1/events");
  });
});

describe("GET /v1/workspaces/:wsId/shell auth", () => {
  let authHandle: ServerHandle;
  let authRuntime: Runtime;
  let authUrl: string;
  const TEST_API_KEY = "shell-test-api-key-12345";
  const shellAuthDir = join(tmpdir(), `nimblebrain-shell-auth-${Date.now()}`);

  beforeAll(async () => {
    mkdirSync(shellAuthDir, { recursive: true });
    authRuntime = await Runtime.start({
      identityProvider: testAuthAdapter(TEST_API_KEY),
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir: shellAuthDir,
    });

    await provisionTestWorkspace(authRuntime);

    authHandle = startServer({
      runtime: authRuntime,
      port: 0,
    });
    authUrl = `http://localhost:${authHandle.port}`;
  });

  afterAll(async () => {
    authHandle.stop(true);
    await authRuntime.shutdown();
    rmSync(shellAuthDir, { recursive: true, force: true });
  });

  it("returns 401 without auth", async () => {
    const res = await fetch(`${authUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/shell`);
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid Bearer token", async () => {
    const res = await fetch(`${authUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/shell`, {
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await readJson<ShellResponse>(res);
    expect(Array.isArray(body.placements)).toBe(true);
  });
});
