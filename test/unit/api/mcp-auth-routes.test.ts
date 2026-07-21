import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { securityHeaders } from "../../../src/api/middleware/security-headers.ts";
import { mcpAuthRoutes } from "../../../src/api/routes/mcp-auth.ts";
import type { AppContext, AppEnv } from "../../../src/api/types.ts";
import { ConnectorBusyError } from "../../../src/bundles/lifecycle.ts";
import { IdentityConnectorStore } from "../../../src/identity/connector-store.ts";
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
const WS_OWNER = { kind: "workspace", wsId: WS_ID } as const;
const USER_ID = "usr_test";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

interface StubLifecycle {
  /** Pre-canned URL the stub `startAuth` returns. Unset ⇒ throws; value `null` ⇒
   *  connected without an interactive flow (already authenticated). */
  authUrls: Map<string, string | null>; // key: "serverName|wsId|principalId"
  instances: Map<string, { oauthScope?: "workspace" | "user" }>; // key: "serverName|wsId"
  /** Pre-canned URL the stub `startIdentityAuth` returns. Unset ⇒ throws; value
   *  `null` ⇒ connected without an interactive flow (already authenticated).
   *  Key: "serverName|userId". */
  identityAuthUrls: Map<string, string | null>;
  getInstance(serverName: string, wsId: string): { oauthScope?: "workspace" | "user" } | null;
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
  const instances = new Map<string, { oauthScope?: "workspace" | "user" }>();
  return {
    authUrls,
    identityAuthUrls,
    instances,
    getInstance(serverName, wsId) {
      return instances.get(`${serverName}|${wsId}`) ?? null;
    },
    async startAuth(serverName, wsId, principalId) {
      const key = `${serverName}|${wsId}|${principalId}`;
      if (!authUrls.has(key)) throw new Error(`stub: no canned URL for ${key}`);
      return { authorizationUrl: authUrls.get(key) ?? null };
    },
    async startIdentityAuth(serverName, userId) {
      const key = `${serverName}|${userId}`;
      if (!identityAuthUrls.has(key)) throw new Error(`stub: no canned identity URL for ${key}`);
      return { authorizationUrl: identityAuthUrls.get(key) ?? null };
    },
  };
}

