import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mcpAuthRoutes } from "../../../src/api/routes/mcp-auth.ts";
import type { ApiErrorBody, OAuthInitiateResponse } from "../../../src/api/schemas/responses.ts";
import type { AppContext, AppEnv } from "../../../src/api/types.ts";
import {
  ConnectorBusyError,
  type ConnectorLifecycleManager,
} from "../../../src/connectors/runtime/lifecycle.ts";
import type { ConnectorInstance } from "../../../src/connectors/runtime/types.ts";
import { IdentityConnectorStore } from "../../../src/identity/connector-store.ts";
import { FIRST_PARTY_GRANT, type IdentityProvider } from "../../../src/identity/provider.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { mintBrowserBinding } from "../../../src/oauth/flow-binding.ts";
import { log } from "../../../src/observability/log.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import {
  _clearAll,
  type AuthorizationResponse,
  addBrowserBinding,
  DEFAULT_FLOW_TTL_MS,
  type FlowOwner,
  flowBrowserBindings,
  MAX_FLOW_BINDINGS,
  OAuthFlowRefusedError,
  peekFlow,
  register as registerFlow,
  resolveWithCode,
  setFlowReturnWorkspace,
} from "../../../src/tools/oauth-flow-registry.ts";
import type { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import { assertConversationInWorkspaceOver } from "../../helpers/conversation-ownership.ts";
import { readJson } from "../../helpers/http.ts";
import { stub } from "../../helpers/stub.ts";
import { makeWorkspace } from "../../helpers/test-workspace.ts";

/** What `POST .../mcp-auth/initiate` answers: `null` when no interactive step is needed. */

/**
 * Unit coverage for `mcpAuthRoutes` — the route is the security boundary
 * for interactive OAuth (cookie-bound state, single-use flow registry, no-
 * cache headers). The provider, lifecycle, and registry all have their own
 * tests; this file covers the route-handler logic directly.
 *
 * The workspace-scoped initiate route runs its real middleware in dev mode:
 * `requireAuth` passes with no identity, and `requireWorkspace` admits the dev
 * user to the workspace named in the path because the stub store lists it as
 * a member. We're testing the route's cookie binding, not the auth/workspace
 * middleware (which has its own tests).
 */

const WS_ID = "ws_0076759dbbe19fcc";
/** The dev user, the one member of `WS_ID`. */
const DEV_USER_ID = "usr_default";
/** Auth that verifies every request as the dev user, as the `dev` provider does. */
const DEV_AUTH = {
  provider: stub<IdentityProvider>({
    verifyRequest: async () => ({ ...DEV_IDENTITY, grant: FIRST_PARTY_GRANT }),
  }),
  eventSink: { emit: () => {} },
};
const INITIATE_PATH = `/v1/workspaces/${WS_ID}/mcp-auth/initiate`;
const WS_OWNER = { kind: "workspace", wsId: WS_ID } as const;
const USER_ID = "usr_test";
/** Another workspace the test user belongs to. */
const WS_OTHER = "ws_00000000000000ab";
/** The test user's conversation in `WS_ID`. */
const MY_CONV = "conv_00000000000000a1";
/** Another member's conversation in `WS_ID`. */
const THEIR_CONV = "conv_00000000000000b2";
/** The test user's conversation in `WS_OTHER`. */
const OTHER_WS_CONV = "conv_00000000000000c3";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Bind a fresh browser to the pending flow for `state`, as an initiate does; returns its Cookie header. */
function boundCookie(state: string): string {
  const binding = mintBrowserBinding();
  if (!addBrowserBinding(state, binding.bindingHash)) throw new Error(`no flow for ${state}`);
  return `__Host-nb_oauth_state=${binding.cookieValue}`;
}

/** A cookie built from the callback URL alone: the sha256 of its state. Admits nothing. */
function forgedCookie(state: string): string {
  return `__Host-nb_oauth_state=${sha256Hex(state)}`;
}

/**
 * Assert an initiate response bound its browser to the flow for `state`: the
 * cookie is a random value (not derivable from the state) whose hash the flow
 * recorded. Returns the Cookie header that browser sends on the callback.
 */
function expectBoundTo(res: Response, state: string): string {
  const value =
    /^__Host-nb_oauth_state=([^;]*)/.exec(res.headers.get("Set-Cookie") ?? "")?.[1] ?? "";
  expect(value).toMatch(/^[0-9a-f]{64}$/);
  expect(value).not.toBe(sha256Hex(state));
  expect(flowBrowserBindings(state)?.has(sha256Hex(value))).toBe(true);
  return `__Host-nb_oauth_state=${value}`;
}

/**
 * Register the flow a captured authorization URL names, as the real provider
 * does before it reports the URL. A flow already pending for that state is the
 * one being handed out again, and is kept.
 */
function registerFlowFor(url: string | null, owner: FlowOwner, serverName: string): void {
  const state = url ? new URL(url).searchParams.get("state") : null;
  if (state && !peekFlow(state)) registerFlow(state, owner, serverName).catch(() => {});
}

interface StubLifecycle {
  /** Pre-canned URL the stub `startAuth` returns. Unset ⇒ throws; value `null` ⇒
   *  connected without an interactive flow (already authenticated). */
  authUrls: Map<string, string | null>; // key: "serverName|wsId|principalId"
  instances: Map<string, Partial<ConnectorInstance>>; // key: "serverName|wsId"
  /** Pre-canned URL the stub `startIdentityAuth` returns. Unset ⇒ throws; value
   *  `null` ⇒ connected without an interactive flow (already authenticated).
   *  Key: "serverName|userId". */
  identityAuthUrls: Map<string, string | null>;
  /** Whether a start registers the flow its URL names, as the real provider does. Default true. */
  registersFlows: boolean;
  getInstance(serverName: string, wsId: string): ConnectorInstance | null;
  startAuth(
    serverName: string,
    wsId: string,
    principalId: string,
    opts: { workDir: string; callbackUrl: string; allowInsecureRemotes?: boolean },
  ): Promise<{ authorizationUrl: string | null }>;
  startIdentityAuth(
    serverName: string,
    userId: string,
    opts: { workDir: string; allowInsecureRemotes?: boolean },
  ): Promise<{ authorizationUrl: string | null }>;
}

function makeStubLifecycle(): StubLifecycle {
  const authUrls = new Map<string, string | null>();
  const identityAuthUrls = new Map<string, string | null>();
  const instances = new Map<string, Partial<ConnectorInstance>>();
  const lifecycle: StubLifecycle = {
    authUrls,
    identityAuthUrls,
    instances,
    registersFlows: true,
    getInstance(serverName, wsId) {
      const instance = instances.get(`${serverName}|${wsId}`);
      return instance ? stub<ConnectorInstance>(instance) : null;
    },
    async startAuth(serverName, wsId, principalId) {
      const key = `${serverName}|${wsId}|${principalId}`;
      if (!authUrls.has(key)) throw new Error(`stub: no canned URL for ${key}`);
      const authorizationUrl = authUrls.get(key) ?? null;
      if (lifecycle.registersFlows) {
        registerFlowFor(authorizationUrl, { kind: "workspace", wsId }, serverName);
      }
      return { authorizationUrl };
    },
    async startIdentityAuth(serverName, userId) {
      const key = `${serverName}|${userId}`;
      if (!identityAuthUrls.has(key)) throw new Error(`stub: no canned identity URL for ${key}`);
      const authorizationUrl = identityAuthUrls.get(key) ?? null;
      if (lifecycle.registersFlows) {
        registerFlowFor(authorizationUrl, { kind: "user", userId }, serverName);
      }
      return { authorizationUrl };
    },
  };
  return lifecycle;
}

function makeApp(lifecycle: StubLifecycle, workDir = "/tmp/nb-test"): Hono<AppEnv> {
  const ctx = stub<AppContext>({
    runtime: stub<Runtime>({
      getLifecycle: () => stub<ConnectorLifecycleManager>(lifecycle),
      getWorkDir: () => workDir,
      getAllowInsecureRemotes: () => false,
      // The route's owner resolution, fixed to the test user.
      resolveRequestUserId: () => USER_ID,
      assertConversationInWorkspace: assertConversationInWorkspaceOver([
        { wsId: WS_ID, ownerId: USER_ID, conversationId: MY_CONV },
        { wsId: WS_ID, ownerId: DEV_USER_ID, conversationId: THEIR_CONV },
        { wsId: WS_OTHER, ownerId: USER_ID, conversationId: OTHER_WS_CONV },
      ]),
    }),
    authOptions: DEV_AUTH,
    workspaceStore: stub<WorkspaceStore>({
      get: async (id: string) =>
        id === WS_ID || id === WS_OTHER
          ? makeWorkspace({
              id,
              members: [
                { userId: DEV_USER_ID, role: "admin" },
                { userId: USER_ID, role: "member" },
              ],
            })
          : null,
    }),
  });

  const app = new Hono<AppEnv>();
  app.route("/", mcpAuthRoutes(ctx));
  return app;
}

describe("POST /v1/workspaces/:wsId/mcp-auth/initiate", () => {
  let app: Hono<AppEnv>;
  let lifecycle: StubLifecycle;

  beforeEach(() => {
    lifecycle = makeStubLifecycle();
    app = makeApp(lifecycle);
  });

  afterEach(() => {
    _clearAll();
  });

  test("sets session-bound state cookie and returns the authorization URL", async () => {
    const state = "abc-123-def";
    const authUrl = `https://granola.test/oauth/authorize?state=${state}&client_id=cid`;
    lifecycle.instances.set(`granola|${WS_ID}`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(`granola|${WS_ID}|_workspace`, authUrl);

    const res = await app.request(`http://localhost${INITIATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola" }),
    });

    expect(res.status).toBe(200);
    const body = await readJson<OAuthInitiateResponse>(res);
    expect(body.authorizationUrl).toBe(authUrl);

    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expectBoundTo(res, state);
    expect(setCookie!).toContain("HttpOnly");
    expect(setCookie!).toContain("SameSite=Lax");
    expect(setCookie!).toStartWith("__Host-nb_oauth_state=");
    expect(setCookie!).toContain("Path=/;");
    expect(setCookie!).not.toContain("Domain");
    expect(setCookie!).toContain("Max-Age=900");
    expect(setCookie!).toEndWith("Secure");
  });

  test("the callback admits only the __Host- cookie, not the same value under the bare name", async () => {
    const state = "secure-host-state";
    lifecycle.instances.set(`granola|${WS_ID}`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(
      `granola|${WS_ID}|_workspace`,
      `https://granola.test/auth?state=${state}`,
    );
    const init = await app.request(`http://api.example.com${INITIATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola" }),
    });
    const value = /^__Host-nb_oauth_state=([0-9a-f]{64});/.exec(
      init.headers.get("Set-Cookie") ?? "",
    )?.[1];
    expect(value).toBeDefined();
    const callbackUrl = `http://api.example.com/v1/mcp-auth/callback?code=c&state=${state}`;

    // The same value under the bare name is not the flow cookie.
    const bare = await app.request(callbackUrl, {
      headers: { cookie: `nb_oauth_state=${value}` },
    });
    expect(bare.status).toBe(400);

    const res = await app.request(callbackUrl, {
      headers: { cookie: `__Host-nb_oauth_state=${value}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toBe(
      "__Host-nb_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure",
    );
  });

  test("returns { authorizationUrl: null } and no cookie when connected without interactive auth (#679)", async () => {
    // A provider-minted / already-authenticated source: startAuth resolves with no
    // URL (the source is now running). The route must report success — not a 500 —
    // and set no state cookie (there is no interactive flow to bind).
    lifecycle.instances.set(`minted|${WS_ID}`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(`minted|${WS_ID}|_workspace`, null);

    const res = await app.request(`http://localhost${INITIATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "minted" }),
    });

    expect(res.status).toBe(200);
    const body = await readJson<OAuthInitiateResponse>(res);
    expect(body.authorizationUrl).toBeNull();
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  test("returns 404 with no cookie when connector is not installed", async () => {
    const res = await app.request(`http://localhost${INITIATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "no-such-connector" }),
    });

    expect(res.status).toBe(404);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("connector_not_found");
    // No cookie should be set when no flow exists.
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  test("returns 400 on missing serverName", async () => {
    const res = await app.request(`http://localhost${INITIATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("bad_request");
  });

  test("returns 400 on non-JSON body", async () => {
    const res = await app.request(`http://localhost${INITIATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  test("returns 500 when captured URL is missing the state parameter", async () => {
    // A URL without `?state=…` shouldn't reach this code path in production,
    // but the route guards against it explicitly.
    lifecycle.instances.set(`bad|${WS_ID}`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(`bad|${WS_ID}|_workspace`, "https://granola.test/auth?client_id=x");

    const res = await app.request(`http://localhost${INITIATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "bad" }),
    });
    expect(res.status).toBe(500);
  });

  test("returns 404 workspace_error and starts no flow for a workspace the caller is not in", async () => {
    lifecycle.instances.set(`granola|ws_005820c54ca342ad`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(
      `granola|ws_005820c54ca342ad|_workspace`,
      "https://granola.test/auth?state=s",
    );

    const res = await app.request(
      "http://localhost/v1/workspaces/ws_005820c54ca342ad/mcp-auth/initiate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverName: "granola" }),
      },
    );

    expect(res.status).toBe(404);
    expect((await readJson<ApiErrorBody>(res)).error).toBe("workspace_error");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  test("the unscoped /v1/mcp-auth/initiate path is not a route", async () => {
    lifecycle.instances.set(`granola|${WS_ID}`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(`granola|${WS_ID}|_workspace`, "https://granola.test/auth?state=s");

    const res = await app.request("http://localhost/v1/mcp-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola" }),
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("GET /v1/mcp-auth/callback", () => {
  let app: Hono<AppEnv>;
  let lifecycle: StubLifecycle;

  beforeEach(() => {
    lifecycle = makeStubLifecycle();
    app = makeApp(lifecycle);
  });

  afterEach(() => {
    _clearAll();
  });

  test("matching cookie + valid state resolves the flow and clears the cookie", async () => {
    const state = "valid-state-xyz";
    const flowPromise = registerFlow(state, WS_OWNER, "granola");
    // Attach a no-op catch so a test failure doesn't leak an unhandled
    // rejection if the assertion path bails before consuming flowPromise.
    flowPromise.catch(() => {});

    const cookie = boundCookie(state);
    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=auth-code-1&state=${state}`,
      { headers: { cookie } },
    );

    // Redirect straight back to the workspace-scoped connectors page for the
    // workspace the flow was initiated in, naming the connector that connected
    // so the page can confirm it. The callback renders no page of its own.
    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const location = res.headers.get("Location") ?? "";
    expect(location).toEndWith("/w/0076759dbbe19fcc/plugins?connected=granola&owner=workspace");
    expect(await res.text()).toBe("");

    // Cookie cleared: Max-Age=0
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toBe(
      "__Host-nb_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure",
    );

    // Flow resolved with the code we sent
    await expect(flowPromise).resolves.toEqual({ code: "auth-code-1" });
  });

  test("an RFC 9207 `iss` on the callback reaches the flow with the code", async () => {
    const state = "valid-state-iss";
    const flowPromise = registerFlow(state, WS_OWNER, "notion");
    flowPromise.catch(() => {});

    const cookie = boundCookie(state);
    const iss = encodeURIComponent("https://mcp.example.com");
    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=auth-code-1&state=${state}&iss=${iss}`,
      { headers: { cookie } },
    );

    expect(res.status).toBe(302);
    await expect(flowPromise).resolves.toEqual({
      code: "auth-code-1",
      iss: "https://mcp.example.com",
    });
  });

  test("missing cookie → 400 session mismatch, flow NOT resolved", async () => {
    const state = "no-cookie-state";
    const flowPromise = registerFlow(state, WS_OWNER, "granola");
    flowPromise.catch(() => {});

    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=c&state=${state}`,
      // no cookie header
    );

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Authorization session mismatch");

    // Flow stays pending (still in registry). Verify by resolving from
    // outside — `resolveWithCode` returns true only if the flow is still
    // there.
    const { resolveWithCode } = await import("../../../src/tools/oauth-flow-registry.ts");
    expect(resolveWithCode(state, "fallback")).toBe(true);
    await expect(flowPromise).resolves.toEqual({ code: "fallback" });
  });

  test("mismatched cookie hash → 400 session mismatch, flow NOT resolved", async () => {
    const state = "mismatched-state";
    const flowPromise = registerFlow(state, WS_OWNER, "granola");
    flowPromise.catch(() => {});

    // Cookie is sha256(some-other-state), not sha256(state) — the timing-safe
    // comparison must reject.
    const wrongCookie = `__Host-nb_oauth_state=${sha256Hex("some-other-state")}`;
    const res = await app.request(`http://localhost/v1/mcp-auth/callback?code=c&state=${state}`, {
      headers: { cookie: wrongCookie },
    });

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Authorization session mismatch");

    const { resolveWithCode } = await import("../../../src/tools/oauth-flow-registry.ts");
    expect(resolveWithCode(state, "fallback")).toBe(true);
    await expect(flowPromise).resolves.toEqual({ code: "fallback" });
  });

  test("matching cookie but flow not in registry → 404 unknown flow", async () => {
    // Race window: cookie matches, but the registry never had this state
    // (or it timed out). Surface as 404, not 200 — we never resolved a flow.
    const state = "ghost-state";
    const cookie = `__Host-nb_oauth_state=${mintBrowserBinding().cookieValue}`;

    const res = await app.request(`http://localhost/v1/mcp-auth/callback?code=c&state=${state}`, {
      headers: { cookie },
    });

    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Unknown or expired");
  });

  test("missing code or state → 400", async () => {
    const res = await app.request("http://localhost/v1/mcp-auth/callback?code=only");
    expect(res.status).toBe(400);
  });

  test("AS-side error param → 400 with escaped error message", async () => {
    const res = await app.request(
      "http://localhost/v1/mcp-auth/callback?error=access_denied&state=x",
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("access_denied");
    expect(html).toContain("Authorization failed");
    // Make sure raw HTML special chars in error are escaped.
    const evilRes = await app.request(
      "http://localhost/v1/mcp-auth/callback?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E&state=x",
    );
    const evilHtml = await evilRes.text();
    expect(evilHtml).not.toContain("<script>");
    expect(evilHtml).toContain("&lt;script&gt;");
  });

  test("response is not cacheable", async () => {
    const res = await app.request("http://localhost/v1/mcp-auth/callback?code=x&state=y");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Pragma")).toBe("no-cache");
  });
});

describe("GET /v1/mcp-auth/callback — invalid_scope falls back to the connector's own scope", () => {
  let app: Hono<AppEnv>;
  const state = "fallback-state";
  const fallbackUrl = `https://vendor.test/authorize?state=${state}&scope=mcp&client_id=cid`;
  let cookie: string;
  const refused = `http://localhost/v1/mcp-auth/callback?error=invalid_scope&state=${state}`;
  let used: number;
  let flow: Promise<AuthorizationResponse>;

  beforeEach(() => {
    app = makeApp(makeStubLifecycle());
    used = 0;
    flow = registerFlow(state, WS_OWNER, "granola", DEFAULT_FLOW_TTL_MS, {
      url: fallbackUrl,
      onUse: () => used++,
    });
    flow.catch(() => {});
    cookie = boundCookie(state);
  });

  afterEach(() => {
    _clearAll();
  });

  test("sends the browser to the fallback once, and the same flow still completes", async () => {
    const res = await app.request(refused, { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(fallbackUrl);
    expect(used).toBe(1);

    expect(resolveWithCode(state, "auth-code-1")).toBe(true);
    await expect(flow).resolves.toEqual({ code: "auth-code-1" });
  });

  test("takes no fallback without the session's state cookie", async () => {
    const res = await app.request(refused);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(used).toBe(0);
  });

  test("takes no fallback for any other refusal", async () => {
    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?error=access_denied&state=${state}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
    expect(used).toBe(0);
  });
});

describe("GET /v1/mcp-auth/callback — a refusal ends the flow (#1433)", () => {
  // A flow left pending after the server refused it holds its connector's
  // start for the whole TTL: the connection reads as connecting and a second
  // Connect on a personal connector answers 409 until the timer fires.
  let app: Hono<AppEnv>;
  const state = "refused-state-abcdef";
  const denied = `http://localhost/v1/mcp-auth/callback?error=access_denied&state=${state}`;

  beforeEach(() => {
    app = makeApp(makeStubLifecycle());
  });

  afterEach(() => {
    _clearAll();
  });

  test("a refusal from the browser that began the flow rejects it at once", async () => {
    const flow = registerFlow(state, WS_OWNER, "granola");
    flow.catch(() => {});
    const cookie = boundCookie(state);

    const res = await app.request(denied, { headers: { cookie } });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("access_denied");
    const err = await flow.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OAuthFlowRefusedError);
    // The flow is gone: a late code for it resolves nothing.
    expect(resolveWithCode(state, "late-code")).toBe(false);
  });

  test("a refusal from a browser the flow did not bind leaves the flow pending", async () => {
    const flow = registerFlow(state, WS_OWNER, "granola");
    flow.catch(() => {});
    boundCookie(state);

    const noCookie = await app.request(denied);
    const wrongCookie = await app.request(denied, {
      headers: { cookie: `__Host-nb_oauth_state=${sha256Hex("another-state")}` },
    });
    const fromUrl = await app.request(denied, { headers: { cookie: forgedCookie(state) } });

    expect(noCookie.status).toBe(400);
    expect(wrongCookie.status).toBe(400);
    expect(fromUrl.status).toBe(400);
    expect(resolveWithCode(state, "auth-code-1")).toBe(true);
    await expect(flow).resolves.toEqual({ code: "auth-code-1" });
  });

  test("a refusal that names no flow still answers 400", async () => {
    const unknown = await app.request(denied, { headers: { cookie: forgedCookie(state) } });
    const stateless = await app.request(
      "http://localhost/v1/mcp-auth/callback?error=access_denied",
    );

    expect(unknown.status).toBe(400);
    expect(stateless.status).toBe(400);
  });

  test("invalid_scope ends the flow once no fallback is left", async () => {
    let used = 0;
    const flow = registerFlow(state, WS_OWNER, "granola", DEFAULT_FLOW_TTL_MS, {
      url: `https://vendor.test/authorize?state=${state}&scope=mcp`,
      onUse: () => used++,
    });
    flow.catch(() => {});
    const cookie = boundCookie(state);
    const refused = `http://localhost/v1/mcp-auth/callback?error=invalid_scope&state=${state}`;

    // The first refusal takes the fallback and keeps the flow.
    expect((await app.request(refused, { headers: { cookie } })).status).toBe(302);
    // The server refuses the fallback too: nothing is left to try.
    expect((await app.request(refused, { headers: { cookie } })).status).toBe(400);

    expect(used).toBe(1);
    await expect(flow).rejects.toBeInstanceOf(OAuthFlowRefusedError);
  });
});

describe("GET /v1/mcp-auth/callback — outcome logging (#1244)", () => {
  // Without these lines, "the user never came back from the vendor" and "a
  // callback arrived and a check refused it" are the same observation: silence.
  // Each test pins one outcome, and the last pins what must never appear.
  let app: Hono<AppEnv>;
  let info: ReturnType<typeof spyOn>;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    app = makeApp(makeStubLifecycle());
    info = spyOn(log, "info").mockImplementation(() => {});
    warn = spyOn(log, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    _clearAll();
  });

  /** Structured fields of the single logged call, whichever level it used. */
  function loggedFields(): Record<string, unknown> {
    const calls = [...info.mock.calls, ...warn.mock.calls];
    expect(calls.length).toBe(1);
    return calls[0][1] as Record<string, unknown>;
  }

  test("a resolved flow logs outcome=resolved at info, with the owner and flow id", async () => {
    const state = "resolved-state-abcdef";
    const flowPromise = registerFlow(state, WS_OWNER, "granola");
    flowPromise.catch(() => {});

    await app.request(`http://localhost/v1/mcp-auth/callback?code=the-code&state=${state}`, {
      headers: { cookie: boundCookie(state) },
    });

    expect(warn).not.toHaveBeenCalled();
    expect(loggedFields()).toMatchObject({
      event: "mcp_auth.callback",
      outcome: "resolved",
      owner: "workspace",
      flow: state.slice(0, 8),
    });
    await expect(flowPromise).resolves.toEqual({ code: "the-code" });
  });

  test("a callback for an unknown/expired flow logs outcome=unknown_flow at warn", async () => {
    const state = "ghost-state-123456";
    await app.request(`http://localhost/v1/mcp-auth/callback?code=c&state=${state}`, {
      headers: { cookie: forgedCookie(state) },
    });

    expect(info).not.toHaveBeenCalled();
    expect(loggedFields()).toMatchObject({ outcome: "unknown_flow", flow: state.slice(0, 8) });
  });

  test("a missing cookie logs binding=absent; a wrong one logs binding=mismatched", async () => {
    // The distinction separates a browser that dropped the cookie on the return
    // leg from a genuine session mismatch — different causes, same page.
    const state = "cookie-state-987654";
    registerFlow(state, WS_OWNER, "granola").catch(() => {});

    await app.request(`http://localhost/v1/mcp-auth/callback?code=c&state=${state}`);
    expect(loggedFields()).toMatchObject({ outcome: "cookie_mismatch", binding: "absent" });

    warn.mockClear();
    await app.request(`http://localhost/v1/mcp-auth/callback?code=c&state=${state}`, {
      headers: { cookie: `__Host-nb_oauth_state=${sha256Hex("a-different-state")}` },
    });
    expect(loggedFields()).toMatchObject({ outcome: "cookie_mismatch", binding: "mismatched" });
  });

  test("a vendor error param logs outcome=provider_error with the vendor's code", async () => {
    await app.request("http://localhost/v1/mcp-auth/callback?error=access_denied&state=x");
    expect(loggedFields()).toMatchObject({
      outcome: "provider_error",
      providerError: "access_denied",
    });
  });

  test("a refusal from the flow's session logs the flow id and whether it ended a flow", async () => {
    const state = "refused-state-abcdef";
    const refusal = `http://localhost/v1/mcp-auth/callback?error=access_denied&state=${state}`;
    registerFlow(state, WS_OWNER, "granola").catch(() => {});
    const headers = { cookie: boundCookie(state) };

    await app.request(refusal, { headers });
    expect(loggedFields()).toMatchObject({
      outcome: "provider_error",
      providerError: "access_denied",
      flow: state.slice(0, 8),
      flowEnded: true,
    });

    // The same refusal again finds no flow left to end.
    warn.mockClear();
    await app.request(refusal, { headers });
    expect(loggedFields()).toMatchObject({ outcome: "provider_error", flowEnded: false });
  });

  test("a hostile error param cannot write an unbounded log field", async () => {
    const huge = "x".repeat(5000);
    await app.request(`http://localhost/v1/mcp-auth/callback?error=${huge}&state=y`);
    expect(String(loggedFields().providerError).length).toBe(64);
  });

  test("missing code/state logs outcome=missing_params", async () => {
    await app.request("http://localhost/v1/mcp-auth/callback?code=only");
    expect(loggedFields()).toMatchObject({ outcome: "missing_params" });
  });

  test("never logs the authorization code or the full state", async () => {
    // The code is a live credential and the full state is the flow's key. Only
    // a truncated state prefix may appear, as the flow id.
    const state = "secret-state-value-do-not-log";
    registerFlow(state, WS_OWNER, "granola").catch(() => {});
    await app.request(`http://localhost/v1/mcp-auth/callback?code=secret-code&state=${state}`, {
      headers: { cookie: boundCookie(state) },
    });

    const serialized = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(serialized).not.toContain("secret-code");
    expect(serialized).not.toContain(state);
    expect(serialized).toContain(state.slice(0, 8));
  });
});

describe("GET /v1/mcp-auth/callback — the line a deployed pod actually writes", () => {
  afterEach(() => {
    _clearAll();
  });

  // The outcome tests above spy on `log.warn`, which observes the call *before*
  // the JSON sink's key-denylist redactor runs. That gap is real: a field named
  // `cookie` reads correctly in pretty dev output and arrives as "[redacted]"
  // on a deployed pod, where the distinction is the whole point. This asserts
  // the serialized stderr line instead of the call.
  test("the session-binding field survives redaction in JSON mode", async () => {
    const app = makeApp(makeStubLifecycle());
    const state = "json-sink-state-1";
    registerFlow(state, WS_OWNER, "granola").catch(() => {});

    const saved = process.env.NB_LOG_FORMAT;
    process.env.NB_LOG_FORMAT = "json";
    const lines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      // No cookie header → the session check refuses, which is the branch that
      // carries the field.
      await app.request(`http://localhost/v1/mcp-auth/callback?code=c&state=${state}`);
    } finally {
      process.stderr.write = origWrite;
      if (saved === undefined) delete process.env.NB_LOG_FORMAT;
      else process.env.NB_LOG_FORMAT = saved;
    }

    const line = lines
      .join("")
      .split("\n")
      .find((l) => l.includes("mcp_auth.callback"));
    expect(line).toBeDefined();
    const rec = JSON.parse(line as string);

    expect(rec.outcome).toBe("cookie_mismatch");
    expect(rec.binding).toBe("absent");
    // Any key the denylist matches would land here as "[redacted]".
    expect(line).not.toContain("[redacted]");
  });
});

describe("browser binding: the callback completes only in a browser an initiate bound", () => {
  let app: Hono<AppEnv>;
  let lifecycle: StubLifecycle;
  let workDir: string;
  const state = "pending-workspace-state";
  const authUrl = `https://granola.test/authorize?state=${state}&client_id=cid`;
  const callback = (code: string) =>
    `http://localhost/v1/mcp-auth/callback?code=${code}&state=${state}`;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-mcp-auth-binding-"));
    lifecycle = makeStubLifecycle();
    lifecycle.instances.set(`granola|${WS_ID}`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(`granola|${WS_ID}|_workspace`, authUrl);
    app = makeApp(lifecycle, workDir);
  });

  afterEach(() => {
    _clearAll();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function initiate(): Promise<Response> {
    return app.request(`http://localhost${INITIATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola" }),
    });
  }

  test("a cookie computed from the URL's state is refused, and the flow stays pending", async () => {
    // Someone who learns only the authorization URL (it carries `state`) and
    // never ran an initiate cannot build an admitted cookie from it.
    const pending = registerFlow(state, { kind: "user", userId: "usr_victim" }, "granola");
    pending.catch(() => {});
    boundCookie(state);

    const res = await app.request(callback("ATTACKER_CODE"), {
      headers: { cookie: forgedCookie(state) },
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Authorization session mismatch");
    expect(resolveWithCode(state, "own-code")).toBe(true);
    await expect(pending).resolves.toEqual({ code: "own-code" });
  });

  test("a second initiate on a pending workspace flow gets its own cookie, and either completes it once", async () => {
    const first = await initiate();
    const second = await initiate();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstCookie = expectBoundTo(first, state);
    const secondCookie = expectBoundTo(second, state);
    expect(secondCookie).not.toBe(firstCookie);
    expect(flowBrowserBindings(state)?.size).toBe(2);

    // The second browser arrives first and completes the flow.
    expect(
      (await app.request(callback("code-2"), { headers: { cookie: secondCookie } })).status,
    ).toBe(302);
    // The flow is gone, so the first browser's return finds nothing to complete.
    const late = await app.request(callback("code-1"), { headers: { cookie: firstCookie } });
    expect(late.status).toBe(404);
    expect(await late.text()).toContain("Unknown or expired");
  });

  test("a personal sign-in handed out again issues a cookie that completes it", async () => {
    await new IdentityConnectorStore({ workDir }).add(USER_ID, {
      url: "https://granola.test/mcp",
      serverName: "granola",
      ui: null,
    });
    lifecycle.identityAuthUrls.set(`granola|${USER_ID}`, authUrl);
    const start = () =>
      app.request("http://localhost/v1/mcp-auth/initiate-identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverName: "granola" }),
      });

    expectBoundTo(await start(), state); // the tab the person closed
    const resumed = expectBoundTo(await start(), state);

    const res = await app.request(callback("code-1"), { headers: { cookie: resumed } });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location") ?? "").toEndWith(
      "/profile/connectors?connected=granola&owner=person",
    );
  });

  test("an initiate whose flow is no longer pending sets no cookie and answers 500", async () => {
    lifecycle.registersFlows = false;
    const res = await initiate();
    expect(res.status).toBe(500);
    expect((await readJson<ApiErrorBody>(res)).error).toBe("auth_start_failed");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  test("a flow keeps at most MAX_FLOW_BINDINGS bindings, dropping the oldest", async () => {
    registerFlow(state, WS_OWNER, "granola").catch(() => {});
    const oldest = boundCookie(state);
    for (let i = 0; i < MAX_FLOW_BINDINGS; i++) boundCookie(state);
    expect(flowBrowserBindings(state)?.size).toBe(MAX_FLOW_BINDINGS);
    const res = await app.request(callback("c"), { headers: { cookie: oldest } });
    expect(res.status).toBe(400);
  });
});

describe("bouncer mode: state envelope wrap on initiate / unwrap on callback", () => {
  const BOUNCER_CALLBACK = "https://connect.example.com/v1/mcp-auth/callback";
  const TID = "tenant-a";
  const TENANT_KEY_B64 = randomBytes(32).toString("base64");

  const BOUNCER_ENV_VARS = [
    "NB_OAUTH_BOUNCER_CALLBACK_URL",
    "NB_OAUTH_BOUNCER_TENANT_KEY",
    "NB_TENANT_ID",
    "NB_PLATFORM_HOST",
  ] as const;

  let savedEnv: Record<string, string | undefined>;
  let app: Hono<AppEnv>;
  let lifecycle: StubLifecycle;

  beforeEach(async () => {
    savedEnv = Object.fromEntries(BOUNCER_ENV_VARS.map((k) => [k, process.env[k]]));
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = BOUNCER_CALLBACK;
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = TENANT_KEY_B64;
    process.env.NB_TENANT_ID = TID;
    // A real bouncer-mode tenant always carries a public-origin fact too: the
    // bouncer 302s the callback back to this tenant's `publicOrigin()` (the
    // return leg). Set it so the callback handler can build the return URL —
    // without it, `publicOrigin()` fails closed (NB_TENANT_ID set, no host facts).
    process.env.NB_PLATFORM_HOST = `${TID}.nb.example.com`;
    const { _resetBouncerModeForTest } = await import("../../../src/oauth/bouncer-config.ts");
    _resetBouncerModeForTest();
    lifecycle = makeStubLifecycle();
    app = makeApp(lifecycle);
  });

  afterEach(async () => {
    for (const k of BOUNCER_ENV_VARS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const { _resetBouncerModeForTest } = await import("../../../src/oauth/bouncer-config.ts");
    _resetBouncerModeForTest();
    _clearAll();
  });

  test("initiate wraps state in a v1 envelope and keeps the cookie keyed on inner", async () => {
    const innerState = "sdk-generated-state-xyz";
    const authUrl = `https://vendor.test/oauth/authorize?state=${innerState}&client_id=cid`;
    lifecycle.instances.set(`granola|${WS_ID}`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(`granola|${WS_ID}|_workspace`, authUrl);

    const res = await app.request(`http://localhost${INITIATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola" }),
    });

    expect(res.status).toBe(200);
    const body = await readJson<OAuthInitiateResponse>(res);

    // The authorizationUrl returned to the client has the wrapped state
    // in place of the SDK-generated inner state.
    const parsed = new URL(body.authorizationUrl);
    const wireState = parsed.searchParams.get("state");
    expect(wireState).not.toBeNull();
    expect(wireState).not.toBe(innerState);
    expect(wireState!.startsWith("v1.")).toBe(true);

    // The browser is bound to the flow keyed on the INNER state, which the
    // callback recovers by unwrapping the envelope.
    expectBoundTo(res, innerState);
  });

  test("an invalid_scope callback's fallback carries the state re-wrapped for the bouncer", async () => {
    const { signEnvelope, verifyEnvelopeAsTenant } = await import("../../../src/oauth/envelope.ts");
    const tenantKey = Buffer.from(TENANT_KEY_B64, "base64");
    const innerState = "inner-state-for-fallback";
    const wireState = signEnvelope({ tid: TID, inner: innerState, tenantKey });
    registerFlow(innerState, WS_OWNER, "granola", DEFAULT_FLOW_TTL_MS, {
      url: `https://vendor.test/authorize?state=${innerState}&scope=mcp`,
      onUse: () => {},
    }).catch(() => {});

    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?error=invalid_scope&state=${encodeURIComponent(wireState)}`,
      { headers: { cookie: boundCookie(innerState) } },
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("scope")).toBe("mcp");
    const rewrapped = location.searchParams.get("state") ?? "";
    expect(rewrapped.startsWith("v1.")).toBe(true);
    expect(verifyEnvelopeAsTenant({ wire: rewrapped, tenantKey, expectedTid: TID }).inner).toBe(
      innerState,
    );
  });

  test("callback unwraps the envelope, applies cookie binding, and resolves the flow", async () => {
    const { signEnvelope } = await import("../../../src/oauth/envelope.ts");
    const innerState = "inner-state-for-callback";
    const wireState = signEnvelope({
      tid: TID,
      inner: innerState,
      tenantKey: Buffer.from(TENANT_KEY_B64, "base64"),
    });

    const flowPromise = registerFlow(innerState, WS_OWNER, "granola");
    flowPromise.catch(() => {});

    const cookie = boundCookie(innerState);
    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=auth-code-1&state=${encodeURIComponent(wireState)}`,
      { headers: { cookie } },
    );

    expect(res.status).toBe(302);
    await expect(flowPromise).resolves.toEqual({ code: "auth-code-1" });
  });

  test("callback rejects state that lacks the v1 envelope prefix", async () => {
    // An attacker bypassing the bouncer to hit our direct hostname sends
    // a non-wrapped state. Refuse rather than silently fall through.
    const res = await app.request(
      "http://localhost/v1/mcp-auth/callback?code=c&state=raw-state-no-envelope",
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("state envelope missing");
  });

  test("an unwrapped state logs envelope_missing; a bad envelope logs envelope_invalid + reason", async () => {
    // Both refuse with the same page on purpose (naming the failed check would
    // be an oracle), so the log line is the only thing that tells an operator
    // which of the two happened. (#1244)
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await app.request("http://localhost/v1/mcp-auth/callback?code=c&state=raw-state");
      expect(warn.mock.calls[0][1]).toMatchObject({ outcome: "envelope_missing" });

      warn.mockClear();
      const { signEnvelope } = await import("../../../src/oauth/envelope.ts");
      const wireState = signEnvelope({
        tid: TID,
        inner: "inner",
        tenantKey: randomBytes(32),
      });
      await app.request(
        `http://localhost/v1/mcp-auth/callback?code=c&state=${encodeURIComponent(wireState)}`,
      );
      expect(warn.mock.calls[0][1]).toMatchObject({ outcome: "envelope_invalid" });
      expect(warn.mock.calls[0][1]).toHaveProperty("reason");
    } finally {
      warn.mockRestore();
    }
  });

  test("callback rejects an envelope signed with a different tenant key", async () => {
    const { signEnvelope } = await import("../../../src/oauth/envelope.ts");
    const wireState = signEnvelope({
      tid: TID,
      inner: "doesnt-matter",
      tenantKey: randomBytes(32),
    });
    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=c&state=${encodeURIComponent(wireState)}`,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Authorization session invalid");
  });

  test("callback rejects an envelope minted for a different tid", async () => {
    const { signEnvelope, deriveTenantKey } = await import("../../../src/oauth/envelope.ts");
    const otherTid = "tenant-b";
    const otherKey = deriveTenantKey(randomBytes(32), otherTid);
    const wireState = signEnvelope({
      tid: otherTid,
      inner: "doesnt-matter",
      tenantKey: otherKey,
    });
    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=c&state=${encodeURIComponent(wireState)}`,
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Authorization session invalid");
  });

  test("mcpAuthCallbackUrl returns the bouncer URL when bouncer mode is enabled", async () => {
    const { mcpAuthCallbackUrl } = await import("../../../src/api/routes/mcp-auth.ts");
    expect(mcpAuthCallbackUrl()).toBe(BOUNCER_CALLBACK);
  });
});

describe("POST /v1/mcp-auth/initiate-identity", () => {
  let workDir: string;
  let app: Hono<AppEnv>;
  let lifecycle: StubLifecycle;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-mcp-auth-identity-"));
    lifecycle = makeStubLifecycle();
    app = makeApp(lifecycle, workDir);
  });

  afterEach(() => {
    _clearAll();
    rmSync(workDir, { recursive: true, force: true });
  });

  test("installed connector → sets session-bound cookie and returns the auth URL", async () => {
    await new IdentityConnectorStore({ workDir }).add(USER_ID, {
      url: "https://granola.test/mcp",
      serverName: "granola",
      ui: null,
    });
    const state = "identity-state-abc";
    lifecycle.identityAuthUrls.set(
      `granola|${USER_ID}`,
      `https://granola.test/authorize?state=${state}&client_id=cid`,
    );

    const res = await app.request("http://localhost/v1/mcp-auth/initiate-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola" }),
    });

    expect(res.status).toBe(200);
    expect((await readJson<OAuthInitiateResponse>(res)).authorizationUrl).toContain("/authorize");
    expectBoundTo(res, state);
    expect(res.headers.get("Set-Cookie") ?? "").toContain("Path=/;");
  });

  test("a returnWorkspaceId the caller belongs to is recorded on the flow", async () => {
    await new IdentityConnectorStore({ workDir }).add(USER_ID, {
      url: "https://granola.test/mcp",
      serverName: "granola",
      ui: null,
    });
    const state = "identity-state-return";
    lifecycle.identityAuthUrls.set(
      `granola|${USER_ID}`,
      `https://granola.test/authorize?state=${state}&client_id=cid`,
    );

    const res = await app.request("http://localhost/v1/mcp-auth/initiate-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola", returnWorkspaceId: WS_ID }),
    });

    expect(res.status).toBe(200);
    expect(peekFlow(state)?.returnWsId).toBe(WS_ID);
  });

  test("a returnWorkspaceId the caller does not belong to is refused, and no flow starts", async () => {
    await new IdentityConnectorStore({ workDir }).add(USER_ID, {
      url: "https://granola.test/mcp",
      serverName: "granola",
      ui: null,
    });
    lifecycle.identityAuthUrls.set(
      `granola|${USER_ID}`,
      "https://granola.test/authorize?state=never&client_id=cid",
    );

    for (const returnWorkspaceId of ["ws_00000000000000ff", "not-a-workspace", 7]) {
      const res = await app.request("http://localhost/v1/mcp-auth/initiate-identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverName: "granola", returnWorkspaceId }),
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });

  test("a returnConversationId the caller owns in returnWorkspaceId is recorded on the flow", async () => {
    await new IdentityConnectorStore({ workDir }).add(USER_ID, {
      url: "https://granola.test/mcp",
      serverName: "granola",
      ui: null,
    });
    const state = "identity-state-return-chat";
    lifecycle.identityAuthUrls.set(
      `granola|${USER_ID}`,
      `https://granola.test/authorize?state=${state}&client_id=cid`,
    );
    registerFlow(state, { kind: "user", userId: USER_ID }, "granola").catch(() => {});

    const res = await app.request("http://localhost/v1/mcp-auth/initiate-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverName: "granola",
        returnWorkspaceId: WS_ID,
        returnConversationId: MY_CONV,
      }),
    });

    expect(res.status).toBe(200);
    expect(peekFlow(state)).toMatchObject({ returnWsId: WS_ID, returnConversationId: MY_CONV });
    // The conversation never rides in the authorization URL.
    expect((await readJson<OAuthInitiateResponse>(res)).authorizationUrl).not.toContain(MY_CONV);
  });

  test("a returnConversationId that is not the caller's in returnWorkspaceId is refused like a workspace, with no flow started", async () => {
    await new IdentityConnectorStore({ workDir }).add(USER_ID, {
      url: "https://granola.test/mcp",
      serverName: "granola",
      ui: null,
    });
    let started = 0;
    lifecycle.startIdentityAuth = async () => {
      started++;
      return { authorizationUrl: "https://granola.test/authorize?state=never" };
    };

    const cases: Array<{ name: string; body: Record<string, unknown> }> = [
      {
        name: "another member's",
        body: { returnWorkspaceId: WS_ID, returnConversationId: THEIR_CONV },
      },
      {
        name: "in another workspace",
        body: { returnWorkspaceId: WS_ID, returnConversationId: OTHER_WS_CONV },
      },
      { name: "malformed", body: { returnWorkspaceId: WS_ID, returnConversationId: "../conv" } },
      { name: "not a string", body: { returnWorkspaceId: WS_ID, returnConversationId: 7 } },
      { name: "with no workspace", body: { returnConversationId: MY_CONV } },
    ];
    const workspaceRefusal = await app.request("http://localhost/v1/mcp-auth/initiate-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola", returnWorkspaceId: "ws_00000000000000ff" }),
    });
    const expected = await readJson<ApiErrorBody>(workspaceRefusal);
    for (const { name, body } of cases) {
      const res = await app.request("http://localhost/v1/mcp-auth/initiate-identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverName: "granola", ...body }),
      });
      expect(res.status, name).toBe(404);
      expect(await readJson<ApiErrorBody>(res), name).toEqual(expected);
      expect(res.headers.get("Set-Cookie"), name).toBeNull();
    }
    expect(started).toBe(0);
  });

  test("connected without interactive auth → { authorizationUrl: null } and no cookie (#679)", async () => {
    await new IdentityConnectorStore({ workDir }).add(USER_ID, {
      url: "https://minted.test/mcp",
      serverName: "minted",
      ui: null,
    });
    // startIdentityAuth resolves with no URL — the connector is already authenticated.
    lifecycle.identityAuthUrls.set(`minted|${USER_ID}`, null);

    const res = await app.request("http://localhost/v1/mcp-auth/initiate-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "minted" }),
    });

    expect(res.status).toBe(200);
    const body = await readJson<OAuthInitiateResponse>(res);
    expect(body.authorizationUrl).toBeNull();
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  test("a connect already in progress → 409 connector_busy (retriable), not 500", async () => {
    await new IdentityConnectorStore({ workDir }).add(USER_ID, {
      url: "https://granola.test/mcp",
      serverName: "granola",
      ui: null,
    });
    // The lifecycle rejects `ConnectorBusyError` when a start is already in
    // flight for this (user, connector) — a retriable conflict, not a fault.
    lifecycle.startIdentityAuth = async () => {
      throw new ConnectorBusyError("granola", USER_ID);
    };

    const res = await app.request("http://localhost/v1/mcp-auth/initiate-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola" }),
    });

    expect(res.status).toBe(409);
    expect((await readJson<ApiErrorBody>(res)).error).toBe("connector_busy");
    expect(res.headers.get("Retry-After")).not.toBeNull();
    // Busy is not a flow start — no state cookie set.
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  test("not one of the caller's personal connectors → 404 connector_not_found (not 500)", async () => {
    const res = await app.request("http://localhost/v1/mcp-auth/initiate-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "not-installed" }),
    });
    expect(res.status).toBe(404);
    expect((await readJson<ApiErrorBody>(res)).error).toBe("connector_not_found");
    // No flow started, no cookie set.
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("GET /v1/mcp-auth/callback — owner-aware redirect", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = makeApp(makeStubLifecycle());
  });
  afterEach(() => {
    _clearAll();
  });

  test("a user-owned flow started from a workspace returns to that workspace's Plugins page", async () => {
    const state = "user-owned-return-state";
    const flowPromise = registerFlow(state, { kind: "user", userId: USER_ID }, "granola");
    flowPromise.catch(() => {});
    setFlowReturnWorkspace(state, WS_ID);

    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=code-1&state=${state}`,
      { headers: { cookie: boundCookie(state) } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location") ?? "").toEndWith(
      "/w/0076759dbbe19fcc/plugins?connected=granola&owner=person",
    );
    await expect(flowPromise).resolves.toEqual({ code: "code-1" });
  });

  test("a user-owned flow started from a conversation reopens it on the Plugins page", async () => {
    const state = "user-owned-return-chat-state";
    const flowPromise = registerFlow(state, { kind: "user", userId: USER_ID }, "granola");
    flowPromise.catch(() => {});
    setFlowReturnWorkspace(state, WS_ID, MY_CONV);

    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=code-1&state=${state}&chat=conv_ffffffffffffffff`,
      { headers: { cookie: boundCookie(state) } },
    );

    expect(res.status).toBe(302);
    // The conversation comes from the flow, never from the callback's query.
    expect(res.headers.get("Location") ?? "").toEndWith(
      `/w/0076759dbbe19fcc/plugins?connected=granola&owner=person&chat=${MY_CONV}`,
    );
    await expect(flowPromise).resolves.toEqual({ code: "code-1" });
  });

  test("a user-owned flow lands the user on /profile/connectors (not a workspace page)", async () => {
    const state = "user-owned-state";
    const flowPromise = registerFlow(state, { kind: "user", userId: USER_ID }, "granola");
    flowPromise.catch(() => {});

    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=code-1&state=${state}`,
      { headers: { cookie: boundCookie(state) } },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toEndWith("/profile/connectors?connected=granola&owner=person");
    // Never a workspace-scoped page for a personal connector.
    expect(location).not.toContain("/w/");
    await expect(flowPromise).resolves.toEqual({ code: "code-1" });
  });
});

describe("fleet authorizer: startup validation", () => {
  const FLEET_ENV_VARS = [
    "NB_FLEET_AUTHORIZER_TOKEN_URL",
    "NB_MCP_AUTHORIZER_TENANT_KEY",
    "NB_TENANT_ID",
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(FLEET_ENV_VARS.map((k) => [k, process.env[k]]));
    process.env.NB_FLEET_AUTHORIZER_TOKEN_URL = "http://fleet-authorizer.internal/token";
    process.env.NB_TENANT_ID = "tenant-a";
  });

  afterEach(() => {
    for (const k of FLEET_ENV_VARS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("refuses to build the routes when the fleet token endpoint is set without a tenant key", () => {
    delete process.env.NB_MCP_AUTHORIZER_TENANT_KEY;
    expect(() => makeApp(makeStubLifecycle())).toThrow(/NB_MCP_AUTHORIZER_TENANT_KEY/);
  });

  test("builds the routes when the tenant key is provisioned", () => {
    process.env.NB_MCP_AUTHORIZER_TENANT_KEY = randomBytes(32).toString("base64");
    expect(() => makeApp(makeStubLifecycle())).not.toThrow();
  });
});
