import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mcpAuthRoutes } from "../../../src/api/routes/mcp-auth.ts";
import type { AppContext, AppEnv } from "../../../src/api/types.ts";
import { _clearAll, register as registerFlow } from "../../../src/tools/oauth-flow-registry.ts";

/**
 * Unit coverage for `mcpAuthRoutes` — the route is the security boundary
 * for interactive OAuth (cookie-bound state, single-use flow registry, no-
 * cache headers). The provider, lifecycle, and registry all have their own
 * tests; this file covers the route-handler logic directly.
 *
 * The middleware (`requireAuth`, `requireWorkspace`) is bypassed by setting
 * `c.var.workspaceId` from a parent app. We're testing the route's cookie
 * binding, not the auth/workspace middleware (which has its own tests).
 */

const WS_ID = "ws_test";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

interface StubLifecycle {
  /** Pre-canned URL the stub `startAuth` returns. Undefined ⇒ throws. */
  authUrls: Map<string, string>; // key: "serverName|wsId|principalId"
  instances: Map<string, { oauthScope?: "workspace" | "user" }>; // key: "serverName|wsId"
  getInstance(serverName: string, wsId: string): { oauthScope?: "workspace" | "user" } | null;
  startAuth(
    serverName: string,
    wsId: string,
    principalId: string,
    opts: { workDir: string; callbackUrl: string; allowInsecureRemotes?: boolean },
  ): Promise<{ authorizationUrl: string }>;
}

function makeStubLifecycle(): StubLifecycle {
  const authUrls = new Map<string, string>();
  const instances = new Map<string, { oauthScope?: "workspace" | "user" }>();
  return {
    authUrls,
    instances,
    getInstance(serverName, wsId) {
      return instances.get(`${serverName}|${wsId}`) ?? null;
    },
    async startAuth(serverName, wsId, principalId) {
      const url = authUrls.get(`${serverName}|${wsId}|${principalId}`);
      if (!url) throw new Error(`stub: no canned URL for ${serverName}|${wsId}|${principalId}`);
      return { authorizationUrl: url };
    },
  };
}

function makeApp(lifecycle: StubLifecycle, isLocalhost = true): Hono<AppEnv> {
  const ctx = {
    runtime: {
      getLifecycle: () => lifecycle,
      getWorkDir: () => "/tmp/nb-test",
      getAllowInsecureRemotes: () => false,
    },
    // Dev-mode auth so requireAuth() passes through without an identity. No
    // identity → requireWorkspace() also passes through without setting
    // workspaceId. We set it ourselves in the wrapping middleware below.
    authOptions: { mode: { type: "dev" }, eventSink: { emit: () => {} } },
    workspaceStore: {},
    isLocalhost,
  } as unknown as AppContext;

  const app = new Hono<AppEnv>();
  // Bypass the workspace middleware by pre-setting the var. The route's own
  // requireWorkspace middleware (in dev mode) is a no-op.
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS_ID);
    await next();
  });
  app.route("/", mcpAuthRoutes(ctx));
  return app;
}

describe("POST /v1/mcp-auth/initiate", () => {
  let app: Hono<AppEnv>;
  let lifecycle: StubLifecycle;

  beforeEach(() => {
    lifecycle = makeStubLifecycle();
    app = makeApp(lifecycle);
  });

  test("sets session-bound state cookie and returns the authorization URL", async () => {
    const state = "abc-123-def";
    const authUrl = `https://granola.test/oauth/authorize?state=${state}&client_id=cid`;
    lifecycle.instances.set(`granola|${WS_ID}`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(`granola|${WS_ID}|_workspace`, authUrl);

    const res = await app.request("http://localhost/v1/mcp-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authorizationUrl).toBe(authUrl);

    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain(`nb_oauth_state=${sha256Hex(state)}`);
    expect(setCookie!).toContain("HttpOnly");
    expect(setCookie!).toContain("SameSite=Lax");
    expect(setCookie!).toContain("Path=/v1/mcp-auth/callback");
    expect(setCookie!).toContain("Max-Age=900");
    // Localhost = no Secure flag
    expect(setCookie!).not.toContain("Secure");
  });

  test("adds Secure flag when not on localhost", async () => {
    lifecycle.instances.set(`granola|${WS_ID}`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(
      `granola|${WS_ID}|_workspace`,
      "https://granola.test/auth?state=s",
    );
    const prodApp = makeApp(lifecycle, /* isLocalhost */ false);

    const res = await prodApp.request("http://api.example.com/v1/mcp-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")!).toContain("Secure");
  });

  test("returns 404 with no cookie when bundle is not installed", async () => {
    const res = await app.request("http://localhost/v1/mcp-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "no-such-bundle" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("bundle_not_found");
    // No cookie should be set when no flow exists.
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  test("returns 400 on missing serverName", async () => {
    const res = await app.request("http://localhost/v1/mcp-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });

  test("returns 400 on non-JSON body", async () => {
    const res = await app.request("http://localhost/v1/mcp-auth/initiate", {
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
    lifecycle.authUrls.set(
      `bad|${WS_ID}|_workspace`,
      "https://granola.test/auth?client_id=x",
    );

    const res = await app.request("http://localhost/v1/mcp-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "bad" }),
    });
    expect(res.status).toBe(500);
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
    const flowPromise = registerFlow(state, WS_ID, "granola");
    // Attach a no-op catch so a test failure doesn't leak an unhandled
    // rejection if the assertion path bails before consuming flowPromise.
    flowPromise.catch(() => {});

    const cookie = `nb_oauth_state=${sha256Hex(state)}`;
    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=auth-code-1&state=${state}`,
      { headers: { cookie } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Authorization complete");

    // Cookie cleared: Max-Age=0
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain("nb_oauth_state=");
    expect(setCookie!).toContain("Max-Age=0");

    // Flow resolved with the code we sent
    await expect(flowPromise).resolves.toBe("auth-code-1");
  });

  test("missing cookie → 400 session mismatch, flow NOT resolved", async () => {
    const state = "no-cookie-state";
    const flowPromise = registerFlow(state, WS_ID, "granola");
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
    await expect(flowPromise).resolves.toBe("fallback");
  });

  test("mismatched cookie hash → 400 session mismatch, flow NOT resolved", async () => {
    const state = "mismatched-state";
    const flowPromise = registerFlow(state, WS_ID, "granola");
    flowPromise.catch(() => {});

    // Cookie is sha256(some-other-state), not sha256(state) — the timing-safe
    // comparison must reject.
    const wrongCookie = `nb_oauth_state=${sha256Hex("some-other-state")}`;
    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=c&state=${state}`,
      { headers: { cookie: wrongCookie } },
    );

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Authorization session mismatch");

    const { resolveWithCode } = await import("../../../src/tools/oauth-flow-registry.ts");
    expect(resolveWithCode(state, "fallback")).toBe(true);
    await expect(flowPromise).resolves.toBe("fallback");
  });

  test("matching cookie but flow not in registry → 404 unknown flow", async () => {
    // Race window: cookie matches, but the registry never had this state
    // (or it timed out). Surface as 404, not 200 — we never resolved a flow.
    const state = "ghost-state";
    const cookie = `nb_oauth_state=${sha256Hex(state)}`;

    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=c&state=${state}`,
      { headers: { cookie } },
    );

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
    const res = await app.request(
      "http://localhost/v1/mcp-auth/callback?code=x&state=y",
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Pragma")).toBe("no-cache");
  });
});
