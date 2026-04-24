/**
 * End-to-end regression test for the bug where chat-multipart uploads were
 * written to a tenant-global `/data/files/` directory and therefore invisible
 * to the workspace-scoped `files__*` tools. This test asserts that a file
 * uploaded via multipart chat is found by files__list, readable via
 * files__read, and served by GET /v1/files/:id in the same workspace.
 */

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
const testDir = join(tmpdir(), `nimblebrain-chat-file-visibility-${Date.now()}`);

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

async function uploadChatFile(content: string, filename: string, mimeType: string): Promise<void> {
  const form = new FormData();
  form.append("message", "please look at this");
  form.append("workspaceId", TEST_WORKSPACE_ID);
  const bytes = new Uint8Array(Buffer.from(content));
  const file = new File([bytes], filename, { type: mimeType });
  form.append("files", file);

  const res = await fetch(`${baseUrl}/v1/chat/stream`, {
    method: "POST",
    headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
    body: form,
  });
  if (res.status !== 200) {
    const errBody = await res.text();
    throw new Error(`chat/stream returned ${res.status}: ${errBody}`);
  }
  // Drain the SSE body so the server finishes writing before we read state.
  await res.text();
}

async function callFilesTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/v1/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
    body: JSON.stringify({ server: "files", tool, arguments: args }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

/** Pull the JSON object out of an MCP-style tool-call response. */
function extractStructured(body: unknown): unknown {
  const result = body as { content?: { type: string; text?: string }[] };
  const first = result.content?.[0];
  if (!first || first.type !== "text" || !first.text) {
    throw new Error(`unexpected tool-call body: ${JSON.stringify(body)}`);
  }
  return JSON.parse(first.text);
}

async function listFiles(): Promise<
  { id: string; filename: string; source: string; mimeType: string; conversationId: string | null }[]
> {
  const res = await callFilesTool("list", { limit: 100 });
  expect(res.status).toBe(200);
  const structured = extractStructured(res.body) as {
    files: {
      id: string;
      filename: string;
      source: string;
      mimeType: string;
      conversationId: string | null;
    }[];
  };
  return structured.files;
}

describe("chat multipart upload ↔ files__* visibility (bug 4)", () => {
  it("file uploaded via /v1/chat/stream is listed by files__list with source=chat", async () => {
    await uploadChatFile("hello world", "notes-1.bin", "application/octet-stream");

    const files = await listFiles();
    const match = files.find((f) => f.filename === "notes-1.bin");
    expect(match).toBeDefined();
    expect(match?.id).toMatch(/^fl_[a-f0-9]{24}$/);
    expect(match?.source).toBe("chat");
    expect(match?.mimeType).toBe("application/octet-stream");
    // NOTE: chat uploads to a new conversation currently record
    // conversationId="pending" — the real id is assigned later by the
    // runtime. Fixing requires extending ConversationStore.create to
    // accept a pre-generated id. Tracked as a follow-up; not part of
    // bug 4's scope (store unification, not conversation threading).
  });

  it("file uploaded via /v1/chat/stream is readable by files__read", async () => {
    await uploadChatFile("round trip", "roundtrip.bin", "application/octet-stream");
    const files = await listFiles();
    const id = files.find((f) => f.filename === "roundtrip.bin")?.id;
    expect(id).toBeDefined();

    const read = await callFilesTool("read", { id });
    expect(read.status).toBe(200);
    const structured = extractStructured(read.body) as {
      base64Data: string;
      filename: string;
      mimeType: string;
    };
    expect(Buffer.from(structured.base64Data, "base64").toString("utf-8")).toBe("round trip");
    expect(structured.filename).toBe("roundtrip.bin");
  });

  it("file uploaded via /v1/chat/stream is served by GET /v1/files/:id", async () => {
    await uploadChatFile("served bytes", "served.bin", "application/octet-stream");
    const files = await listFiles();
    const id = files.find((f) => f.filename === "served.bin")?.id;
    expect(id).toBeDefined();

    const res = await fetch(`${baseUrl}/v1/files/${id}`, {
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("served bytes");
  });

  it("GET /v1/files accepts both new and legacy id shapes at the validator", async () => {
    // New scheme: fl_<24 hex>. Request a nonexistent id and assert we get
    // 404 (passed the regex, failed the lookup) rather than 400 (invalid
    // format). Same for the legacy scheme. This pins the compatibility
    // guarantee against a future "simplify the regex" PR that might silently
    // break historical file links baked into conversation JSONL.
    const newShape = "fl_aaaaaaaaaaaaaaaaaaaaaaaa"; // 24 hex chars
    const legacyShape = "fl_mo7gybgy_5ad5f8a8"; // base36 + 8 hex, from the anchor bug report
    for (const id of [newShape, legacyShape]) {
      const res = await fetch(`${baseUrl}/v1/files/${id}`, {
        headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    }

    // Negative control: malformed id gets rejected at the regex, 400.
    const bad = await fetch(`${baseUrl}/v1/files/not-a-valid-id`, {
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: string };
    expect(badBody.error).toBe("bad_request");
  });

  it("agent-created files and chat-uploaded files coexist in the same registry", async () => {
    const agentCreate = await callFilesTool("create", {
      filename: "from-agent.bin",
      base64_data: Buffer.from("agent bytes").toString("base64"),
      mime_type: "application/octet-stream",
    });
    expect(agentCreate.status).toBe(200);
    const agentId = (extractStructured(agentCreate.body) as { id: string }).id;

    await uploadChatFile("chat bytes", "from-chat.bin", "application/octet-stream");

    const files = await listFiles();
    const agent = files.find((f) => f.id === agentId);
    const chat = files.find((f) => f.filename === "from-chat.bin");
    expect(agent?.source).toBe("agent");
    expect(chat?.source).toBe("chat");
  });
});
