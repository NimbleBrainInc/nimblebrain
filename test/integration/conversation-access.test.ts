/**
 * Integration tests for the single-owner conversation invariant, and for the
 * rule that a chat request names the workspace it runs in (ADR-0037).
 *
 * A chat under `/v1/workspaces/<wsId>/` resumes only one of the caller's own
 * conversations stored in `<wsId>`. Another owner's conversation, the caller's
 * conversation in another workspace, and an id that does not exist all get one
 * answer — `ConversationNotFoundError`, `404 conversation_not_found` — so the
 * answer reveals neither that an id exists nor where.
 *
 * Covers:
 *  - runtime.chat: same-owner resume succeeds; a foreign-owner or unknown id
 *    throws ConversationNotFoundError and creates nothing; missing
 *    request.identity throws when an identity provider is configured.
 *  - HTTP: the three chat routes answer each of those cases with the same 404.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { saveInstanceConfig } from "../../src/identity/instance.ts";
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
import { ConversationNotFoundError } from "../../src/runtime/errors.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALICE: UserIdentity = {
  id: "usr_alice",
  email: "alice@example.com",
  displayName: "Alice",
  orgRole: "member",
};
const BOB: UserIdentity = {
  id: "usr_bob",
  email: "bob@example.com",
  displayName: "Bob",
  orgRole: "member",
};

/**
 * Auth adapter that maps multiple bearer tokens to multiple identities.
 * Inlined here because TestAuthAdapter is single-user by design and the
 * cross-user tests need both Alice and Bob authenticated against the same
 * server.
 */
class MultiUserAuthAdapter implements IdentityProvider {
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

  async createUser(data: CreateUserInput): Promise<CreateUserResult> {
    const now = new Date().toISOString();
    return {
      user: {
        id: `usr_${Date.now()}`,
        email: data.email,
        displayName: data.displayName,
        orgRole: data.orgRole ?? "member",
        preferences: {},
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  async deleteUser(): Promise<boolean> {
    return false;
  }
}

interface SSEEvent {
  event: string;
  data: string;
}

function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const block of text.split("\n\n").filter((b) => b.trim())) {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event) events.push({ event, data });
  }
  return events;
}

// ---------------------------------------------------------------------------
// runtime.chat — ownership enforcement (dev-mode runtime, identity threaded
// through ChatRequest directly so we don't need the auth middleware)
// ---------------------------------------------------------------------------

