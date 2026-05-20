/**
 * Integration tests for `Runtime.findConversation` /
 * `findConversationStore` — the post-Stage-1 (Task 005) accessors that
 * collapsed the workspace-scoped conversation surface onto a single
 * top-level store.
 *
 * Covers:
 *  - `findConversation(id)` resolves a conversation that exists at top-level.
 *  - `findConversation(id)` returns null when the conversation doesn't exist.
 *  - `findConversation(id, access)` returns null for foreign owner
 *    (same shape as not-found — no existence leak).
 *  - Chat lands at `{workDir}/conversations/`, not any workspace path.
 *  - `/v1/conversations/:id/events` works without `X-Workspace-Id`
 *    (Task 005 made the workspace header optional on this route).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ServerHandle } from "../../../src/api/server.ts";
import { startServer } from "../../../src/api/server.ts";
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
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
    expect(runtime).toBeDefined();
  });

  test("resolves an existing conversation from the top-level store", async () => {
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

  test("chat writes the conversation file at {workDir}/conversations/{convId}.jsonl", async () => {
    const result = await runtime.chat({
      message: "where does this land",
      workspaceId: TEST_WORKSPACE_ID,
      identity: ALICE,
    });
    const topLevelPath = join(workDir, "conversations", `${result.conversationId}.jsonl`);
    const s = await stat(topLevelPath);
    expect(s.isFile()).toBe(true);
  });

  test("teardown", async () => {
    await runtime?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// /v1/conversations/:id/events — no X-Workspace-Id needed post-Task-005
// ---------------------------------------------------------------------------

describe("/v1/conversations/:id/events — workspace-optional", () => {
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
      noDefaultBundles: true,
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
  // `conversation-access.test.ts` (which uses /v1/chat/stream where the
  // server emits chunks promptly) together prove the route handles the
  // workspace-optional case.

  test("returns 404 for a non-existent conversation (no workspace header still ok)", async () => {
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

  test("X-Workspace-Id is honored when sent (valid workspace + member)", async () => {
    // The chat UI sends `X-Workspace-Id` on every call; the events
    // route accepts it without requiring it. Validation must still
    // happen — see the malformed / non-member tests below.
    const res = await fetch(`${baseUrl}/v1/conversations/${convId}/events`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "X-Workspace-Id": TEST_WORKSPACE_ID,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    await res.body?.cancel();
  });

  test("returns 400 when X-Workspace-Id is malformed", async () => {
    const res = await fetch(`${baseUrl}/v1/conversations/${convId}/events`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "X-Workspace-Id": "not a valid ws id!!",
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("workspace_error");
  });

  test("returns 403 when X-Workspace-Id names a workspace the caller is not a member of", async () => {
    // Create a second workspace that the test user isn't a member of.
    // The middleware should refuse with 403 rather than silently
    // ignoring the header — silent acceptance would let a malicious
    // client probe workspace ids by membership.
    const wsStore = runtime.getWorkspaceStore();
    const otherWs = await wsStore.create("Other workspace", "ws_other_test");
    const res = await fetch(`${baseUrl}/v1/conversations/${convId}/events`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "X-Workspace-Id": otherWs.id,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("workspace_error");
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
      noDefaultBundles: true,
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
// Ownerless conversation file → 422 conversation_corrupted (not 500).
//
// Regression for round-7 QA #2: a pre-migration file lacking `ownerId`
// caused the store to throw a generic Error that bubbled to handleChat
// as 500. The typed `ConversationCorruptedError` maps to 422 with the
// migration command in the message.
// ---------------------------------------------------------------------------

describe("ownerless conversation file → 422 conversation_corrupted", () => {
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
      noDefaultBundles: true,
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

    // Plant an ownerless file at the top-level conversations dir to
    // simulate a tenant that ran migrate:personal-workspaces but
    // never ran migrate:conversations-to-top-level. (In practice
    // ownerless files would live under workspaces/.../conversations/
    // pre-migration, but the second migration is what stamps
    // ownerId; a file at top-level with no ownerId is the
    // operator-forgot-step-2 state.)
    mkdirSync(join(workDir, "conversations"), { recursive: true });
    const meta = {
      id: convId,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      title: null,
      lastModel: null,
      format: "events",
      // intentionally no ownerId
    };
    await Bun.write(
      join(workDir, "conversations", `${convId}.jsonl`),
      `${JSON.stringify(meta)}\n`,
    );
  });

  test("GET /v1/conversations/:id/events on an ownerless file returns 422 (not 500)", async () => {
    const res = await fetch(`${baseUrl}/v1/conversations/${convId}/events`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("conversation_corrupted");
    expect(body.message).toMatch(/migrate:conversations-to-top-level/);
    expect(body.details?.conversationId).toBe(convId);
    expect(body.details?.reason).toBe("missing_owner");
  });

  test("POST /v1/chat resuming an ownerless conversation returns 422 (not 500)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "X-Workspace-Id": TEST_WORKSPACE_ID,
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
