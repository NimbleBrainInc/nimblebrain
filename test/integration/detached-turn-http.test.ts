import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-detached-http-${Date.now()}`);

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

/** Read an SSE response body for a bounded window, returning event types seen. */
async function readSse(res: Response, ms: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const types: string[] = [];
  const deadline = Date.now() + ms;
  let buffer = "";
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.done || !chunk.value) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event: ")) types.push(line.slice(7).trim());
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return types;
}

describe("detached turn HTTP surface", () => {
  it("POST /v1/chat/start returns a conversation id immediately", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: JSON.stringify({ message: "Hello over HTTP", workspaceId: TEST_WORKSPACE_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversationId).toMatch(/^conv_/);
  });

  it("GET /v1/conversations/:id/events replays the turn (incl. the user message)", async () => {
    const startRes = await fetch(`${baseUrl}/v1/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: JSON.stringify({ message: "Replay me", workspaceId: TEST_WORKSPACE_ID }),
    });
    const { conversationId } = await startRes.json();

    // Let the echo turn run + buffer, then connect a fresh viewer — it should
    // replay the whole turn from the RunBus (within the grace window).
    await new Promise((r) => setTimeout(r, 100));

    const evRes = await fetch(`${baseUrl}/v1/conversations/${conversationId}/events`, {
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
    });
    expect(evRes.status).toBe(200);
    const types = await readSse(evRes, 400);
    expect(types).toContain("subscribed");
    expect(types).toContain("user.message");
    expect(types).toContain("chat.start");
  });

  it("POST /v1/conversations/:id/cancel returns ok for the owner", async () => {
    const startRes = await fetch(`${baseUrl}/v1/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: JSON.stringify({ message: "cancel target", workspaceId: TEST_WORKSPACE_ID }),
    });
    const { conversationId } = await startRes.json();
    const res = await fetch(`${baseUrl}/v1/conversations/${conversationId}/cancel`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.cancelled).toBe("boolean");
  });

  it("cancel of a non-existent conversation is 404", async () => {
    const res = await fetch(`${baseUrl}/v1/conversations/conv_0000000000000000/cancel`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
    });
    expect(res.status).toBe(404);
  });
});
