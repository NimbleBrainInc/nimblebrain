/**
 * Integration tests for `Runtime.findConversation` — the cross-workspace
 * accessor that resolves a conversation by id through the locator.
 *
 * Conversations are workspace-owned:
 * `{workDir}/workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl`.
 *
 * Covers:
 *  - `findConversation(id)` resolves a conversation that exists in its workspace.
 *  - `findConversation(id)` returns null when the conversation doesn't exist.
 *  - `findConversation(id, access)` returns null for foreign owner
 *    (same shape as not-found — no existence leak).
 *  - Chat lands under the addressed workspace's owner partition.
 *  - `/v1/conversations/:id/events` is identity-scoped: it takes no workspace.
 *  - A chat addressed to a malformed, unknown or non-member workspace is
 *    refused with the workspace gate's single 404.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ServerHandle } from "../../../src/api/server.ts";
import { startServer } from "../../../src/api/server.ts";
import { workspaceConversationsDir } from "../../../src/conversation/paths.ts";
import { createTestAuthAdapter, TEST_IDENTITY } from "../../helpers/test-auth-adapter.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const ALICE = { id: "usr_alice", email: "alice@example.com" };
const BOB = { id: "usr_bob", email: "bob@example.com" };

describe("Runtime.findConversation", () => {
  const workDir = join(tmpdir(), `nb-find-conv-${Date.now()}`);
  let runtime: Runtime;

  test("setup", async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
    expect(runtime).toBeDefined();
  });

  test("resolves an existing conversation from its workspace store", async () => {
    const result = await runtime.chat({
      message: "alice's note",
      workspaceId: TEST_WORKSPACE_ID,
      identity: ALICE,
    });
    const found = await runtime.findConversation(result.conversationId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(result.conversationId);
    expect(found!.ownerId).toBe(ALICE.id);
  });

  test("returns null for a non-existent (but valid-format) conversation id", async () => {
    const found = await runtime.findConversation("conv_0000000000000000");
    expect(found).toBeNull();
  });

  test("returns null for a foreign-owner conversation when access is supplied", async () => {
    const aliceConv = await runtime.chat({
      message: "alice's private",
      workspaceId: TEST_WORKSPACE_ID,
      identity: ALICE,
    });
    // Bob asks for Alice's conversation with his own access context.
    const foundForBob = await runtime.findConversation(aliceConv.conversationId, {
      userId: BOB.id,
    });
    expect(foundForBob).toBeNull();
    // Alice's own access still resolves the same id.
    const foundForAlice = await runtime.findConversation(aliceConv.conversationId, {
      userId: ALICE.id,
    });
    expect(foundForAlice).not.toBeNull();
    expect(foundForAlice!.id).toBe(aliceConv.conversationId);
  });

  test("chat writes the conversation file under the addressed workspace's owner partition", async () => {
    const result = await runtime.chat({
      message: "where does this land",
      workspaceId: TEST_WORKSPACE_ID,
      identity: ALICE,
    });
    const workspacePath = join(
      workspaceConversationsDir(workDir, TEST_WORKSPACE_ID, ALICE.id),
      `${result.conversationId}.jsonl`,
    );
    const s = await stat(workspacePath);
    expect(s.isFile()).toBe(true);
  });

  test("teardown", async () => {
    await runtime?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// /v1/conversations/:id/events — identity-scoped, no workspace in the request
// ---------------------------------------------------------------------------

describe("/v1/conversations/:id/events — identity-scoped", () => {
  const API_KEY = "find-conv-events-key-1234";
  const workDir = join(tmpdir(), `nb-find-conv-events-${Date.now()}`);
  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  let convId: string;

  test("setup", async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
    handle = startServer({
      runtime,
      port: 0,
      provider: createTestAuthAdapter(API_KEY, runtime),
    });
    baseUrl = `http://localhost:${handle.port}`;

    // Seed one conversation owned by the test user — must match the
    // identity the auth adapter will return, otherwise the events
    // route correctly refuses with 404 (ownership mismatch).
    const seed = await runtime.chat({
      message: "seed",
      workspaceId: TEST_WORKSPACE_ID,
      identity: TEST_IDENTITY,
    });
    convId = seed.conversationId;
    expect(convId).toBeDefined();
  });

  // NOTE: a "happy-path" 200 SSE test would need to hold the connection
  // open and then cancel it, but Bun's fetch doesn't resolve until the
  // first chunk arrives on an SSE stream that the server keeps idle —
  // and forcing a chunk would couple this test to broadcast plumbing.
  // The 404 test below + the 200/SSE coverage in
  // `conversation-access.test.ts` (which uses /v1/workspaces/:wsId/chat/stream
  // where the server emits chunks promptly) together prove the route resolves
  // the conversation without a workspace in the request.

  test("returns 404 for a non-existent conversation", async () => {
    const res = await fetch(`${baseUrl}/v1/conversations/conv_0000000000000000/events`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  test("returns 403 conversation_access_denied when the conversation exists but isn't the caller's", async () => {
    // Seed a conversation owned by SOMEONE ELSE (not the test user
    // the auth adapter returns). The events route should refuse with
    // 403 — distinct from 404 so the caller can tell "exists but not
    // yours" from "doesn't exist". Leaking that distinction is fine
    // when the caller has authenticated and supplied a specific id;
    // content does not leak.
    const seed = await runtime.chat({
      message: "alice's private",
      workspaceId: TEST_WORKSPACE_ID,
      identity: { id: "usr_alice", email: "alice@example.com" },
    });
    const res = await fetch(`${baseUrl}/v1/conversations/${seed.conversationId}/events`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("conversation_access_denied");
    expect(body.details?.conversationId).toBe(seed.conversationId);
  });

  test("streams the caller's own conversation with no workspace in the request", async () => {
    const res = await fetch(`${baseUrl}/v1/conversations/${convId}/events`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    await res.body?.cancel();
  });

  /** POST a chat addressed to `wsId`, as the authenticated test user. */
  function chatIn(wsId: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/workspaces/${wsId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ message: "hello" }),
    });
  }

  test("a chat addressed to a malformed workspace id is refused with 404 workspace_error", async () => {
    const res = await chatIn("not_a_ws_id");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "workspace_error", message: "Workspace not found" });
  });

  test("a chat addressed to a workspace the caller is not a member of is refused like an unknown one", async () => {
    // The gate answers a non-member exactly as it answers an unknown
    // workspace, so a client cannot probe workspace ids by membership.
    const wsStore = runtime.getWorkspaceStore();
    const otherWs = await wsStore.create("Other workspace", "ws_other_test");
    const nonMember = await chatIn(otherWs.id);
    const unknown = await chatIn("ws_does_not_exist");
    expect(nonMember.status).toBe(404);
    expect(unknown.status).toBe(404);
    const expected = { error: "workspace_error", message: "Workspace not found" };
    expect(await nonMember.json()).toEqual(expected);
    expect(await unknown.json()).toEqual(expected);
  });

  test("teardown", async () => {
    handle?.stop(true);
    await runtime?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// /v1/conversations/:id/events — dev mode (no identity provider configured)
//
// Regression for round-6 QA C1: the route's handler read `identity.id`
// unconditionally; in dev mode `c.var.identity` is undefined and the
// handler threw `TypeError: Cannot read properties of undefined`.
// `bun run dev:worktree` (or any auth-disabled deployment) would 500
// the moment the web client opened the SSE.
// ---------------------------------------------------------------------------

describe("/v1/conversations/:id/events — dev mode (no provider)", () => {
  const workDir = join(tmpdir(), `nb-find-conv-events-dev-${Date.now()}`);
  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  let convId: string;

  test("setup", async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
    // No `provider` → dev mode. The auth middleware passes through
    // without setting c.var.identity.
    handle = startServer({ runtime, port: 0 });
    baseUrl = `http://localhost:${handle.port}`;

    // Seed a conversation via runtime.chat without an identity. The
    // runtime's dev-mode fallback mints the conversation under
    // `usr_default`, which is what `DEV_IDENTITY.id` resolves to and
    // what the route's dev fallback compares against.
    const seed = await runtime.chat({
      message: "seed in dev mode",
      workspaceId: TEST_WORKSPACE_ID,
    });
    convId = seed.conversationId;
  });

  test("dev mode: SSE for the dev user's own conversation returns 200 (not 500)", async () => {
    const res = await fetch(`${baseUrl}/v1/conversations/${convId}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    await res.body?.cancel();
  });

  test("dev mode: 404 for a non-existent conversation", async () => {
    const res = await fetch(`${baseUrl}/v1/conversations/conv_0000000000000000/events`);
    expect(res.status).toBe(404);
  });

  test("teardown", async () => {
    handle?.stop(true);
    await runtime?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Ownerless (pre-migration) conversation file — no 500s.
//
// A file lacking `ownerId` is pre-migration state. The locator resolves by
// PATH (it never reads file contents), so an ownerless file resolves to its
// workspace on both routes, and `store.load` is the one place ownership/validity is
// checked — it throws the typed `ConversationCorruptedError`. So both the read
// route (`/v1/conversations/:id/events`) and the chat resume path
// (`/v1/workspaces/:wsId/chat`)
// surface a clean 422 with the migration command, never a 500.
//
// The ownerless file is planted at the exact workspace path the resume resolves
// (TEST_WORKSPACE_ID + the authenticated caller's owner partition).
// ---------------------------------------------------------------------------

describe("ownerless conversation file — no 500s", () => {
  const API_KEY = "find-conv-corrupted-key-1234";
  const workDir = join(tmpdir(), `nb-find-conv-corrupted-${Date.now()}`);
  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  const convId = "conv_ddeeaaddbbeeeeff";

  test("setup", async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
    handle = startServer({
      runtime,
      port: 0,
      provider: createTestAuthAdapter(API_KEY, runtime),
    });
    baseUrl = `http://localhost:${handle.port}`;

    // Plant an ownerless file at the workspace path the resume path reads:
    // `workspaces/<TEST_WORKSPACE_ID>/conversations/<callerId>/<convId>.jsonl`.
    // The locator skips it (no ownerId), so the read route 404s; the resume
    // path reads it directly via the workspace store and 422s.
    const convDir = workspaceConversationsDir(workDir, TEST_WORKSPACE_ID, TEST_IDENTITY.id);
    mkdirSync(convDir, { recursive: true });
    const meta = {
      id: convId,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      title: null,
      lastModel: null,
      format: "events",
      // intentionally no ownerId
    };
    await Bun.write(join(convDir, `${convId}.jsonl`), `${JSON.stringify(meta)}\n`);
  });

  test("GET /v1/conversations/:id/events on an ownerless file returns 422 (not 500)", async () => {
    // `locate` resolves the file by path; `findConversation` then loads it and
    // the store throws `ConversationCorruptedError`, which the route maps to a
    // 422 carrying the migration command — operator-actionable, not a bare 404.
    const res = await fetch(`${baseUrl}/v1/conversations/${convId}/events`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("conversation_corrupted");
  });

  test("POST /v1/workspaces/:wsId/chat resuming an ownerless conversation returns 422 (not 500)", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ message: "resume", conversationId: convId }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("conversation_corrupted");
    expect(body.details?.reason).toBe("missing_owner");
  });

  test("teardown", async () => {
    handle?.stop(true);
    await runtime?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });
});

afterAll(() => {
  // belt-and-suspenders cleanup if a test died early
});
