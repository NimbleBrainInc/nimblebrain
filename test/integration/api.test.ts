import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApiErrorBody,
  ChatResponse,
  HealthResponse,
} from "../../src/api/schemas/responses.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { postChatTurn } from "../helpers/chat-turn.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { engineEvent, runStartPayload } from "../helpers/engine-events.ts";
import { readJson } from "../helpers/http.ts";
import { readConnected } from "../helpers/sse.ts";
import { TEST_IDENTITY, testAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-api-test-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createEchoModel() },
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

describe("POST /v1/workspaces/:wsId/chat/start", () => {
  it("runs a turn whose done frame is a valid ChatResponse", async () => {
    const res = await postChatTurn(baseUrl, TEST_WORKSPACE_ID, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello there", workspaceId: TEST_WORKSPACE_ID }),
    });

    expect(res.status).toBe(200);
    const body = await readJson<ChatResponse>(res);
    expect(body.response).toBe("Hello there");
    expect(body.conversationId).toMatch(/^conv_/);
    expect(body.stopReason).toBe("complete");
    expect(body.inputTokens).toBeGreaterThan(0);
    expect(body.outputTokens).toBeGreaterThan(0);
    expect(Array.isArray(body.toolCalls)).toBe(true);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("Invalid JSON");
  });

  it("returns 400 when message is missing", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "abc", workspaceId: TEST_WORKSPACE_ID }),
    });

    expect(res.status).toBe(400);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("message");
  });

  it("the done frame includes a usage object with all TurnUsage fields", async () => {
    const res = await postChatTurn(baseUrl, TEST_WORKSPACE_ID, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Usage test", workspaceId: TEST_WORKSPACE_ID }),
    });
    const doneData = await readJson<ChatResponse>(res);

    expect(typeof doneData.usage).toBe("object");
    expect(typeof doneData.usage.inputTokens).toBe("number");
    expect(typeof doneData.usage.outputTokens).toBe("number");
    expect(typeof doneData.usage.cacheReadTokens).toBe("number");
    expect(typeof doneData.usage.costUsd).toBe("number");
    expect(typeof doneData.usage.model).toBe("string");
    expect(typeof doneData.usage.llmMs).toBe("number");
    expect(typeof doneData.usage.iterations).toBe("number");
    expect(Number.isFinite(doneData.usage.costUsd)).toBe(true);
    expect(doneData.usage.model.length).toBeGreaterThan(0);
  });
});

describe("GET /v1/health", () => {
  it("returns status ok and nothing else", async () => {
    const res = await fetch(`${baseUrl}/v1/health`);

    expect(res.status).toBe(200);
    // Public and unauthenticated: build identity and connector names stay off it.
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("concurrent requests", () => {
  it("10 concurrent chat turns produce 10 correct independent responses", async () => {
    const messages = Array.from({ length: 10 }, (_, i) => `Message ${i}`);

    const results = await Promise.all(
      messages.map((message) =>
        postChatTurn(baseUrl, TEST_WORKSPACE_ID, {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, workspaceId: TEST_WORKSPACE_ID }),
        }).then((res) => readJson<ChatResponse>(res)),
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
    const res = await fetch(`${baseUrl}/v1/nonexistent`);

    expect(res.status).toBe(404);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("not_found");
    expect(body.message).toBe("Not found");
  });

  it("workspace-scoped routes exist only under /v1/workspaces/:wsId", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "unaddressed" }),
    });

    expect(res.status).toBe(404);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("not_found");
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
      identityProvider: testAuthAdapter(TEST_API_KEY),
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir: authDir,
    });

    await provisionTestWorkspace(authRuntime, TEST_WORKSPACE_ID, "Test Workspace", [
      TEST_IDENTITY.id,
    ]);

    authHandle = startServer({
      runtime: authRuntime,
      port: 0,
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
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "no auth needed", workspaceId: TEST_WORKSPACE_ID }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 200 with valid Bearer token", async () => {
    const res = await fetch(`${authUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: JSON.stringify({ message: "authed", workspaceId: TEST_WORKSPACE_ID }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await fetch(`${authUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "no header", workspaceId: TEST_WORKSPACE_ID }),
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toBe("");
  });

  it("returns 401 with wrong Bearer token", async () => {
    const res = await fetch(`${authUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
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
    const res = await fetch(`${authUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
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
    const body = await readJson<HealthResponse>(res);
    expect(body.status).toBe("ok");
  });
});

describe("POST /v1/workspaces/:wsId/tools/call", () => {
  it("returns 400 when server or tool missing", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("bad_request");
  });

  it("returns 404 for unknown server", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server: "nonexistent",
        tool: "some_tool",
        arguments: {},
      }),
    });

    expect(res.status).toBe(404);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("tool_not_found");
    expect(body.details.server).toBe("nonexistent");
    expect(body.details.tool).toBe("some_tool");
  });
});

