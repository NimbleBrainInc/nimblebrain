import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatResponse } from "../../src/api/schemas/responses.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/** The chat route's body: the run's `ChatResult` plus its token totals at the top level. */

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-appctx-${Date.now()}`);

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

describe("POST /v1/workspaces/:wsId/chat with appContext", () => {
  it("succeeds when appContext is provided", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Hello from app",
        appContext: { appName: "my-app", serverName: "my-server" },
        workspaceId: TEST_WORKSPACE_ID,
      }),
    });

    expect(res.status).toBe(200);
    const body = await readJson<ChatResponse>(res);
    expect(body.response).toBe("Hello from app");
    expect(body.conversationId).toMatch(/^conv_/);
  });

  it("succeeds without appContext (backwards compatible)", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "No context", workspaceId: TEST_WORKSPACE_ID }),
    });

    expect(res.status).toBe(200);
    const body = await readJson<ChatResponse>(res);
    expect(body.response).toBe("No context");
    expect(body.conversationId).toMatch(/^conv_/);
  });
});

describe("POST /v1/workspaces/:wsId/chat/stream with appContext", () => {
  it("succeeds when appContext is provided", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Stream no context", workspaceId: TEST_WORKSPACE_ID }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: done");
    expect(text).toContain("Stream no context");
  });
});
