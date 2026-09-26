/**
 * Bootstrap reads nothing from the request to choose a workspace, and routers
 * mounted beside it do not leak workspace middleware onto it or onto other
 * identity-scoped routes.
 *
 * The browser may still send an `X-Workspace-Id` header (a stale client, a
 * proxy); the server gives it no meaning anywhere:
 *   - `GET  /v1/bootstrap` answers with the caller's personal workspace as
 *     `activeWorkspace`, whatever the header names — a workspace the caller
 *     belongs to, or one they do not.
 *
 * The Hono **wildcard-leak** class: a sub-app's `.use("*")` middleware flattens
 * into a `/*` matcher that runs for every route mounted AFTER it on the same
 * app, silently attaching that middleware to sibling routes that never asked for
 * it. Workspace admission is per-route (`requireWorkspace` on the
 * `/v1/workspaces/:wsId/…` routes), and these pin the boundary end-to-end:
 *   - `POST /v1/workspaces/<non-member>/chat` → 404 `workspace_error`
 *     (enforced BY DESIGN at the chat door)
 *   - `POST /v1/chat` → router 404 `not_found`: a workspace-scoped request
 *     without a workspace in its path has no route, never a default workspace
 *   - `GET  /v1/events` → neither 403 nor 404 (identity-scoped: it authorizes by
 *     identity and filters fan-out by server-computed membership; a workspace
 *     refusal here means a router mounted before `eventRoutes` leaked its
 *     workspace middleware forward)
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
  VerifiedIdentity,
} from "../../src/identity/provider.ts";
import { FIRST_PARTY_GRANT } from "../../src/identity/provider.ts";
import type { User } from "../../src/identity/user.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
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
    throw new Error("not supported");
  }
  async deleteUser(): Promise<boolean> {
    return false;
  }
}

describe("bootstrap ignores X-Workspace-Id", () => {
  const ALICE_TOKEN = "alice-token-1234567890";
  const workDir = join(tmpdir(), `nb-bootstrap-leak-${Date.now()}`);
  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  let personalWs: string;
  let sharedWs: string;
  let foreignWs: string;

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
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
    // Alice's personal workspace — the one bootstrap always answers with.
    personalWs = (await ensureUserWorkspace(wsStore, { id: ALICE.id, displayName: ALICE.displayName }))
      .id;
    // A shared workspace Alice belongs to — a header naming it must not move
    // the active workspace.
    const shared = await wsStore.create("Acme Corp", "acme_corp");
    await wsStore.addMember(shared.id, ALICE.id, "member");
    sharedWs = shared.id;
    // A workspace Alice is NOT a member of.
    const foreign = await wsStore.create("Tenant A", "tenant_a");
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

  async function bootstrapWithHeader(wsId: string) {
    const res = await fetch(`${baseUrl}/v1/bootstrap`, {
      headers: {
        Authorization: `Bearer ${ALICE_TOKEN}`,
        "X-Workspace-Id": wsId,
      },
    });
    const body = (await res.json()) as {
      activeWorkspace: string | null;
      workspaces: { id: string }[];
      shell: { chatEndpoint: string };
    };
    return { status: res.status, body };
  }

  test("a header naming another workspace the caller belongs to does not move activeWorkspace", async () => {
    const { status, body } = await bootstrapWithHeader(sharedWs);
    expect(status).toBe(200);
    expect(body.activeWorkspace).toBe(personalWs);
    expect(body.shell.chatEndpoint).toBe(`/v1/workspaces/${personalWs}/chat/stream`);
    // The shared workspace is still listed — the header just chooses nothing.
    expect(body.workspaces.map((w) => w.id)).toContain(sharedWs);
  });

  test("a header naming a non-member workspace does not break bootstrap", async () => {
    const { status, body } = await bootstrapWithHeader(foreignWs);
    expect(status).toBe(200);
    expect(body.activeWorkspace).toBe(personalWs);
    expect(body.workspaces.map((w) => w.id)).not.toContain(foreignWs);
  });

  test("the chat door refuses a non-member workspace in the path (404 workspace_error)", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${foreignWs}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALICE_TOKEN}`,
      },
      body: JSON.stringify({ message: "hello" }),
    });
    // The chat route requires the workspace in its path (requireWorkspace), so a
    // non-member is refused at the door before the turn runs.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "workspace_error",
      message: "Workspace not found",
    });
  });

  test("a chat request with no workspace in its path has no route — never a default workspace", async () => {
    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALICE_TOKEN}`,
        "X-Workspace-Id": personalWs,
      },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("the identity-scoped event stream is not refused for a workspace (forward-leak guard)", async () => {
    // `/v1/events` authorizes by identity and filters fan-out by server-computed
    // membership; it has no workspace to admit. A workspace refusal here (403,
    // or the gate's 404) means a router's `.use("*")` leaked forward onto it.
    //
    // A leak resolves IMMEDIATELY (a JSON error, no stream). A clean response is
    // an SSE stream whose headers, in this harness, don't flush until the first
    // byte — so we abort shortly after connecting and assert only that we did
    // NOT get a fast refusal. (Asserting an exact 200 would race the SSE header
    // flush; "not refused" is the precise regression signature.)
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
      // AbortError = the stream opened and we cancelled it (i.e. not refused).
      if ((err as Error).name !== "AbortError") throw err;
    } finally {
      clearTimeout(timer);
    }
    expect(status).not.toBe(403);
    expect(status).not.toBe(404);
  });
});