function makeApp(
  lifecycle: StubLifecycle,
  secureCookies = false,
  workDir = "/tmp/nb-test",
): Hono<AppEnv> {
  const ctx = {
    runtime: {
      getLifecycle: () => lifecycle,
      getWorkDir: () => workDir,
      getAllowInsecureRemotes: () => false,
      // Dev-mode: no real identity → the fixed test user.
      resolveRequestUserId: () => USER_ID,
    },
    // Dev-mode auth so requireAuth() passes through without an identity. No
    // identity → requireWorkspace() also passes through without setting
    // workspaceId. We set it ourselves in the wrapping middleware below.
    authOptions: { mode: { type: "dev" }, eventSink: { emit: () => {} } },
    workspaceStore: {},
    secureCookies,
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
    // secureCookies=false (dev) → no Secure flag
    expect(setCookie!).not.toContain("Secure");
  });

  test("adds Secure flag when secureCookies is set", async () => {
    lifecycle.instances.set(`granola|${WS_ID}`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(
      `granola|${WS_ID}|_workspace`,
      "https://granola.test/auth?state=s",
    );
    const prodApp = makeApp(lifecycle, /* secureCookies */ true);

    const res = await prodApp.request("http://api.example.com/v1/mcp-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")!).toContain("Secure");
  });

  test("returns { authorizationUrl: null, alreadyConnected: true } and no cookie when connected without interactive auth (#679)", async () => {
    // A provider-minted / already-authenticated source: startAuth resolves with no
    // URL (the source is now running). The route must report success — not a 500 —
    // and set no state cookie (there is no interactive flow to bind).
    lifecycle.instances.set(`minted|${WS_ID}`, { oauthScope: "workspace" });
    lifecycle.authUrls.set(`minted|${WS_ID}|_workspace`, null);

    const res = await app.request("http://localhost/v1/mcp-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "minted" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authorizationUrl).toBeNull();
    expect(body.alreadyConnected).toBe(true);
    expect(res.headers.get("Set-Cookie")).toBeNull();
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
    const flowPromise = registerFlow(state, WS_OWNER, "granola");
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

    // Redirect back to the workspace-scoped connectors page for the
    // workspace the flow was initiated in (WS_ID = "ws_test" → slug
    // "test"). The pre-scoping `/settings/workspace/connectors` path is
    // gone — landing there 404s now that connectors live under `/w/<slug>`.
    expect(html).toContain("/w/test/settings/connectors");
    expect(html).not.toContain("/settings/workspace/connectors");

    // Cookie cleared: Max-Age=0
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain("nb_oauth_state=");
    expect(setCookie!).toContain("Max-Age=0");

    // Flow resolved with the code we sent
    await expect(flowPromise).resolves.toBe("auth-code-1");
  });

  test("success page CSP allowlists the inline <style> by sha256, and survives the platform default-CSP middleware", async () => {
    // The platform default CSP is `default-src 'none'`, which blocks the
    // success page's inline `<style>`. The route therefore must set its
    // own CSP, and the security-headers middleware must respect it (per
    // its `if (!c.res.headers.has(...)) set` precedent). This test wires
    // the real middleware in front of the route and verifies both.
    const ctx = {
      runtime: {
        getLifecycle: () => lifecycle,
        getWorkDir: () => "/tmp/nb-test",
        getAllowInsecureRemotes: () => false,
      },
      authOptions: { mode: { type: "dev" }, eventSink: { emit: () => {} } },
      workspaceStore: {},
      secureCookies: false,
    } as unknown as AppContext;
    const wrapped = new Hono<AppEnv>();
    wrapped.use("*", securityHeaders());
    wrapped.use("*", async (c, next) => {
      c.set("workspaceId", WS_ID);
      await next();
    });
    wrapped.route("/", mcpAuthRoutes(ctx));

    const state = "csp-state";
    const flowPromise = registerFlow(state, WS_OWNER, "granola");
    flowPromise.catch(() => {});
    const cookie = `nb_oauth_state=${sha256Hex(state)}`;
    const res = await wrapped.request(
      `http://localhost/v1/mcp-auth/callback?code=auth-code-csp&state=${state}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).not.toBeNull();
    // The route-level CSP — not the platform default — must be on the
    // response. If this flips back to `default-src 'none'` with no
    // style-src, the success page renders unstyled.
    expect(csp!).toContain("style-src 'sha256-");
    // Extract the inline style block from the served HTML and verify the
    // CSP allowlists exactly its sha256. This pins the hash and the
    // served bytes together: any drift (template edit without re-running
    // tests) fails here before it ships as an unstyled page in prod.
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch).not.toBeNull();
    const servedStyleHash = createHash("sha256")
      .update(styleMatch![1])
      .digest("base64");
    expect(csp!).toContain(`'sha256-${servedStyleHash}'`);
    await expect(flowPromise).resolves.toBe("auth-code-csp");
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
    await expect(flowPromise).resolves.toBe("fallback");
  });

  test("mismatched cookie hash → 400 session mismatch, flow NOT resolved", async () => {
    const state = "mismatched-state";
    const flowPromise = registerFlow(state, WS_OWNER, "granola");
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
    process.env.NB_PLATFORM_HOST = `${TID}.platform.nimblebrain.ai`;
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

    const res = await app.request("http://localhost/v1/mcp-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "granola" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // The authorizationUrl returned to the client has the wrapped state
    // in place of the SDK-generated inner state.
    const parsed = new URL(body.authorizationUrl);
    const wireState = parsed.searchParams.get("state");
    expect(wireState).not.toBeNull();
    expect(wireState).not.toBe(innerState);
    expect(wireState!.startsWith("v1.")).toBe(true);

    // The cookie is keyed on the INNER state — the existing CSRF check
    // on /callback compares the cookie hash to the unwrapped inner.
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain(`nb_oauth_state=${sha256Hex(innerState)}`);
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

    const cookie = `nb_oauth_state=${sha256Hex(innerState)}`;
    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=auth-code-1&state=${encodeURIComponent(wireState)}`,
      { headers: { cookie } },
    );

    expect(res.status).toBe(200);
    await expect(flowPromise).resolves.toBe("auth-code-1");
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
    app = makeApp(lifecycle, false, workDir);
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
    expect((await res.json()).authorizationUrl).toContain("/authorize");
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain(`nb_oauth_state=${sha256Hex(state)}`);
    expect(setCookie!).toContain("Path=/v1/mcp-auth/callback");
  });

  test("connected without interactive auth → { authorizationUrl: null, alreadyConnected: true } and no cookie (#679)", async () => {
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
    const body = await res.json();
    expect(body.authorizationUrl).toBeNull();
    expect(body.alreadyConnected).toBe(true);
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
    expect((await res.json()).error).toBe("connector_busy");
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
    expect((await res.json()).error).toBe("connector_not_found");
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

  test("a user-owned flow lands the user on /profile/connectors (not a workspace page)", async () => {
    const state = "user-owned-state";
    const flowPromise = registerFlow(state, { kind: "user", userId: USER_ID }, "granola");
    flowPromise.catch(() => {});

    const res = await app.request(
      `http://localhost/v1/mcp-auth/callback?code=code-1&state=${state}`,
      { headers: { cookie: `nb_oauth_state=${sha256Hex(state)}` } },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/profile/connectors");
    // Never a workspace-scoped page for a personal connector.
    expect(html).not.toContain("/w/");
    await expect(flowPromise).resolves.toBe("code-1");
  });
});
