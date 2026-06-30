/**
 * Integration tests for the Stage 1 single-owner conversation invariant.
 *
 * `runtime.chat` enforces that resuming a conversation requires the caller
 * to be its `ownerId`. Today the per-wsId store directory makes the check
 * implicitly workspace-bounded; Task 005 collapses every conversation onto
 * a top-level store, at which point this owner check is the only barrier
 * between users and each other's conversations. These tests pin the
 * load-bearing behavior in place.
 *
 * Covers:
 *  - runtime.chat: same-owner resume succeeds; foreign-owner throws
 *    ConversationAccessDeniedError; non-existent id creates new; missing
 *    request.identity throws when an identity provider is configured.
 *  - HTTP/SSE: ConversationAccessDeniedError → 403 conversation_access_denied
 *    on /v1/chat; → SSE error event on /v1/chat/stream.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { saveInstanceConfig } from "../../src/identity/instance.ts";
import type {
  CreateUserInput,
  CreateUserResult,
  IdentityProvider,
  ProviderCapabilities,
  UserIdentity,
} from "../../src/identity/provider.ts";
import type { User } from "../../src/identity/user.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { ConversationAccessDeniedError } from "../../src/runtime/errors.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

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
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
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

  test("foreign-owner resume throws ConversationAccessDeniedError", async () => {
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
    expect(caught).toBeInstanceOf(ConversationAccessDeniedError);
    const err = caught as ConversationAccessDeniedError;
    expect(err.code).toBe("conversation_access_denied");
    expect(err.conversationId).toBe(aliceConv.conversationId);
    expect(err.userId).toBe(BOB.id);

    // Crucial: the foreign attempt did NOT silently mint a new conversation
    // — that would mask a takeover attempt as a normal flow.
    const loaded = await runtime.findConversation(aliceConv.conversationId);
    expect(loaded!.ownerId).toBe(ALICE.id);
  });

  test("non-existent conversationId creates a new conversation (no existence leak)", async () => {
    // Valid format (`conv_` + 16 hex chars) so it passes path validation,
    // but guaranteed not to exist in the store.
    const bogus = "conv_0000000000000000";
    const result = await runtime.chat({
      message: "create me a new one",
      conversationId: bogus,
      workspaceId: TEST_WORKSPACE_ID,
      identity: ALICE,
    });
    // The runtime treats unknown ids as "create new" — distinguishing this
    // from foreign-owner is what closes the existence-leak side channel.
    expect(result.conversationId).not.toBe(bogus);
    const loaded = await runtime.findConversation(result.conversationId);
    expect(loaded).not.toBeNull();
    expect(loaded!.ownerId).toBe(ALICE.id);
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
      noDefaultBundles: true,
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

describe("HTTP/SSE — ConversationAccessDeniedError mapping", () => {
  const ALICE_TOKEN = "alice-token-1234567890";
  const BOB_TOKEN = "bob-token-0987654321";

  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  let workDir: string;
  let aliceConvId: string;

  beforeAll(async () => {
    workDir = join(tmpdir(), `nb-conv-access-http-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
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

    // Seed a conversation owned by Alice that Bob will try to access.
    const seed = await runtime.chat({
      message: "alice seed",
      workspaceId: TEST_WORKSPACE_ID,
      identity: ALICE,
    });
    aliceConvId = seed.conversationId;

    handle = startServer({
      runtime,
      port: 0,
      provider: new MultiUserAuthAdapter({
        [ALICE_TOKEN]: ALICE,
        [BOB_TOKEN]: BOB,
      }),
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    handle?.stop(true);
    await runtime?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  test("POST /v1/chat returns 403 conversation_access_denied when Bob resumes Alice's conversation", async () => {
    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BOB_TOKEN}`,
        "X-Workspace-Id": TEST_WORKSPACE_ID,
      },
      body: JSON.stringify({ message: "bob steals", conversationId: aliceConvId }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.error).toBe("conversation_access_denied");
    expect(body.details?.conversationId).toBe(aliceConvId);
  });

  test("POST /v1/chat/stream emits SSE error event when Bob resumes Alice's conversation", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BOB_TOKEN}`,
        "X-Workspace-Id": TEST_WORKSPACE_ID,
      },
      body: JSON.stringify({ message: "bob streams a steal", conversationId: aliceConvId }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    const text = await res.text();
    const events = parseSSE(text);
    const errEvent = events.find((e) => e.event === "error");
    expect(errEvent).toBeDefined();
    const payload = JSON.parse(errEvent!.data);
    expect(payload.error).toBe("conversation_access_denied");
  });
});
