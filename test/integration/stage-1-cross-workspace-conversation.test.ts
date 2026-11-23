import type { ApiErrorBody, ChatResponse } from "../../src/api/schemas/responses.ts";
import { postChatTurn } from "../helpers/chat-turn.ts";
import { readJson } from "../helpers/http.ts";
/**
 * E2E — a conversation is reached only through the workspace it lives in.
 *
 * A conversation lives inside the workspace it was created in
 * (`workspaces/<wsId>/conversations/<ownerId>/...`) and is sealed to it. No
 * read or write crosses a workspace:
 *   - From another workspace the same owner belongs to, the conversation is
 *     not found: the event stream, Stop and a chat resume all answer
 *     `404 conversation_not_found`, and `findConversation` returns null.
 *   - Once the owner is removed from the conversation's workspace, its HTTP
 *     routes answer the workspace gate's 404, and a resume from another
 *     workspace is still `conversation_not_found`.
 *   - The runtime read `findConversation(wsId, …)` stays owner-gated within
 *     its workspace: it does not consult membership.
 *
 * Secondary assertion: `canAccess` is a pure ownership check and does not
 * consult workspace membership.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { canAccess } from "../../src/conversation/index-cache.ts";
import { workspaceConversationsDir } from "../../src/conversation/paths.ts";
import type {
  CreateUserInput,
  CreateUserResult,
  IdentityProvider,
  ProviderCapabilities,
  UserIdentity,
  VerifiedIdentity,
} from "../../src/identity/provider.ts";
import { FIRST_PARTY_GRANT } from "../../src/identity/provider.ts";
import type { User } from "../../src/identity/user.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { makeIdentity } from "../helpers/identity.ts";

// ---------------------------------------------------------------------------
// Minimal multi-user auth adapter — same shape as conversation-access.test.ts,
// inlined to keep this E2E self-contained.
// ---------------------------------------------------------------------------

const ALICE: UserIdentity = makeIdentity({
  id: "usr_alice",
  email: "alice@example.com",
  displayName: "Alice",
  orgRole: "member",
});

class TokenAuthAdapter implements IdentityProvider {
  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: false,
    tokenRefresh: false,
    managedUsers: false,
    authorizationServer: false,
  };

  constructor(private readonly tokens: Record<string, UserIdentity>) {}

  async verifyRequest(req: Request): Promise<VerifiedIdentity | null> {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;
    const who = this.tokens[authHeader.slice(7)];
    return who ? { ...who, grant: FIRST_PARTY_GRANT } : null;
  }

  async listUsers(): Promise<User[]> {
    return [];
  }

  async createUser(_data: CreateUserInput): Promise<CreateUserResult> {
    throw new Error("createUser not supported in test adapter");
  }

  async deleteUser(): Promise<boolean> {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("conversation access after the owner is removed from its workspace", () => {
  const ALICE_TOKEN = "alice-e2e-token-1234567890";
  const workDir = join(tmpdir(), `nb-stage1-e2e-${Date.now()}`);
  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  let sharedA: string;
  let sharedB: string;

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      identityProvider: () => new TokenAuthAdapter({ [ALICE_TOKEN]: ALICE }),
      languageModel: createEchoModel(),
      logging: { disabled: true },
      workDir,
    });

    // Seed Alice's profile with the canonical id the auth adapter returns.
    // `UserStore.create` would assign a fresh id; we write the profile
    // directly so `usr_alice` is the stable id used throughout.
    const userDir = join(workDir, "users", ALICE.id);
    mkdirSync(userDir, { recursive: true });
    const now = new Date().toISOString();
    await Bun.write(
      join(userDir, "profile.json"),
      `${JSON.stringify({ ...ALICE, preferences: {}, createdAt: now, updatedAt: now }, null, 2)}\n`,
    );

    // Two shared workspaces; Alice is admin of both.
    const wsStore = runtime.getWorkspaceStore();
    const a = await wsStore.create("Shared A");
    const b = await wsStore.create("Shared B");
    sharedA = a.id;
    sharedB = b.id;
    await wsStore.addMember(sharedA, ALICE.id, "admin");
    await wsStore.addMember(sharedB, ALICE.id, "admin");
    await runtime.ensureWorkspaceRegistry(sharedA);
    await runtime.ensureWorkspaceRegistry(sharedB);

    handle = startServer({
      runtime,
      port: 0,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    handle?.stop(true);
    await runtime?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  test("an owned conversation in A is not found from B, before and after Alice leaves A", async () => {
    // 1. Alice POSTs a chat in shared_a — produces a conversation born in the
    //    workspace the request is addressed to (sharedA, from the path), stored
    //    under `workspaces/<sharedA>/conversations/<ownerId>/` and sealed to it.
    const createRes = await postChatTurn(baseUrl, sharedA, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALICE_TOKEN}`,
      },
      body: JSON.stringify({ message: "hello from workspace A" }),
    });
    expect(createRes.status).toBe(200);
    const createBody = await readJson<ChatResponse>(createRes);
    const convId = createBody.conversationId;
    expect(convId).toMatch(/^conv_[a-f0-9]{16}$/);

    // The conversation is workspace-owned: its file lives under the workspace it
    // ran in (`workspaces/<sharedA>/conversations/<ownerId>/`) — the workspace owns
    // the directory — and NOT in a flat top-level `conversations/` dir. The
    // owner partition is what makes it survive removal: dropping Alice from
    // sharedA's member list doesn't touch her conversation file.
    const workspacePath = join(
      workspaceConversationsDir(workDir, sharedA, ALICE.id),
      `${convId}.jsonl`,
    );
    const flatPath = join(workDir, "conversations", `${convId}.jsonl`);
    expect((await stat(workspacePath)).isFile()).toBe(true);
    let flatExists = true;
    try {
      await stat(flatPath);
    } catch {
      flatExists = false;
    }
    expect(flatExists).toBe(false);

    const auth = { Authorization: `Bearer ${ALICE_TOKEN}` };
    const eventsIn = (wsId: string) =>
      fetch(`${baseUrl}/v1/workspaces/${wsId}/conversations/${convId}/events`, { headers: auth });
    const cancelIn = (wsId: string) =>
      fetch(`${baseUrl}/v1/workspaces/${wsId}/conversations/${convId}/cancel`, {
        method: "POST",
        headers: auth,
      });
    const expectError = async (res: Response, error: string) => {
      expect(res.status).toBe(404);
      expect((await readJson<ApiErrorBody>(res)).error).toBe(error);
    };

    // 2. In A, its own workspace, the event stream answers.
    const sseRes = await eventsIn(sharedA);
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    await sseRes.body?.cancel();

    // 3. From B, a workspace Alice also belongs to, it does not exist: the
    //    event stream and Stop answer exactly as for an unknown id, and the
    //    runtime read in B finds nothing.
    await expectError(await eventsIn(sharedB), "conversation_not_found");
    await expectError(await cancelIn(sharedB), "conversation_not_found");
    expect(await runtime.findConversation(sharedB, convId, { userId: ALICE.id })).toBeNull();

    // 4. Remove Alice from shared_a: workspace membership goes away,
    //    conversation ownership stays.
    const wsStore = runtime.getWorkspaceStore();
    await wsStore.removeMember(sharedA, ALICE.id);

    // The runtime read in A is owner-gated and does not consult membership.
    // The conversation is workspace-owned: its metadata `workspaceId` records the
    // workspace it lives in (`sharedA`), where its file also lives.
    const loaded = await runtime.findConversation(sharedA, convId, { userId: ALICE.id });
    expect(loaded?.ownerId).toBe(ALICE.id);
    expect(loaded?.workspaceId).toBe(sharedA);

    // Its HTTP routes in A now answer the workspace gate's 404, and from B it
    // is still not found.
    await expectError(await eventsIn(sharedA), "workspace_error");
    await expectError(await cancelIn(sharedA), "workspace_error");
    await expectError(await eventsIn(sharedB), "conversation_not_found");

    // 5. But chatting IN shared_a is refused with the workspace gate's single
    //    answer for a workspace the caller cannot reach (404, indistinguishable
    //    from an unknown workspace) — the `:wsId` gate runs at the HTTP
    //    boundary before the runtime even sees the request.
    const refusedRes = await fetch(`${baseUrl}/v1/workspaces/${sharedA}/chat/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALICE_TOKEN}`,
      },
      body: JSON.stringify({ message: "still in A?", conversationId: convId }),
    });
    expect(refusedRes.status).toBe(404);
    expect(await refusedRes.json()).toEqual({
      error: "workspace_error",
      message: "Workspace not found",
    });

    // 6. RESUME is denied at a DIFFERENT workspace Alice IS a member of, too
    //    (sharedB passes the door's membership check). A chat runs in the
    //    workspace its path names, and the conversation is not stored in
    //    sharedB, so the answer is the one an unknown conversation gets.
    const continueRes = await fetch(`${baseUrl}/v1/workspaces/${sharedB}/chat/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALICE_TOKEN}`,
      },
      body: JSON.stringify({
        message: "continuing in workspace B",
        conversationId: convId,
      }),
    });
    expect(continueRes.status).toBe(404);
    const continueBody = await readJson<ApiErrorBody>(continueRes);
    expect(continueBody.error).toBe("conversation_not_found");

    // 7. The denied resume left the conversation untouched: still one turn,
    //    still in sharedA, and the refused message was never appended.
    const store = await runtime.resolveConversationStore(sharedA, convId, ALICE.id);
    const conv = (await store!.load(convId)) ?? null;
    expect(conv).not.toBeNull();
    if (conv) {
      expect(conv.workspaceId).toBe(sharedA);
      const messages = await store!.history(conv);
      const texts = JSON.stringify(messages);
      expect(texts).not.toContain("continuing in workspace B");
    }
  });
});

// ---------------------------------------------------------------------------
// Secondary unit assertion — `canAccess` is purely ownership-based and
// does not consult workspace membership.
// ---------------------------------------------------------------------------

describe("canAccess — ownership is independent of workspace state", () => {
  test("an owner can access their conversation regardless of workspace context", () => {
    // The function takes a meta { ownerId } and access { userId }. No
    // workspace state is consulted. This is the invariant the E2E
    // above ultimately rests on — workspace membership changes can't
    // affect what `canAccess` returns for an owner.
    expect(canAccess({ ownerId: "usr_alice" }, { userId: "usr_alice" })).toBe(true);
    expect(canAccess({ ownerId: "usr_alice" }, { userId: "usr_bob" })).toBe(false);
    expect(canAccess(undefined, { userId: "usr_alice" })).toBe(false);
    expect(canAccess({ ownerId: "" }, { userId: "usr_alice" })).toBe(false);
  });
});
