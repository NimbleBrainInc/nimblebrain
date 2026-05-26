/**
 * Regression: `GET /v1/bootstrap` must NOT enforce workspace membership.
 *
 * Bootstrap is the discovery surface — it permissively defaults the focused
 * workspace and never rejects an authenticated user over the `X-Workspace-Id`
 * header. A prior bug had `conversationEventRoutes` attach its
 * `optionalWorkspace` middleware via `.use("*")`; Hono flattens that into a
 * `/*` matcher that runs for every route mounted after it — including
 * `/v1/bootstrap`. The membership check (403 for a non-member workspace) then
 * leaked onto bootstrap and hard-locked-out any user whose remembered
 * workspace they'd lost access to.
 *
 * This test pins the contract end-to-end through the real Hono app:
 *   - bootstrap + a non-member `X-Workspace-Id` → 200 (permissive)
 *   - a genuine data endpoint + the same header → 403 (enforcement intact)
 *
 * The pairing is the point: the fix is surgical, not a blanket "ignore the
 * header everywhere".
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

  test("a data endpoint still rejects the same non-member X-Workspace-Id (403)", async () => {
    const res = await fetch(`${baseUrl}/v1/events`, {
      headers: {
        Authorization: `Bearer ${ALICE_TOKEN}`,
        "X-Workspace-Id": foreignWs,
      },
    });
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });
});
