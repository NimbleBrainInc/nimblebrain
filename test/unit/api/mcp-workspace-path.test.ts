/**
 * `/mcp/<wsId>`: which credentials reach a workspace's MCP endpoint.
 *
 * Every MCP connection names its workspace in the URL, and a token from the
 * MCP authorization server is valid only for the resource it was minted for:
 * its `aud` must equal `<publicOrigin>/mcp/<wsId>` exactly. Membership, not
 * the audience, authorizes. These are mostly the negative cases — each one is
 * a way a token or a request could reach a workspace it should not.
 *
 * The provider here is a lookup table from bearer token to what a real
 * provider reports after verifying a signature: an identity and its grant.
 * That is the seam — the rule under test sits above every provider.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { requireAuth } from "../../../src/api/middleware/auth.ts";
import type { McpSessionContext } from "../../../src/api/mcp-server.ts";
import { mcpRoutes } from "../../../src/api/routes/mcp.ts";
import type { AppContext } from "../../../src/api/types.ts";
import { resolveFeatures } from "../../../src/config/features.ts";
import {
  FIRST_PARTY_GRANT,
  type TokenGrant,
  type UserIdentity,
  type VerifiedIdentity,
} from "../../../src/identity/provider.ts";

const ORIGIN = "https://nb.example.com";
const WS_A = "ws_a";
const WS_B = "ws_b";
const CANONICAL_A = `${ORIGIN}/mcp/${WS_A}`;
const CLIENT_ID = "client_test_0001";
const INTERNAL_TOKEN = "internal-token-for-mcp-path-tests";

function identity(id: string): UserIdentity {
  return { id, email: `${id}@example.com`, displayName: id, orgRole: "member", preferences: {} };
}

const ALICE = identity("usr_alice");
const MALLORY = identity("usr_mallory");

function resource(...audience: string[]): TokenGrant {
  return { kind: "resource", audience };
}

/** Bearer token → what the provider reports once the signature verifies. */
const TOKENS: Record<string, VerifiedIdentity> = {
  "alice-first-party": { ...ALICE, grant: FIRST_PARTY_GRANT },
  "mallory-first-party": { ...MALLORY, grant: FIRST_PARTY_GRANT },
  "alice-aud-exact": { ...ALICE, grant: resource(CANONICAL_A) },
  "alice-aud-exact-in-array": { ...ALICE, grant: resource(CLIENT_ID, CANONICAL_A) },
  "alice-aud-origin": { ...ALICE, grant: resource(ORIGIN) },
  "alice-aud-client-id": { ...ALICE, grant: resource(CLIENT_ID) },
  "alice-aud-trailing-slash": { ...ALICE, grant: resource(`${CANONICAL_A}/`) },
  "alice-aud-extra-path": { ...ALICE, grant: resource(`${CANONICAL_A}/extra`) },
  "alice-aud-uppercase-host": { ...ALICE, grant: resource(`https://NB.EXAMPLE.COM/mcp/${WS_A}`) },
  "alice-aud-other-workspace": { ...ALICE, grant: resource(`${ORIGIN}/mcp/${WS_B}`) },
  "alice-aud-none": { ...ALICE, grant: resource() },
  "alice-aud-unknown-ws": { ...ALICE, grant: resource(`${ORIGIN}/mcp/ws_nosuchworkspace`) },
  "mallory-aud-exact": { ...MALLORY, grant: resource(CANONICAL_A) },
};

const WORKSPACES = new Map([
  [WS_A, { id: WS_A, members: [{ userId: ALICE.id, role: "member" }] }],
  [WS_B, { id: WS_B, members: [{ userId: ALICE.id, role: "member" }] }],
]);

/** What reached the MCP host, if anything. */
let reached: McpSessionContext[] = [];

function makeCtx(): AppContext {
  const provider = {
    capabilities: {
      authCodeFlow: false,
      tokenRefresh: false,
      managedUsers: false,
      authorizationServer: true,
    },
    authorizationServer: () => ({ issuer: "https://auth.example.com" }),
    verifyRequest: async (req: Request) => {
      const auth = req.headers.get("authorization") ?? "";
      return TOKENS[auth.replace(/^Bearer /, "")] ?? null;
    },
    listUsers: async () => [],
    createUser: async () => {
      throw new Error("not implemented");
    },
    deleteUser: async () => false,
  };
  return {
    provider,
    authOptions: {
      mode: { type: "adapter", provider },
      eventSink: { emit: () => {} },
      internalToken: INTERNAL_TOKEN,
    },
    runtime: { getFeatures: () => resolveFeatures() },
    workspaceStore: { get: async (id: string) => WORKSPACES.get(id) ?? null },
    mcpHost: {
      handle: async (_req: Request, _features: unknown, sessionCtx: McpSessionContext) => {
        reached.push(sessionCtx);
        return Response.json({ ok: true });
      },
    },
    // Bypasses the request rate limiter; nothing else here reads it.
    isDevMode: true,
  } as unknown as AppContext;
}

function makeApp(): Hono {
  const ctx = makeCtx();
  const app = new Hono();
  app.route("/", mcpRoutes(ctx));
  // A REST route behind the same middleware every `/v1/*` group uses.
  app.post("/v1/tools/call", requireAuth(ctx.authOptions), (c) => c.json({ ok: true }));
  return app;
}

