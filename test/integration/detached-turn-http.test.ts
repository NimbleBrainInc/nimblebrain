import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("start on a pre-migration (ownerless) conversation is 422, not 500", async () => {
    // Seed a corrupted conversation: line-1 metadata without ownerId makes the
    // store throw ConversationCorruptedError on load (the resume path).
    const convId = "conv_dead00000000beef"; // conv_ + 16 hex
    const convDir = join(testDir, "conversations");
    mkdirSync(convDir, { recursive: true });
    const meta = JSON.stringify({
      id: convId,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      title: null,
      format: "events",
    });
    writeFileSync(join(convDir, `${convId}.jsonl`), `${meta}\n`);

    const res = await fetch(`${baseUrl}/v1/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: JSON.stringify({
        message: "resume corrupt",
        conversationId: convId,
        workspaceId: TEST_WORKSPACE_ID,
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("conversation_corrupted");
  });

  it("start with a malformed conversationId is 400, not 500 (JSON)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: JSON.stringify({
        message: "traversal attempt",
        conversationId: "../../foo",
        workspaceId: TEST_WORKSPACE_ID,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });

  it("start with a malformed conversationId is 400, not 500 (multipart)", async () => {
    const form = new FormData();
    form.set("message", "traversal attempt");
    form.set("conversationId", "../../foo");
    const res = await fetch(`${baseUrl}/v1/chat/start`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });

  /**
   * Seed a well-formed conversation owned by a *different* user. The HTTP
   * suite runs in dev mode (caller is always `usr_default`), so a mismatched
   * `ownerId` is the way to drive the ownership 403 branch without an identity
   * provider. `findConversation` (no access ctx) returns the row regardless of
   * owner; the route's own ownership check is what must 403.
   */
  function seedOtherUserConversation(convId: string): void {
    const convDir = join(testDir, "conversations");
    mkdirSync(convDir, { recursive: true });
    const meta = JSON.stringify({
      id: convId,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      title: null,
      format: "events",
      ownerId: "usr_someone_else",
    });
    writeFileSync(join(convDir, `${convId}.jsonl`), `${meta}\n`);
  }

  it("GET /v1/conversations/:id/events on another user's conversation is 403", async () => {
    const convId = "conv_0a0a0a0a0a0a0a0a";
    seedOtherUserConversation(convId);
    const res = await fetch(`${baseUrl}/v1/conversations/${convId}/events`, {
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("conversation_access_denied");
  });

  it("POST /v1/conversations/:id/cancel on another user's conversation is 403", async () => {
    const convId = "conv_0b0b0b0b0b0b0b0b";
    seedOtherUserConversation(convId);
    const res = await fetch(`${baseUrl}/v1/conversations/${convId}/cancel`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("conversation_access_denied");
  });

  it("malformed conversationId on the events + cancel routes is 400, not 500", async () => {
    const evRes = await fetch(`${baseUrl}/v1/conversations/bogus/events`, {
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
    });
    expect(evRes.status).toBe(400);
    expect((await evRes.json()).error).toBe("bad_request");

    const cancelRes = await fetch(`${baseUrl}/v1/conversations/not-a-conv-id/cancel`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
    });
    expect(cancelRes.status).toBe(400);
    expect((await cancelRes.json()).error).toBe("bad_request");
  });
});
