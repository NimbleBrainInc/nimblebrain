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
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

// Stage 2 (T006): chat is identity-bound. Files uploaded via /v1/chat/*
// land in the identity's personal workspace, not the `X-Workspace-Id`
// header. The test exercises the same identity (DEV_IDENTITY in dev
// mode) for both upload + read so the file store paths line up.
const PERSONAL_WS_ID = personalWorkspaceIdFor(DEV_IDENTITY.id);

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
  // Provision the dev user's personal workspace + registry so the
  // file-store paths used by chat-multipart ingest exist before the
  // first request hits `/v1/chat/stream`.
  await ensureUserWorkspace(runtime.getWorkspaceStore(), {
    id: DEV_IDENTITY.id,
    displayName: DEV_IDENTITY.displayName,
  });
  await runtime.ensureWorkspaceRegistry(PERSONAL_WS_ID);
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
    headers: { "X-Workspace-Id": PERSONAL_WS_ID },
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
    headers: { "Content-Type": "application/json", "X-Workspace-Id": PERSONAL_WS_ID },
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
    const payload = "round trip";
    await uploadChatFile(payload, "roundtrip.bin", "application/octet-stream");
    const files = await listFiles();
    const id = files.find((f) => f.filename === "roundtrip.bin")?.id;
    expect(id).toBeDefined();

    const read = await callFilesTool("read", { id });
    expect(read.status).toBe(200);

    // Lean contract: tool result is a resource_link + a human-readable text
    // block. The bytes are NOT returned inline (see commit "files__read
    // returns resource_link + extracted text, never base64"). The file
    // remains addressable via the resource_link URI and via GET /v1/files/:id
    // (covered by the next test) — that's what "readable" means now.
    const body = read.body as {
      content?: Array<{ type: string; uri?: string; mimeType?: string; text?: string }>;
      structuredContent?: { id: string; filename: string; mimeType: string; size: number };
    };

    const link = body.content?.find((c) => c.type === "resource_link");
    expect(link?.uri).toBe(`files://${id}`);
    expect(link?.mimeType).toBe("application/octet-stream");

    expect(body.structuredContent?.filename).toBe("roundtrip.bin");
    expect(body.structuredContent?.size).toBe(payload.length);

    // Regression guard for the base64 leak.
    const serialized = JSON.stringify(read.body);
    expect(serialized).not.toContain("base64Data");
    expect(serialized).not.toContain(Buffer.from(payload).toString("base64"));
  });

  it("file uploaded via /v1/chat/stream is served by GET /v1/files/:id", async () => {
    await uploadChatFile("served bytes", "served.bin", "application/octet-stream");
    const files = await listFiles();
    const id = files.find((f) => f.filename === "served.bin")?.id;
    expect(id).toBeDefined();

    const res = await fetch(`${baseUrl}/v1/files/${id}`, {
      headers: { "X-Workspace-Id": PERSONAL_WS_ID },
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
        headers: { "X-Workspace-Id": PERSONAL_WS_ID },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    }

    // Negative control: malformed id gets rejected at the regex, 400.
    const bad = await fetch(`${baseUrl}/v1/files/not-a-valid-id`, {
      headers: { "X-Workspace-Id": PERSONAL_WS_ID },
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: string };
    expect(badBody.error).toBe("bad_request");
  });

  it("agent-created files and chat-uploaded files coexist in the same registry", async () => {
    const agentCreate = await callFilesTool("create", {
      manifest: { filename: "from-agent.bin", mimeType: "application/octet-stream" },
      body: Buffer.from("agent bytes").toString("base64"),
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
