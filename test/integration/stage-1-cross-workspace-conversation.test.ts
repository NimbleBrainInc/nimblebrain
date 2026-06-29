/**
 * Stage 1 E2E — the load-bearing claim of the cross-workspace refactor:
 *
 *   **Conversations outlive their workspace context.**
 *
 * A user can hold a conversation that was created against workspace A.
 * If the user is later removed from workspace A, they still own that
 * conversation — it lives at `{workDir}/conversations/{id}.jsonl`, not
 * `{workDir}/workspaces/A/...`. The conversation remains readable, but
 * any attempt to continue chatting in workspace A is refused at the
 * HTTP boundary with the standard non-member error.
 *
 * The Stage 1 spec phrases this as "tool calls referencing the left
 * workspace fail with `unauthorized`". Stage 2 introduces multi-
 * workspace tool aggregation; Stage 1's promise is narrower — single
 * workspace per chat, but the conversation itself is user-scoped. This
 * test pins the achievable Stage 1 claim end-to-end through the HTTP
 * layer, where workspace membership is actually enforced.
 *
 * Secondary assertion: `canAccess` is a pure ownership check that does
 * not consult workspace membership, so the user's access to their own
 * conversation is unaffected by membership changes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
} from "../../src/identity/provider.ts";
import type { User } from "../../src/identity/user.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

// ---------------------------------------------------------------------------
// Minimal multi-user auth adapter — same shape as conversation-access.test.ts,
// inlined to keep this E2E self-contained.
// ---------------------------------------------------------------------------

const ALICE: UserIdentity = {
  id: "usr_alice",
  email: "alice@example.com",
  displayName: "Alice",
  orgRole: "member",
};

class TokenAuthAdapter implements IdentityProvider {
  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: false,
    tokenRefresh: false,
    managedUsers: false,
  };

  constructor(private readonly tokens: Record<string, UserIdentity>) {}

  async verifyRequest(req: Request): Promise<UserIdentity | null> {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;
    return this.tokens[authHeader.slice(7)] ?? null;
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

describe("Stage 1 — conversations outlive their workspace context", () => {
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
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
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
    const a = await wsStore.create("Shared A", "shared_a");
    const b = await wsStore.create("Shared B", "shared_b");
    sharedA = a.id;
    sharedB = b.id;
    await wsStore.addMember(sharedA, ALICE.id, "admin");
    await wsStore.addMember(sharedB, ALICE.id, "admin");
    await runtime.ensureWorkspaceRegistry(sharedA);
    await runtime.ensureWorkspaceRegistry(sharedB);

    handle = startServer({
      runtime,
      port: 0,
      provider: new TokenAuthAdapter({ [ALICE_TOKEN]: ALICE }),
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    handle?.stop(true);
    await runtime?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  test("a conversation created in workspace A survives Alice being removed from A", async () => {
    // 1. Alice POSTs a chat in shared_a — produces a conversation that is
    //    workspace-owned under her personal workspace (the identity-bound chat surface
    //    stores under the session/personal workspace; the X-Workspace-Id
    //    header scopes the prompt briefing, not the conversation's workspace).
    const createRes = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALICE_TOKEN}`,
        "X-Workspace-Id": sharedA,
      },
      body: JSON.stringify({ message: "hello from workspace A" }),
    });
    expect(createRes.status).toBe(200);
    const createBody = (await createRes.json()) as { conversationId: string };
    const convId = createBody.conversationId;
    expect(convId).toMatch(/^conv_[a-f0-9]{16}$/);

    // The conversation is workspace-owned: its file lives under the workspace it
    // ran in (`workspaces/<sharedA>/conversations/<ownerId>/`) — the workspace owns
    // the directory — and NOT in a flat top-level `conversations/` dir. The
    // owner partition is what makes it survive removal: dropping Alice from
    // sharedA's member list doesn't touch her conversation file.
    const workspacePath = join(workspaceConversationsDir(workDir, sharedA, ALICE.id), `${convId}.jsonl`);
    const flatPath = join(workDir, "conversations", `${convId}.jsonl`);
    expect((await stat(workspacePath)).isFile()).toBe(true);
    let flatExists = true;
    try {
      await stat(flatPath);
    } catch {
      flatExists = false;
    }
    expect(flatExists).toBe(false);

    // 2. Remove Alice from shared_a. This is the load-bearing
    //    mutation: workspace membership goes away, conversation
    //    ownership stays.
    const wsStore = runtime.getWorkspaceStore();
    await wsStore.removeMember(sharedA, ALICE.id);

    // 3. The conversation is still readable via `findConversation` —
    //    ownership is the gate, not workspace membership.
    const loaded = await runtime.findConversation(convId, { userId: ALICE.id });
    expect(loaded).not.toBeNull();
    expect(loaded?.ownerId).toBe(ALICE.id);
    // The conversation is workspace-owned by the workspace it ran in: the metadata
    // `workspaceId` records that workspace (`sharedA`, the focused `X-Workspace-Id`),
    // which is also where its file lives. Ownership — not workspace membership —
    // is the access gate, so the conversation outlives Alice's removal from it.
    expect(loaded?.workspaceId).toBe(sharedA);

    // 4. SSE event stream on the conversation also still works —
    //    the events route gates on ownership, not workspace membership.
    const sseRes = await fetch(`${baseUrl}/v1/conversations/${convId}/events`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ALICE_TOKEN}` },
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    await sseRes.body?.cancel();

    // 5. But chatting IN shared_a is refused with the standard
    //    non-member 403 — workspace resolution happens at the HTTP
    //    boundary before the runtime even sees the request.
    const refusedRes = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALICE_TOKEN}`,
        "X-Workspace-Id": sharedA,
      },
      body: JSON.stringify({ message: "still in A?", conversationId: convId }),
    });
    expect(refusedRes.status).toBe(403);
    const refusedBody = await refusedRes.json();
    expect(refusedBody.error).toBe("workspace_error");
    expect(refusedBody.message).toMatch(/not a member/i);

    // 6. Continuing the same conversation in a DIFFERENT workspace
    //    Alice is still a member of works. The conversation is
    //    user-scoped; the workspace context selects tools, not the
    //    conversation. (Stage 2 adds multi-workspace tool aggregation
    //    inside a single chat turn — Stage 1's promise is just that
    //    the conversation survives the workspace change.)
    const continueRes = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALICE_TOKEN}`,
        "X-Workspace-Id": sharedB,
      },
      body: JSON.stringify({
        message: "continuing in workspace B",
        conversationId: convId,
      }),
    });
    expect(continueRes.status).toBe(200);
    const continueBody = (await continueRes.json()) as { conversationId: string };
    expect(continueBody.conversationId).toBe(convId);

    // 7. The conversation now has two turns recorded — one created while
    //    focused on sharedA (pre-removal), one continued while focused on
    //    sharedB (post-removal). The conversation's ROOM is fixed at create
    //    (sharedA) and does NOT migrate when continued from a different
    //    focused workspace: on resume the store is resolved from the
    //    conversation's own path, so both turns land in the sharedA workspace and
    //    `workspaceId` stays sharedA. The X-Workspace-Id of the second turn
    //    scopes that turn's tools/briefing, not where the conversation lives.
    const store = await runtime.resolveConversationStore(convId);
    const conv = (await store!.load(convId)) ?? null;
    expect(conv).not.toBeNull();
    if (conv) {
      const messages = await store!.history(conv);
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(conv.workspaceId).toBe(sharedA);
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