function post(app: Hono, path: string, token?: string): Promise<Response> {
  return app.request(`http://api.example.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

let savedOrigin: string | undefined;
beforeEach(() => {
  savedOrigin = process.env.NB_PUBLIC_ORIGIN;
  process.env.NB_PUBLIC_ORIGIN = ORIGIN;
  reached = [];
});
afterEach(() => {
  if (savedOrigin === undefined) delete process.env.NB_PUBLIC_ORIGIN;
  else process.env.NB_PUBLIC_ORIGIN = savedOrigin;
});

describe("bare /mcp", () => {
  it("is refused with 404, naming the required URL shape, and never starts OAuth", async () => {
    const app = makeApp();
    for (const path of ["/mcp", "/mcp/"]) {
      const res = await post(app, path, "alice-first-party");
      expect(res.status).toBe(404);
      expect(res.headers.get("WWW-Authenticate")).toBeNull();
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain(`${ORIGIN}/mcp/<workspaceId>`);
    }
    // No credential at all gets the same answer: no default workspace, and no
    // 401 that would send a client to discover a resource that does not exist.
    const anonymous = await post(app, "/mcp");
    expect(anonymous.status).toBe(404);
    expect(anonymous.headers.get("WWW-Authenticate")).toBeNull();
    expect(reached).toEqual([]);
  });

  it("does not match paths below a workspace endpoint", async () => {
    const app = makeApp();
    const res = await post(app, `/mcp/${WS_A}/extra`, "alice-aud-exact");
    expect(res.status).toBe(404);
    expect(reached).toEqual([]);
  });
});

describe("authorization-server tokens at /mcp/<wsId>: aud must equal the canonical URL", () => {
  it("accepts an exact aud for a member, bound to that workspace", async () => {
    const res = await post(makeApp(), `/mcp/${WS_A}`, "alice-aud-exact");
    expect(res.status).toBe(200);
    expect(reached).toEqual([{ identity: ALICE, workspaceId: WS_A }]);
  });

  it("accepts an aud array that contains the exact URL", async () => {
    const res = await post(makeApp(), `/mcp/${WS_A}`, "alice-aud-exact-in-array");
    expect(res.status).toBe(200);
  });

  for (const [token, what] of [
    ["alice-aud-origin", "the bare origin"],
    ["alice-aud-client-id", "the environment's client id"],
    ["alice-aud-trailing-slash", "the URL with a trailing slash"],
    ["alice-aud-extra-path", "a path below the URL"],
    ["alice-aud-uppercase-host", "the URL with an uppercase host"],
    ["alice-aud-other-workspace", "another workspace's URL"],
    ["alice-aud-none", "no audience at all"],
  ] as const) {
    it(`refuses an aud of ${what} with 401 and the workspace's discovery header`, async () => {
      const res = await post(makeApp(), `/mcp/${WS_A}`, token);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain(
        `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/${WS_A}"`,
      );
      expect(reached).toEqual([]);
    });
  }
});

describe("membership authorizes; the answer never reveals whether a workspace exists", () => {
  it("refuses an exact aud for a non-member exactly like an unknown workspace", async () => {
    const app = makeApp();
    const nonMember = await post(app, `/mcp/${WS_A}`, "mallory-aud-exact");
    const unknown = await post(app, "/mcp/ws_nosuchworkspace", "alice-aud-unknown-ws");

    expect(nonMember.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await nonMember.text()).toBe(await unknown.text());
    expect(reached).toEqual([]);
  });

  it("refuses a first-party non-member exactly like an unknown workspace", async () => {
    const app = makeApp();
    const nonMember = await post(app, `/mcp/${WS_A}`, "mallory-first-party");
    const unknown = await post(app, "/mcp/ws_nosuchworkspace", "alice-first-party");
    const malformed = await post(app, "/mcp/not-a-workspace", "alice-first-party");

    expect(nonMember.status).toBe(404);
    expect(malformed.status).toBe(404);
    const nonMemberBody = await nonMember.text();
    expect(nonMemberBody).toBe(await unknown.text());
    expect(nonMemberBody).toBe(await malformed.text());
    expect(reached).toEqual([]);
  });

  it("refuses an id that differs from the stored workspace only by case", async () => {
    // A case-insensitive filesystem can resolve `WS_A` to ws_a's record; the
    // stored id must match the URL's exactly.
    const app = makeApp();
    const res = await post(app, "/mcp/WS_A", "alice-first-party");
    expect(res.status).toBe(404);
    expect(reached).toEqual([]);
  });
});

describe("first-party credentials", () => {
  it("accepts the web app's own login token at /mcp/<wsId> for a member", async () => {
    const res = await post(makeApp(), `/mcp/${WS_B}`, "alice-first-party");
    expect(res.status).toBe(200);
    expect(reached).toEqual([{ identity: ALICE, workspaceId: WS_B }]);
  });

  it("refuses the internal connector-to-host token before anything reaches the host", async () => {
    const res = await post(makeApp(), `/mcp/${WS_A}`, INTERNAL_TOKEN);
    expect(res.status).toBe(403);
    expect(reached).toEqual([]);
  });

  it("answers 401 with the workspace's discovery header when there is no credential", async () => {
    const res = await post(makeApp(), `/mcp/${WS_A}`);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/${WS_A}"`,
    );
  });
});

describe("a token is valid only for its resource", () => {
  it("refuses an aud-bound MCP token on a /v1/* REST route", async () => {
    const res = await post(makeApp(), "/v1/tools/call", "alice-aud-exact");
    expect(res.status).toBe(401);
  });

  it("still accepts the first-party token on REST", async () => {
    const res = await post(makeApp(), "/v1/tools/call", "alice-first-party");
    expect(res.status).toBe(200);
  });
});
