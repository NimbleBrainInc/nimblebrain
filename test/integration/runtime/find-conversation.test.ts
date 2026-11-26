/**
 * Integration tests for `Runtime.findConversation` and the conversation routes
 * that read by id. Every read names the workspace it looks in; nothing
 * searches other workspaces.
 *
 * Conversations are workspace-owned:
 * `{workDir}/workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl`.
 *
 * Covers:
 *  - `findConversation(wsId, id, access)` resolves the caller's conversation
 *    in its workspace, and returns null for an unknown id, another owner's
 *    conversation, and the same owner's conversation in another workspace.
 *  - Chat lands under the addressed workspace's owner partition.
 *  - `/v1/workspaces/:wsId/conversations/:id/events` and `/cancel` answer the
 *    caller's own conversation in the path's workspace, and 404
 *    `conversation_not_found` for every other conversation.
 *  - A chat addressed to a malformed, unknown or non-member workspace is
 *    refused with the workspace gate's single 404.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiErrorBody } from "../../../src/api/schemas/responses.ts";
import type { ServerHandle } from "../../../src/api/server.ts";
import { startServer } from "../../../src/api/server.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { ownerConversationsDir } from "../../helpers/conversation-store.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { readJson } from "../../helpers/http.ts";
import { makeIdentity } from "../../helpers/identity.ts";
import { TEST_IDENTITY, testAuthAdapter } from "../../helpers/test-auth-adapter.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../../helpers/test-workspace.ts";

const ALICE = makeIdentity({ id: "usr_alice", email: "alice@example.com" });
const BOB = { id: "usr_bob", email: "bob@example.com" };

describe("Runtime.findConversation", () => {
  const workDir = join(tmpdir(), `nb-find-conv-${Date.now()}`);
  let runtime: Runtime;

  test("setup", async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
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
    const found = await runtime.findConversation(TEST_WORKSPACE_ID, result.conversationId, {
      userId: ALICE.id,
    });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(result.conversationId);
    expect(found!.ownerId).toBe(ALICE.id);
  });

  test("returns null for a non-existent (but valid-format) conversation id", async () => {
    const found = await runtime.findConversation(TEST_WORKSPACE_ID, "conv_0000000000000000", {
      userId: ALICE.id,
    });
    expect(found).toBeNull();
  });

  test("returns null for another owner's conversation", async () => {
    const aliceConv = await runtime.chat({
      message: "alice's private",
      workspaceId: TEST_WORKSPACE_ID,
      identity: ALICE,
    });
    // Bob asks for Alice's conversation with his own access context.
    const foundForBob = await runtime.findConversation(
      TEST_WORKSPACE_ID,
      aliceConv.conversationId,
      { userId: BOB.id },
    );
    expect(foundForBob).toBeNull();
    // Alice's own access still resolves the same id.
    const foundForAlice = await runtime.findConversation(
      TEST_WORKSPACE_ID,
      aliceConv.conversationId,
      { userId: ALICE.id },
    );
    expect(foundForAlice).not.toBeNull();
    expect(foundForAlice!.id).toBe(aliceConv.conversationId);
  });

  test("returns null for the same owner's conversation in another workspace", async () => {
    const other = await runtime.getWorkspaceStore().create("Second workspace");
    await runtime.getWorkspaceStore().addMember(other.id, ALICE.id, "member");
    await runtime.ensureWorkspaceRegistry(other.id);
    const inOther = await runtime.chat({
      message: "alice elsewhere",
      workspaceId: other.id,
      identity: ALICE,
    });
    const access = { userId: ALICE.id };
    expect(await runtime.findConversation(other.id, inOther.conversationId, access)).not.toBeNull();
    expect(
      await runtime.findConversation(TEST_WORKSPACE_ID, inOther.conversationId, access),
    ).toBeNull();
    expect(
      await runtime.resolveConversationStore(TEST_WORKSPACE_ID, inOther.conversationId, ALICE.id),
    ).toBeNull();
  });

  test("chat writes the conversation file under the addressed workspace's owner partition", async () => {
    const result = await runtime.chat({
      message: "where does this land",
      workspaceId: TEST_WORKSPACE_ID,
      identity: ALICE,
    });
    const workspacePath = join(
      ownerConversationsDir(workDir, TEST_WORKSPACE_ID, ALICE.id),
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
// /v1/workspaces/:wsId/conversations/:id/{events,cancel} — the path's workspace
// is the only place the conversation is looked for
// ---------------------------------------------------------------------------

describe("/v1/workspaces/:wsId/conversations/:id — events and cancel", () => {
  const API_KEY = "find-conv-events-key-1234";
  const workDir = join(tmpdir(), `nb-find-conv-events-${Date.now()}`);
  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  /** The caller's conversation in TEST_WORKSPACE_ID. */
  let convId: string;
  /** Another owner's conversation in TEST_WORKSPACE_ID. */
  let aliceConvId: string;
  /** A second workspace the caller belongs to, holding none of the above. */
  let otherWsId: string;
  /** The caller's own conversation in the second workspace. */
  let otherWsConvId: string;

  test("setup", async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      identityProvider: testAuthAdapter(API_KEY),
      languageModel: createEchoModel(),
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, TEST_WORKSPACE_ID, "Test Workspace", [TEST_IDENTITY.id]);
    const other = await runtime.getWorkspaceStore().create("Second workspace");
    otherWsId = other.id;
    await runtime.getWorkspaceStore().addMember(otherWsId, TEST_IDENTITY.id, "member");
    await runtime.ensureWorkspaceRegistry(otherWsId);
    handle = startServer({
      runtime,
      port: 0,
    });
    baseUrl = `http://localhost:${handle.port}`;

    // Seed one conversation owned by the test user — the identity the auth
    // adapter returns.
    convId = (
      await runtime.chat({
        message: "seed",
        workspaceId: TEST_WORKSPACE_ID,
        identity: TEST_IDENTITY,
      })
    ).conversationId;
    aliceConvId = (
      await runtime.chat({
        message: "alice's private",
        workspaceId: TEST_WORKSPACE_ID,
        identity: ALICE,
      })
    ).conversationId;
    otherWsConvId = (
      await runtime.chat({ message: "elsewhere", workspaceId: otherWsId, identity: TEST_IDENTITY })
    ).conversationId;
  });

  function events(wsId: string, id: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/workspaces/${wsId}/conversations/${id}/events`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  }

  function cancel(wsId: string, id: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/workspaces/${wsId}/conversations/${id}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  }

  async function expectNotFound(res: Response, id: string): Promise<void> {
    expect(res.status).toBe(404);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("conversation_not_found");
    expect(body.details?.conversationId).toBe(id);
  }

  test("events streams the caller's own conversation in its workspace", async () => {
    const res = await events(TEST_WORKSPACE_ID, convId);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    await res.body?.cancel();
  });

  test("cancel answers the caller's own conversation in its workspace", async () => {
    const res = await cancel(TEST_WORKSPACE_ID, convId);
    expect(res.status).toBe(200);
  });

  test("a non-existent conversation is 404 conversation_not_found", async () => {
    await expectNotFound(
      await events(TEST_WORKSPACE_ID, "conv_0000000000000000"),
      "conv_0000000000000000",
    );
    await expectNotFound(
      await cancel(TEST_WORKSPACE_ID, "conv_0000000000000000"),
      "conv_0000000000000000",
    );
  });

  test("another owner's conversation is 404, the same answer as a missing one", async () => {
    await expectNotFound(await events(TEST_WORKSPACE_ID, aliceConvId), aliceConvId);
    await expectNotFound(await cancel(TEST_WORKSPACE_ID, aliceConvId), aliceConvId);
  });

  test("the caller's own conversation in another workspace is 404 from this one", async () => {
    await expectNotFound(await events(TEST_WORKSPACE_ID, otherWsConvId), otherWsConvId);
    await expectNotFound(await cancel(TEST_WORKSPACE_ID, otherWsConvId), otherWsConvId);
    await expectNotFound(await events(otherWsId, convId), convId);
    await expectNotFound(await cancel(otherWsId, convId), convId);

    // In its own workspace it answers.
    const own = await events(otherWsId, otherWsConvId);
    expect(own.status).toBe(200);
    await own.body?.cancel();
  });

  test("a workspace the caller is not a member of is the workspace gate's 404", async () => {
    const foreign = await runtime.getWorkspaceStore().create("Not mine");
    const res = await events(foreign.id, convId);
    expect(res.status).toBe(404);
    expect((await readJson<ApiErrorBody>(res)).error).toBe("workspace_error");
  });

  /** POST a chat addressed to `wsId`, as the authenticated test user. */
  function chatIn(wsId: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/workspaces/${wsId}/chat/start`, {
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
    const otherWs = await wsStore.create("Other workspace");
    const nonMember = await chatIn(otherWs.id);
    const unknown = await chatIn("ws_002cbcedbb32d4b3");
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
// /v1/workspaces/:wsId/conversations/:id/events — the dev identity provider
//
// `bun run dev:worktree` runs the dev provider. The web client opens this SSE
// the moment it loads a conversation, so the dev user's own conversation must
// stream (200), not 500.
// ---------------------------------------------------------------------------

describe("/v1/workspaces/:wsId/conversations/:id/events — dev provider", () => {
  const workDir = join(tmpdir(), `nb-find-conv-events-dev-${Date.now()}`);
  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  let convId: string;

  test("setup", async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
    // The dev provider verifies every request as `usr_default`.
    handle = startServer({ runtime, port: 0 });
    baseUrl = `http://localhost:${handle.port}`;

    // Seed a conversation as the dev user, the identity the dev provider
    // gives the route's request.
    const seed = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "seed in dev mode",
      workspaceId: TEST_WORKSPACE_ID,
    });
    convId = seed.conversationId;
  });

  test("dev mode: SSE for the dev user's own conversation returns 200 (not 500)", async () => {
    const res = await fetch(
      `${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/conversations/${convId}/events`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    await res.body?.cancel();
  });

  test("dev mode: 404 for a non-existent conversation", async () => {
    const res = await fetch(
      `${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/conversations/conv_0000000000000000/events`,
    );
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
// A file lacking `ownerId` is pre-migration state. Both routes find the file by
// PATH in the caller's partition of the path's workspace, and `store.load` is
// the one place validity is checked — it throws the typed
// `ConversationCorruptedError`. So both the read route
// (`/v1/workspaces/:wsId/conversations/:id/events`) and the chat resume path
// (`/v1/workspaces/:wsId/chat/start`) surface a clean 422, never a 500.
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
      identityProvider: testAuthAdapter(API_KEY),
      languageModel: createEchoModel(),
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, TEST_WORKSPACE_ID, "Test Workspace", [TEST_IDENTITY.id]);
    handle = startServer({
      runtime,
      port: 0,
    });
    baseUrl = `http://localhost:${handle.port}`;

    // Plant an ownerless file where the conversations plugin keeps the caller's
    // conversations in TEST_WORKSPACE_ID: it answers `conversation_corrupted`.
    const convDir = ownerConversationsDir(workDir, TEST_WORKSPACE_ID, TEST_IDENTITY.id);
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

  test("GET /v1/workspaces/:wsId/conversations/:id/events on an ownerless file returns 422 (not 500)", async () => {
    // `findConversation` asks the plugin, which cannot read the file; the
    // store throws `ConversationCorruptedError`, which the route maps to a 422
    // — operator-actionable, not a bare 404.
    const res = await fetch(
      `${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/conversations/${convId}/events`,
      {
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
    );
    expect(res.status).toBe(422);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("conversation_corrupted");
  });

  test("POST /v1/workspaces/:wsId/chat/start resuming an ownerless conversation returns 422 (not 500)", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/chat/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ message: "resume", conversationId: convId }),
    });
    expect(res.status).toBe(422);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("conversation_corrupted");
    expect(body.details?.conversationId).toBe(convId);
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