describe("GET /v1/events", () => {
  /**
   * Open `/v1/events` and report what arrived before any event was
   * broadcast. Counts broadcasts while the request is pending, and gives up
   * after `deadlineMs` so a stream that stays silent fails here instead of
   * hanging until the next 30s heartbeat.
   */
  async function openBeforeAnyBroadcast(deadlineMs = 2000) {
    const broadcast = handle.sseManager.broadcast.bind(handle.sseManager);
    let broadcasts = 0;
    handle.sseManager.broadcast = (...args) => {
      broadcasts++;
      broadcast(...args);
    };
    const controller = new AbortController();
    try {
      const res = await Promise.race([
        fetch(`${baseUrl}/v1/events`, { signal: controller.signal }),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), deadlineMs)),
      ]);
      if (res === "pending") {
        controller.abort();
        throw new Error(`GET /v1/events sent no response head within ${deadlineMs}ms`);
      }
      const broadcastsBeforeHead = broadcasts;
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      await reader.cancel().catch(() => {});
      return { res, firstChunk: new TextDecoder().decode(value), broadcastsBeforeHead };
    } finally {
      handle.sseManager.broadcast = broadcast;
      controller.abort();
    }
  }

  it("sends its response head, with SSE headers, before any event is broadcast", async () => {
    const { res, firstChunk, broadcastsBeforeHead } = await openBeforeAnyBroadcast();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(broadcastsBeforeHead).toBe(0);
    expect(firstChunk).toBe(": connected\n\n");
  });
});

describe("SSE Event Manager", () => {
  it("broadcasts events to connected clients", async () => {
    // Import the SSE manager directly for unit testing
    const { SseEventManager } = await import("../../src/api/events.ts");
    const manager = new SseEventManager(60_000); // Long heartbeat to avoid noise

    const stream = manager.addIdentityClient("usr_test", new Set(["ws_0076759dbbe19fcc"]));
    const reader = stream.getReader();
    await readConnected(reader);

    // Broadcast a test event
    manager.broadcast("connector.installed", {
      name: "test-app",
      connectorName: "@test/app",
      status: "running",
    });

    const { value, done } = await reader.read();
    expect(done).toBe(false);

    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: connector.installed");
    expect(text).toContain('"name":"test-app"');

    reader.cancel();
    manager.stop();
  });

  it("broadcasts to multiple clients", async () => {
    const { SseEventManager } = await import("../../src/api/events.ts");
    const manager = new SseEventManager(60_000);

    const stream1 = manager.addIdentityClient("usr_test", new Set(["ws_0076759dbbe19fcc"]));
    const stream2 = manager.addIdentityClient("usr_test", new Set(["ws_0076759dbbe19fcc"]));
    const reader1 = stream1.getReader();
    const reader2 = stream2.getReader();
    await Promise.all([readConnected(reader1), readConnected(reader2)]);

    expect(manager.clientCount).toBe(2);

    manager.broadcast("config.changed", {
      server: "tasks",
      tool: "create_task",
      timestamp: new Date().toISOString(),
    });

    const [r1, r2] = await Promise.all([reader1.read(), reader2.read()]);

    const text1 = new TextDecoder().decode(r1.value);
    const text2 = new TextDecoder().decode(r2.value);

    expect(text1).toContain("event: config.changed");
    expect(text2).toContain("event: config.changed");
    expect(text1).toContain('"server":"tasks"');
    expect(text2).toContain('"tool":"create_task"');

    reader1.cancel();
    reader2.cancel();
    manager.stop();
  });

  it("cleans up disconnected clients", async () => {
    const { SseEventManager } = await import("../../src/api/events.ts");
    const manager = new SseEventManager(60_000);

    const stream = manager.addIdentityClient("usr_test", new Set(["ws_0076759dbbe19fcc"]));
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

  it("emits only routed events via EventSink interface", async () => {
    const { SseEventManager } = await import("../../src/api/events.ts");
    const manager = new SseEventManager(60_000);

    const stream = manager.addIdentityClient("usr_test", new Set(["ws_0076759dbbe19fcc"]));
    const reader = stream.getReader();
    await readConnected(reader);

    // Emit a run.start event — should NOT be forwarded
    manager.emit(engineEvent("run.start", runStartPayload({ runId: "test" })));

    // Emit a connector.installed event — SHOULD be forwarded
    manager.emit({
      type: "connector.installed",
      data: {
        wsId: "ws_0076759dbbe19fcc",
        serverName: "weather",
        connectorName: "@test/weather",
        version: "1.0.0",
        ui: null,
        placements: null,
      },
    });

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    // Should only contain the connector.installed event
    expect(text).toContain("event: connector.installed");
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
      identityProvider: testAuthAdapter(TEST_KEY),
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir: authDir2,
    });

    await provisionTestWorkspace(authRuntime2, TEST_WORKSPACE_ID, "Test Workspace", [
      TEST_IDENTITY.id,
    ]);

    authHandle2 = startServer({
      runtime: authRuntime2,
      port: 0,
    });
    authUrl2 = `http://localhost:${authHandle2.port}`;
  });

  afterAll(async () => {
    authHandle2.stop(true);
    await authRuntime2.shutdown();
    rmSync(authDir2, { recursive: true, force: true });
  });

  it("POST /v1/workspaces/:wsId/tools/call returns 401 without Bearer token", async () => {
    const res = await fetch(`${authUrl2}/v1/workspaces/${TEST_WORKSPACE_ID}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "test", tool: "tool", arguments: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /v1/events returns 401 without Bearer token", async () => {
    const res = await fetch(`${authUrl2}/v1/events`);
    expect(res.status).toBe(401);
  });
});