describe("runtime.chat — single-owner ownership check", () => {
  let runtime: Runtime;
  let workDir: string;

  beforeAll(async () => {
    workDir = join(tmpdir(), `nb-conv-access-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      identityProvider: devProvider,
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
    // Alice resumes conversations in TEST_WORKSPACE_ID, which now requires
    // current membership of the conversation's workspace.
    await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, ALICE.id, "member");
  });

  afterAll(async () => {
    await runtime?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  test("same-owner resume appends to existing conversation", async () => {
    const first = await runtime.chat({
      message: "hello from alice",
      workspaceId: TEST_WORKSPACE_ID,
      identity: ALICE,
    });
    const second = await runtime.chat({
      message: "follow-up from alice",
      conversationId: first.conversationId,
      workspaceId: TEST_WORKSPACE_ID,
      identity: ALICE,
    });
    expect(second.conversationId).toBe(first.conversationId);

    const store = await runtime.resolveConversationStore(first.conversationId);
    const loaded = await store!.load(first.conversationId);
    expect(loaded).not.toBeNull();
    expect(loaded!.ownerId).toBe(ALICE.id);
    // Both turns appended — `history()` is the event-sourced read; the
    // turn count proves the second call resumed rather than minted a new
    // conversation.
    const messages = await store!.history(loaded!);
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  test("foreign-owner resume throws ConversationNotFoundError and leaves the conversation alone", async () => {
    const aliceConv = await runtime.chat({
      message: "alice's private convo",
      workspaceId: TEST_WORKSPACE_ID,
      identity: ALICE,
    });

    let caught: unknown = null;
    try {
      await runtime.chat({
        message: "bob trying to read alice's convo",
        conversationId: aliceConv.conversationId,
        workspaceId: TEST_WORKSPACE_ID,
        identity: BOB,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConversationNotFoundError);
    const err = caught as ConversationNotFoundError;
    expect(err.code).toBe("conversation_not_found");
    expect(err.conversationId).toBe(aliceConv.conversationId);

    // The foreign attempt did NOT silently mint a new conversation — that
    // would mask a takeover attempt as a normal flow.
    const loaded = await runtime.findConversation(aliceConv.conversationId);
    expect(loaded!.ownerId).toBe(ALICE.id);
  });

  test("a non-existent conversationId throws ConversationNotFoundError and creates nothing", async () => {
    // Valid format (`conv_` + 16 hex chars) so it passes path validation,
    // but guaranteed not to exist in the store.
    const bogus = "conv_0000000000000000";
    await expect(
      runtime.chat({
        message: "create me a new one",
        conversationId: bogus,
        workspaceId: TEST_WORKSPACE_ID,
        identity: ALICE,
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(await runtime.findConversation(bogus)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runtime.chat — identity-provider gate on the usr_default fallback
// ---------------------------------------------------------------------------

describe("runtime.chat — identity-provider gate", () => {
  let runtime: Runtime;
  let workDir: string;

  beforeAll(async () => {
    workDir = join(tmpdir(), `nb-conv-access-idp-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    // Seeding instance.json BEFORE Runtime.start makes createIdentityProvider
    // return a real OidcIdentityProvider — the constructor is lazy (no
    // network), so we don't need a fake issuer to be reachable.
    await saveInstanceConfig(workDir, {
      auth: {
        adapter: "oidc",
        issuer: "https://auth.example.com",
        clientId: "test",
        allowedDomains: ["example.com"],
      },
    });
    runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);
  });

  afterAll(async () => {
    await runtime?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  test("identity provider configured + missing request.identity throws hard (no usr_default fallback)", async () => {
    // The production path is for the auth middleware to populate
    // request.identity before runtime.chat runs. If middleware is broken
    // or bypassed, the previous unconditional fallback silently minted
    // usr_default-owned conversations for every request — Stage 1 closes
    // that hole.
    let caught: unknown = null;
    try {
      await runtime.chat({
        message: "no identity",
        workspaceId: TEST_WORKSPACE_ID,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/no identity on request/);
  });
});

// ---------------------------------------------------------------------------
// HTTP / SSE — ConversationAccessDeniedError mapping at the API boundary
// ---------------------------------------------------------------------------

describe("HTTP — a conversation that is not the caller's in the path's workspace", () => {
  const ALICE_TOKEN = "alice-token-1234567890";
  const BOB_TOKEN = "bob-token-0987654321";
  const CHAT_ROUTES = ["/chat", "/chat/stream", "/chat/start"] as const;

  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  let workDir: string;
  let wsB: string;
  /** Alice's conversation in TEST_WORKSPACE_ID (workspace A). */
  let aliceConvInA: string;
  /** Alice's conversation in workspace B. */
  let aliceConvInB: string;

  beforeAll(async () => {
    workDir = join(tmpdir(), `nb-conv-access-http-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      identityProvider: () =>
        new MultiUserAuthAdapter({
          [ALICE_TOKEN]: ALICE,
          [BOB_TOKEN]: BOB,
        }),
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime);

    // Seed Alice + Bob with the canonical ids the auth adapter returns.
    // `UserStore.create` assigns its own ids, so we write profiles
    // directly to keep `usr_alice` / `usr_bob` stable across the test.
    const wsStore = runtime.getWorkspaceStore();
    const now = new Date().toISOString();
    for (const u of [ALICE, BOB]) {
      const dir = join(workDir, "users", u.id);
      mkdirSync(dir, { recursive: true });
      await Bun.write(
        join(dir, "profile.json"),
        `${JSON.stringify({ ...u, preferences: {}, createdAt: now, updatedAt: now }, null, 2)}\n`,
      );
      await wsStore.addMember(TEST_WORKSPACE_ID, u.id, "member");
    }
    // Alice is a member of B too: the refusal is about the path, not membership.
    wsB = (await wsStore.create("tenant-a")).id;
    await wsStore.addMember(wsB, ALICE.id, "member");
    await runtime.ensureWorkspaceRegistry(wsB);

    aliceConvInA = (
      await runtime.chat({ message: "alice seed", workspaceId: TEST_WORKSPACE_ID, identity: ALICE })
    ).conversationId;
    aliceConvInB = (
      await runtime.chat({ message: "alice in B", workspaceId: wsB, identity: ALICE })
    ).conversationId;

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

  async function send(route: string, token: string, conversationId: string) {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "hello", conversationId }),
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  /** The answer with the id factored out, so two refusals can be compared whole. */
  function shape(body: { details?: { conversationId?: string } }, id: string) {
    expect(body.details?.conversationId).toBe(id);
    return { ...body, details: { ...body.details, conversationId: "<id>" } };
  }

  for (const route of CHAT_ROUTES) {
    test(`${route}: a conversation in another workspace is refused exactly like an unknown one`, async () => {
      const unknownId = "conv_0000000000000001";
      const inB = await send(route, ALICE_TOKEN, aliceConvInB);
      const unknown = await send(route, ALICE_TOKEN, unknownId);

      expect(inB.status).toBe(404);
      expect(inB.body.error).toBe("conversation_not_found");
      expect(unknown.status).toBe(404);
      expect(shape(inB.body, aliceConvInB)).toEqual(shape(unknown.body, unknownId));

      // Nothing ran in B and nothing was born in A under either id.
      expect(runtime.isTurnActive(aliceConvInB)).toBe(false);
      const inBStore = await runtime.resolveConversationStore(aliceConvInB);
      const conv = await inBStore!.load(aliceConvInB);
      expect(await inBStore!.history(conv!)).toHaveLength(2);
      expect(await runtime.findConversation(unknownId)).toBeNull();
    });

    test(`${route}: another owner's conversation is refused exactly like an unknown one`, async () => {
      const unknownId = "conv_0000000000000002";
      const foreign = await send(route, BOB_TOKEN, aliceConvInA);
      const unknown = await send(route, BOB_TOKEN, unknownId);

      expect(foreign.status).toBe(404);
      expect(shape(foreign.body, aliceConvInA)).toEqual(shape(unknown.body, unknownId));
      const loaded = await runtime.findConversation(aliceConvInA);
      expect(loaded!.ownerId).toBe(ALICE.id);
    });
  }

  test("the conversation resumes at its own workspace's path", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${wsB}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ALICE_TOKEN}` },
      body: JSON.stringify({ message: "back in B", conversationId: aliceConvInB }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).conversationId).toBe(aliceConvInB);
  });
});
