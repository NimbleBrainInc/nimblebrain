/**
 * Regression guard for the Hono **wildcard-leak** class: a sub-app's `.use("*")`
 * middleware flattens into a `/*` matcher that runs for every route mounted
 * AFTER it on the same app, silently attaching that middleware to sibling routes
 * that never asked for it. This file has caught two instances:
 *
 *   1. `conversationEventRoutes`' `optionalWorkspace` `.use("*")` leaked FORWARD
 *      onto `/v1/bootstrap` and hard-locked-out any user whose remembered
 *      workspace they'd lost access to (bootstrap is a discovery surface — it
 *      must NOT 403 on a stale `X-Workspace-Id`). Fixed by per-route middleware.
 *   2. `chatRoutes`' `optionalWorkspace` `.use("*")` leaked FORWARD onto
 *      `/v1/events` (identity-scoped, mounted after chat at `app.ts`), giving it
 *      a spurious membership 403. Fixed by requiring the workspace per-route on
 *      the chat send routes and dropping the chat-router wildcard.
 *
 * Authorization correctness per endpoint, pinned end-to-end through the real app:
 *   - `GET  /v1/bootstrap` + non-member header → 200 (permissive; no backward leak)
 *   - `POST /v1/chat`       + absent header → 400, + non-member header → 403
 *     (enforces BY DESIGN — `requireWorkspace`, not a wildcard leak)
 *   - `GET  /v1/events`     + non-member header → NOT 403 (identity-scoped: it
 *     authorizes by identity and filters fan-out by server-computed membership,
 *     so it must ignore the header; a 403 here means the chat-router wildcard
 *     leaked forward again)
 *
 * The `/v1/events` case is the forward-leak guard the chat-door refactor would
 * otherwise have removed — reintroducing any `.use("*")` on a router mounted
 * before `eventRoutes` makes it 403 again, and this catches it.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  CreateUserInput,
  CreateUserResult,
  IdentityProvider,
  ProviderCapabilities,
  UserIdentity,
} from "../../src/identity/provider.ts";
import type { User } from "../../src/identity/user.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

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
    throw new Error("not supported");
  }
  async deleteUser(): Promise<boolean> {
    return false;
  }
}

describe("bootstrap does not enforce workspace membership (middleware-leak regression)", () => {
  const ALICE_TOKEN = "alice-token-1234567890";
  const workDir = join(tmpdir(), `nb-bootstrap-leak-${Date.now()}`);
  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  let foreignWs: string;

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });

    // Seed Alice's profile under the canonical id the adapter returns.
    const userDir = join(workDir, "users", ALICE.id);
    mkdirSync(userDir, { recursive: true });
    const now = new Date().toISOString();
    await Bun.write(
      join(userDir, "profile.json"),
      `${JSON.stringify({ ...ALICE, preferences: {}, createdAt: now, updatedAt: now }, null, 2)}\n`,
    );

    const wsStore = runtime.getWorkspaceStore();
    // Alice's own workspace (so she has ≥1 membership — bootstrap invariant).
    const mine = await wsStore.create("Alice WS", "alice_ws");
    await wsStore.addMember(mine.id, ALICE.id, "admin");
    // A workspace Alice is NOT a member of — this is the stale/foreign id the
    // browser might still send in `X-Workspace-Id`.
    const foreign = await wsStore.create("Someone Else", "someone_else");
    foreignWs = foreign.id;

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

  test("bootstrap + a non-member X-Workspace-Id returns 200 (not 403)", async () => {
    const res = await fetch(`${baseUrl}/v1/bootstrap`, {
      headers: {
        Authorization: `Bearer ${ALICE_TOKEN}`,
        "X-Workspace-Id": foreignWs,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activeWorkspace: string | null };
    // The foreign id is ignored; bootstrap falls back to a real membership.
    expect(body.activeWorkspace).not.toBe(foreignWs);
  });

  test("a workspace-scoped data endpoint rejects the same non-member X-Workspace-Id (403)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALICE_TOKEN}`,
        "X-Workspace-Id": foreignWs,
      },
      body: JSON.stringify({ message: "hello" }),
    });
    // `/v1/chat` requires the workspace (requireWorkspace), so a non-member
    // header is rejected at the door before the turn runs.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("workspace_error");
  });

  test("the chat door rejects an ABSENT workspace header (400) — the headline 'require it'", async () => {
    // The actual point of the refactor: no `X-Workspace-Id` is a 400 at the door,
    // not a silent default to the caller's personal workspace. Covered at the
    // resolver level in unit tests; this pins it end-to-end through the route.
    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALICE_TOKEN}`,
      },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("workspace_error");
  });

  test("the identity-scoped event stream does NOT 403 on a non-member header (forward-leak guard)", async () => {
    // `/v1/events` authorizes by identity and filters fan-out by server-computed
    // membership, so it must IGNORE `X-Workspace-Id`. A non-member header opens
    // the stream (the foreign workspace's events simply never fan out); a 403
    // here means the chat router's `.use("*")` leaked forward onto it again.
    //
    // The leak resolves a 403 IMMEDIATELY (a JSON error, no stream). A clean
    // response is an SSE stream whose headers, in this harness, don't flush until
    // the first byte — so we abort shortly after connecting and assert only that
    // we did NOT get the fast 403. (Asserting an exact 200 would race the SSE
    // header flush; "not 403" is the precise regression signature.)
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    let status: number | null = null;
    try {
      const res = await fetch(`${baseUrl}/v1/events`, {
        headers: {
          Authorization: `Bearer ${ALICE_TOKEN}`,
          "X-Workspace-Id": foreignWs,
        },
        signal: ctrl.signal,
      });
      status = res.status;
      await res.body?.cancel();
    } catch (err) {
      // AbortError = the stream opened and we cancelled it (i.e. not a fast 403).
      if ((err as Error).name !== "AbortError") throw err;
    } finally {
      clearTimeout(timer);
    }
    expect(status).not.toBe(403);
  });
});
