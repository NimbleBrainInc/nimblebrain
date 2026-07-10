import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

// ── @composio/core mock ─────────────────────────────────────────────
//
// Hoisted before the route file imports the SDK adapter — same
// pattern as composio-sdk.test.ts. Tests rewire `sdkCalls.*Impl` to
// drive specific behaviour. Without this, /initiate tests that
// exercise the adopt-existing path or the fresh-flow path would hit
// the real Composio API on a test run.
interface SdkCalls {
  listImpl: (q: unknown) => Promise<{ items?: Array<{ id?: unknown; status?: unknown }> }>;
  initiateImpl: (...args: unknown[]) => Promise<unknown>;
}
const sdkCalls: SdkCalls = {
  listImpl: async () => ({ items: [] }),
  initiateImpl: async () => ({
    redirectUrl: "https://connect.composio.dev/link/lk_default",
    id: "ca_default",
  }),
};
mock.module("@composio/core", () => ({
  Composio: class {
    connectedAccounts = {
      list: (q: unknown) => sdkCalls.listImpl(q),
      initiate: (...args: unknown[]) => sdkCalls.initiateImpl(...args),
      delete: async () => undefined,
    };
    create = async () => ({
      sessionId: "session_default",
      mcp: { type: "http", url: "https://composio.test/mcp/x", headers: { "x-api-key": "k" } },
    });
  },
}));

import type { AppContext, AppEnv } from "../../src/api/types.ts";
import { composioAuthRoutes } from "../../src/api/routes/composio-auth.ts";
import {
  _clearAllConnectFlows,
  registerConnectFlow,
} from "../../src/composio/connect-flow-registry.ts";
import {
  composioConnectionPath,
  readComposioConnection,
} from "../../src/bundles/composio-connection.ts";
import { slugifyServerName } from "../../src/bundles/paths.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import {
  _resetComposioConfigForTest,
  composioCallbackUrl,
  composioUserId,
} from "../../src/composio/sdk.ts";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Minimal AppContext stub. The composio-auth routes touch only the
 * runtime accessor for the connector directory + work dir, plus
 * `secureCookies` for cookie scoping. requireAuth + requireWorkspace
 * are not exercised by tests below (the callback and proxy routes
 * are unauthenticated by design; the initiate route is covered
 * separately by the helper-function tests).
 */
/**
 * Capturing record of the last `recordConnectionStateChange` call the
 * stub lifecycle observed. Tests assert against `.lastCall` to verify
 * the callback / initiate adopt paths actually flip the bundle's
 * persisted state — previously the callback's `try { ctx.runtime
 * .getLifecycle().recordConnectionStateChange(...) }` silently
 * swallowed the throw from a stub-missing-method test (the call was
 * never asserted, so a refactor dropping it would have gone
 * unnoticed). The stub now succeeds AND records what was called.
 */
interface StubLifecycleCalls {
  recordConnectionStateChange: {
    lastCall: {
      serverName: string;
      wsId: string;
      principalId: string;
      state: string;
    } | null;
    callCount: number;
  };
  // Identity-plane analog: the user-owner callback / adopt paths bring the
  // personal connector's source online via `getIdentityConnectorSource`
  // (there is no per-principal connection-state machine, so they do NOT call
  // `recordConnectionStateChange`). Captured so the identity tests can assert
  // the source-recovery call fires and the workspace-only state transition
  // does not.
  getIdentityConnectorSource: {
    lastCall: { userId: string; serverName: string } | null;
    callCount: number;
  };
}

function stubCtx(
  workDir: string,
  catalogEntry: ReturnType<typeof composioEntry> | null,
  options: {
    ensureSourceRegisteredError?: Error;
    getIdentityConnectorSourceError?: Error;
    userId?: string;
  } = {},
): AppContext & { __lifecycleCalls: StubLifecycleCalls } {
  const calls: StubLifecycleCalls = {
    recordConnectionStateChange: { lastCall: null, callCount: 0 },
    getIdentityConnectorSource: { lastCall: null, callCount: 0 },
  };
  const lifecycle = {
    recordConnectionStateChange(
      serverName: string,
      wsId: string,
      principalId: string,
      state: string,
    ): void {
      calls.recordConnectionStateChange.lastCall = { serverName, wsId, principalId, state };
      calls.recordConnectionStateChange.callCount++;
    },
    // The reconnect path (callback + initiate adopt) calls
    // `ensureSourceRegistered` before recording state to bring the
    // McpSource back up after a prior disconnect's
    // `teardownConnectionSource`. The stub no-ops by default; pass
    // `ensureSourceRegisteredError` to simulate a source-start
    // failure for the adopt-failure-path test.
    async ensureSourceRegistered(): Promise<void> {
      if (options.ensureSourceRegisteredError) {
        throw options.ensureSourceRegisteredError;
      }
    },
    // Identity-plane source holder: starts + registers a personal connector
    // into the user's registry from its persisted record. The real method
    // returns a source; the route only awaits it (ignores the return), so the
    // stub captures the call and resolves.
    async getIdentityConnectorSource(userId: string, serverName: string): Promise<void> {
      calls.getIdentityConnectorSource.lastCall = { userId, serverName };
      calls.getIdentityConnectorSource.callCount++;
      if (options.getIdentityConnectorSourceError) {
        throw options.getIdentityConnectorSourceError;
      }
    },
  };
  const runtime = {
    getConnectorDirectory() {
      return {
        catalogById: async (id: string) =>
          catalogEntry && catalogEntry.id === id ? catalogEntry : null,
      };
    },
    getWorkDir() {
      return workDir;
    },
    getLifecycle() {
      return lifecycle;
    },
    // The identity initiate route resolves the caller's user id from the
    // verified request identity. In dev-mode tests the identity is canned;
    // the stub returns a fixed id (overridable per test) so assertions can
    // pin the credential path / cookie-committed owner.
    resolveRequestUserId() {
      return options.userId ?? "usr_test";
    },
  } as unknown as AppContext["runtime"];

  return {
    runtime,
    workspaceStore: { get: async () => null } as unknown as AppContext["workspaceStore"],
    authOptions: {} as AppContext["authOptions"],
    secureCookies: false,
    __lifecycleCalls: calls,
  } as unknown as AppContext & { __lifecycleCalls: StubLifecycleCalls };
}

function composioEntry(id: string) {
  return {
    id,
    name: "Gmail",
    description: "test",
    iconUrl: "https://example.com/icon.png",
    url: "https://backend.composio.dev/v3/mcp/SERVER",
    auth: "composio" as const,
    composio: {
      toolkit: "gmail",
      authConfigEnv: "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
    },
  };
}

function freshDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nb-composio-auth-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("composioUserId", () => {
  const origTid = process.env.NB_TENANT_ID;
  afterEach(() => {
    if (origTid === undefined) delete process.env.NB_TENANT_ID;
    else process.env.NB_TENANT_ID = origTid;
  });

  test("returns wsId alone when NB_TENANT_ID is unset (single-tenant)", () => {
    delete process.env.NB_TENANT_ID;
    expect(composioUserId({ type: "workspace", wsId: "ws_01abc" })).toBe("ws_01abc");
  });

  test("prefixes tenant id when NB_TENANT_ID is set", () => {
    process.env.NB_TENANT_ID = "tenant-a";
    expect(composioUserId({ type: "workspace", wsId: "ws_01abc" })).toBe("tenant-a:ws_01abc");
  });

  test("trims whitespace on NB_TENANT_ID", () => {
    process.env.NB_TENANT_ID = "  tenant-b  ";
    expect(composioUserId({ type: "workspace", wsId: "ws_01abc" })).toBe("tenant-b:ws_01abc");
  });
});

describe("composioCallbackUrl", () => {
  const ENV_KEYS = [
    "NB_PUBLIC_ORIGIN",
    "NB_PLATFORM_HOST",
    "NB_CUSTOM_DOMAIN",
    "NB_CUSTOM_DOMAIN_CANONICAL",
    "NB_API_URL",
  ] as const;
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test("derives from the tenant public origin (platform host)", () => {
    process.env.NB_PLATFORM_HOST = "platform.example.test";
    expect(composioCallbackUrl()).toBe("https://platform.example.test/v1/composio-auth/callback");
  });

  test("derives from the custom domain when canonical", () => {
    process.env.NB_PLATFORM_HOST = "platform.example.test";
    process.env.NB_CUSTOM_DOMAIN = "brain.example.test";
    expect(composioCallbackUrl()).toBe("https://brain.example.test/v1/composio-auth/callback");
  });

  test("ignores legacy NB_API_URL (fallback removed) — falls back to localhost", () => {
    process.env.NB_API_URL = "https://platform.example.test";
    expect(composioCallbackUrl()).toBe("http://localhost:27247/v1/composio-auth/callback");
  });

  test("falls back to localhost when unset", () => {
    expect(composioCallbackUrl()).toBe("http://localhost:27247/v1/composio-auth/callback");
  });
});

describe("GET /v1/composio-auth/proxy", () => {
  // Proxy reads from `validateComposioConfig().baseUrl` (validated +
  // cached at startup). For the override to kick in, both
  // `COMPOSIO_API_KEY` and `COMPOSIO_API_BASE_URL` must be set —
  // without the key, validate falls back to the default base URL
  // because the integration is dormant. Reset the cache between
  // tests so each case gets a fresh validate pass.
  const origKey = process.env.COMPOSIO_API_KEY;
  const origBase = process.env.COMPOSIO_API_BASE_URL;
  beforeEach(() => {
    _resetComposioConfigForTest();
  });
  afterEach(() => {
    if (origKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = origKey;
    if (origBase === undefined) delete process.env.COMPOSIO_API_BASE_URL;
    else process.env.COMPOSIO_API_BASE_URL = origBase;
    _resetComposioConfigForTest();
  });

  test("302s to backend.composio.dev with query params preserved", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    delete process.env.COMPOSIO_API_BASE_URL;
    const app = composioAuthRoutes(stubCtx("/tmp/work", null));
    const res = await app.request(
      "http://nb.test/v1/composio-auth/proxy?code=abc&state=xyz&foo=bar",
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("https://backend.composio.dev/api/v3.1/toolkits/auth/callback")).toBe(
      true,
    );
    expect(loc.includes("code=abc")).toBe(true);
    expect(loc.includes("state=xyz")).toBe(true);
    expect(loc.includes("foo=bar")).toBe(true);
  });

  test("honors COMPOSIO_API_BASE_URL override (e.g. for self-hosted shim)", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_API_BASE_URL = "https://composio.example.com";
    const app = composioAuthRoutes(stubCtx("/tmp/work", null));
    const res = await app.request("http://nb.test/v1/composio-auth/proxy?code=abc");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://composio.example.com/api/v3.1/toolkits/auth/callback?code=abc",
    );
  });

  test("does not cache the redirect response", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    const app = composioAuthRoutes(stubCtx("/tmp/work", null));
    const res = await app.request("http://nb.test/v1/composio-auth/proxy?code=abc");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /v1/composio-auth/callback", () => {
  // The registry is module-level state shared across the process; clear it so
  // one test's pending flow can't leak into the next.
  beforeEach(_clearAllConnectFlows);

  test("writes connection.json AND transitions lifecycle state when the flow + cookie match", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const entry = composioEntry("com.google/gmail");
      const ctx = stubCtx(dir, entry);
      const app = composioAuthRoutes(ctx);
      const nonce = "deadbeefdeadbeefdeadbeefdeadbeef";
      const wsId = "ws_test";
      const cid = "com.google/gmail";
      // An authenticated /initiate registered this flow; the cookie is sha256(nonce).
      registerConnectFlow(nonce, { type: "workspace", wsId }, cid);
      const cookieHash = sha256Hex(nonce);

      const url =
        `http://nb.test/v1/composio-auth/callback?n=${nonce}` +
        "&connected_account_id=ca_xyz&status=ACTIVE";
      const res = await app.request(url, {
        headers: { cookie: `nb_composio_state=${cookieHash}` },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");

      // Redirect back to the workspace-scoped connectors page for the
      // workspace the connection landed in (ws_test → slug "test"), not the
      // pre-scoping `/settings/workspace/connectors` (which 404s now).
      const html = await res.text();
      expect(html).toContain("/w/test/settings/connectors");
      expect(html).not.toContain("/settings/workspace/connectors");

      const stored = await readComposioConnection(dir, { type: "workspace", wsId }, cid);
      expect(stored).not.toBeNull();
      expect(stored?.connectedAccountId).toBe("ca_xyz");
      expect(stored?.toolkit).toBe("gmail");
      expect(stored?.status).toBe("ACTIVE");

      // Lifecycle state transition is required — without it the UI
      // shows "Sign-in required" until the next platform restart even
      // though connection.json landed. Asserting the exact call shape
      // catches a refactor that drops the transition silently (the
      // route's `try/catch` would otherwise hide the regression).
      expect(ctx.__lifecycleCalls.recordConnectionStateChange.callCount).toBe(1);
      expect(ctx.__lifecycleCalls.recordConnectionStateChange.lastCall).toEqual({
        serverName: "com-google-gmail",
        wsId: "ws_test",
        principalId: "_workspace",
        state: "running",
      });

      // Cookie cleared so refresh of the success page can't replay.
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie.includes("nb_composio_state=")).toBe(true);
      expect(setCookie.includes("Max-Age=0")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("forged cookie without a server-side flow is rejected — no cross-owner write", async () => {
    // The reported vulnerability: the callback is unauthenticated and the
    // `nb_composio_state` cookie was a bare sha256 of values the caller already
    // knows, so anyone could author it and drop a connection.json under a
    // victim's credential root. The server-side flow record — creatable only by
    // an authenticated /initiate — is the real gate. Here NO flow is registered;
    // a self-authored cookie must not land a connection.
    const { dir, cleanup } = freshDir();
    try {
      const app = composioAuthRoutes(stubCtx(dir, composioEntry("com.google/gmail")));
      const nonce = "0123456789abcdef0123456789abcdef";
      const victim = "usr_victim";
      // Attacker computes the cookie themselves — it commits to nothing secret.
      const forgedCookie = sha256Hex(nonce);
      const url =
        `http://nb.test/v1/composio-auth/callback?n=${nonce}&usr=${victim}` +
        "&connected_account_id=ca_attacker&status=ACTIVE";
      const res = await app.request(url, {
        headers: { cookie: `nb_composio_state=${forgedCookie}` },
      });

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Unknown or expired");
      // Nothing written for the victim — the owner comes from the absent record,
      // and the legacy `usr=` query param is ignored entirely.
      const { existsSync } = await import("node:fs");
      expect(
        existsSync(
          composioConnectionPath(dir, { type: "user", userId: victim }, "com.google/gmail"),
        ),
      ).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("rejects when nonce cookie missing, even with a registered flow", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const app = composioAuthRoutes(stubCtx(dir, composioEntry("com.google/gmail")));
      const nonce = "abc123abc123abc123abc123abc123ab";
      registerConnectFlow(nonce, { type: "workspace", wsId: "ws_test" }, "com.google/gmail");
      const url =
        `http://nb.test/v1/composio-auth/callback?n=${nonce}` +
        "&connected_account_id=ca_xyz&status=ACTIVE";
      const res = await app.request(url); // no cookie
      expect(res.status).toBe(400);
      const path = composioConnectionPath(
        dir,
        { type: "workspace", wsId: "ws_test" },
        "com.google/gmail",
      );
      const { existsSync } = await import("node:fs");
      expect(existsSync(path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("rejects when the cookie does not hash to the nonce", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const app = composioAuthRoutes(stubCtx(dir, composioEntry("com.google/gmail")));
      const nonce = "feedfacefeedfacefeedfacefeedface";
      registerConnectFlow(nonce, { type: "workspace", wsId: "ws_test" }, "com.google/gmail");
      const wrongCookie = sha256Hex("some-other-nonce");
      const url =
        `http://nb.test/v1/composio-auth/callback?n=${nonce}` +
        "&connected_account_id=ca_xyz&status=ACTIVE";
      const res = await app.request(url, {
        headers: { cookie: `nb_composio_state=${wrongCookie}` },
      });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("400s on missing required params (no connectedAccountId)", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const app = composioAuthRoutes(stubCtx(dir, composioEntry("com.google/gmail")));
      const nonce = "abcabcabcabcabcabcabcabcabcabcab";
      registerConnectFlow(nonce, { type: "workspace", wsId: "ws_test" }, "com.google/gmail");
      const res = await app.request(`http://nb.test/v1/composio-auth/callback?n=${nonce}`, {
        headers: { cookie: `nb_composio_state=${sha256Hex(nonce)}` },
      });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("400s when the catalog entry is not composio-backed", async () => {
    const { dir, cleanup } = freshDir();
    try {
      // Stub returns no catalog entry.
      const app = composioAuthRoutes(stubCtx(dir, null));
      const nonce = "1111111111111111111111111111111a";
      registerConnectFlow(nonce, { type: "workspace", wsId: "ws_test" }, "com.google/gmail");
      const url =
        `http://nb.test/v1/composio-auth/callback?n=${nonce}` +
        "&connected_account_id=ca_xyz&status=ACTIVE";
      const res = await app.request(url, {
        headers: { cookie: `nb_composio_state=${sha256Hex(nonce)}` },
      });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });
});

// ── POST /v1/composio-auth/initiate ──────────────────────────────────
//
// Route-level tests for the initiate endpoint. Mirrors the
// dev-mode-auth + workspace-injection pattern from
// test/unit/api/mcp-auth-routes.test.ts so the route's CORS / cookie /
// adopt-existing logic is covered without standing up the real auth
// middleware. The Composio SDK is mocked at the module boundary
// (top of this file) — tests rewire `sdkCalls.*Impl` to drive
// list-returns-active vs list-empty behaviour.

describe("POST /v1/composio-auth/initiate", () => {
  const WS_ID = "ws_test";
  const savedEnv: Record<string, string | undefined> = {};
  const TRACKED = [
    "COMPOSIO_API_KEY",
    "COMPOSIO_API_BASE_URL",
    "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
    "NB_TENANT_ID",
    "NB_API_URL",
    "NB_WEB_URL",
  ];

  beforeEach(() => {
    for (const k of TRACKED) savedEnv[k] = process.env[k];
    for (const k of TRACKED) delete process.env[k];
    _resetComposioConfigForTest();
    sdkCalls.listImpl = async () => ({ items: [] });
    sdkCalls.initiateImpl = async () => ({
      redirectUrl: "https://connect.composio.dev/link/lk_test",
      id: "ca_test",
    });
  });

  afterEach(() => {
    for (const k of TRACKED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    _resetComposioConfigForTest();
  });

  /**
   * Build a Hono app with workspace pre-set via a wrapping middleware
   * (matches mcp-auth-routes.test.ts pattern). The route's own
   * `requireAuth(authOptions)` + `requireWorkspace(workspaceStore)`
   * middleware land after this and are no-ops in dev mode with our
   * canned context.
   */
  function makeApp(catalogEntry: ReturnType<typeof composioEntry> | null): {
    app: Hono<AppEnv>;
    ctx: ReturnType<typeof stubCtx>;
  } {
    const ctx = stubCtx("/tmp/nb-initiate-test", catalogEntry);
    // Override authOptions with a dev-mode shape so requireAuth passes
    // through. The unknown cast is unavoidable — the AuthMiddlewareOptions
    // type isn't exported broadly and the runtime check just needs
    // `mode.type === "dev"`.
    (ctx as unknown as { authOptions: unknown }).authOptions = {
      mode: { type: "dev" },
      eventSink: { emit: () => {} },
    };
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("workspaceId", WS_ID);
      await next();
    });
    app.route("/", composioAuthRoutes(ctx));
    return { app, ctx };
  }

  test("(a) happy path: fresh flow returns redirect URL + binds nonce cookie", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail_test";
    sdkCalls.listImpl = async () => ({ items: [] }); // no existing connection
    sdkCalls.initiateImpl = async () => ({
      redirectUrl: "https://connect.composio.dev/link/lk_42",
      id: "ca_pending",
    });

    const { app } = makeApp(composioEntry("com.google/gmail"));
    const res = await app.request("http://nb.test/v1/composio-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "com.google/gmail" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authorizationUrl: string;
      alreadyConnected?: boolean;
    };
    expect(body.authorizationUrl).toBe("https://connect.composio.dev/link/lk_42");
    expect(body.alreadyConnected).toBeUndefined();

    // Cookie shape: HttpOnly + SameSite=Lax + path-scoped to the
    // callback. The actual hash value is sha256(nonce); we can't
    // predict the nonce, so assert structural properties only.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.includes("nb_composio_state=")).toBe(true);
    expect(setCookie.includes("HttpOnly")).toBe(true);
    expect(setCookie.includes("SameSite=Lax")).toBe(true);
    expect(setCookie.includes("Path=/v1/composio-auth/callback")).toBe(true);
  });

  test("(b) adopt-existing: short-circuits OAuth, writes connection.json, no nonce cookie", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail_test";
    // Existing ACTIVE account at Composio (e.g. from the chat-side
    // prompt flow or a prior install). Adopt path takes over.
    sdkCalls.listImpl = async () => ({
      items: [{ id: "ca_already_active", status: "ACTIVE" }],
    });
    // initiate should NEVER be called in this branch — fail the test
    // loudly if it is, instead of silently passing.
    sdkCalls.initiateImpl = async () => {
      throw new Error("adopt-existing path should not call connectedAccounts.initiate");
    };

    // Spy on saveComposioConnection by inspecting the filesystem after.
    const dir = mkdtempSync(join(tmpdir(), "nb-adopt-"));
    try {
      const ctx = stubCtx(dir, composioEntry("com.google/gmail"));
      (ctx as unknown as { authOptions: unknown }).authOptions = {
        mode: { type: "dev" },
        eventSink: { emit: () => {} },
      };
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("workspaceId", WS_ID);
        await next();
      });
      app.route("/", composioAuthRoutes(ctx));

      const res = await app.request("http://nb.test/v1/composio-auth/initiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectorId: "com.google/gmail" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        authorizationUrl: string;
        alreadyConnected?: boolean;
      };
      expect(body.alreadyConnected).toBe(true);

      // connection.json landed on disk under the existing account id.
      const stored = await readComposioConnection(dir, { type: "workspace", wsId: WS_ID }, "com.google/gmail");
      expect(stored?.connectedAccountId).toBe("ca_already_active");
      expect(stored?.toolkit).toBe("gmail");

      // Lifecycle state was transitioned to running so the UI flips
      // without waiting for restart. Captured by the stubCtx mock.
      expect(ctx.__lifecycleCalls.recordConnectionStateChange.lastCall?.state).toBe("running");

      // No fresh nonce cookie — there's no return-leg to verify.
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie.includes("nb_composio_state=")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(b2) adopt-existing: source-register failure returns 502 and leaves connection.json absent", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail_test";
    sdkCalls.listImpl = async () => ({
      items: [{ id: "ca_already_active", status: "ACTIVE" }],
    });
    sdkCalls.initiateImpl = async () => {
      throw new Error("adopt-failure path should not call connectedAccounts.initiate");
    };

    const dir = mkdtempSync(join(tmpdir(), "nb-adopt-fail-"));
    try {
      // Force ensureSourceRegistered to throw so we exercise the
      // failure path: contract is that connection.json must NOT be
      // written (so the next retry runs a clean adopt-existing) and
      // the SPA receives an honest error, not a misleading success.
      const ctx = stubCtx(dir, composioEntry("com.google/gmail"), {
        ensureSourceRegisteredError: new Error("startBundleSource refused"),
      });
      (ctx as unknown as { authOptions: unknown }).authOptions = {
        mode: { type: "dev" },
        eventSink: { emit: () => {} },
      };
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("workspaceId", WS_ID);
        await next();
      });
      app.route("/", composioAuthRoutes(ctx));

      const res = await app.request("http://nb.test/v1/composio-auth/initiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectorId: "com.google/gmail" }),
      });

      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("composio_adopt_source_start_failed");

      // connection.json must NOT be on disk — that's the whole point
      // of the reorder. A "connected" state marker without a running
      // source is exactly the lie the previous code was telling.
      const stored = await readComposioConnection(dir, { type: "workspace", wsId: WS_ID }, "com.google/gmail");
      expect(stored).toBeNull();

      // recordConnectionStateChange must NOT have been called either
      // (no lying about state in-memory, just as none on disk).
      expect(ctx.__lifecycleCalls.recordConnectionStateChange.callCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(c) returns 500 when COMPOSIO_API_KEY is unset", async () => {
    // No COMPOSIO_API_KEY in env. Per-toolkit env is set so we know
    // the failure is API-key-specific, not env-config-specific.
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail_test";

    const { app } = makeApp(composioEntry("com.google/gmail"));
    const res = await app.request("http://nb.test/v1/composio-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "com.google/gmail" }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("composio_unconfigured");
  });

  test("(d) returns 500 when per-toolkit auth-config env is unset", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    // COMPOSIO_GMAIL_AUTH_CONFIG_ID intentionally unset.

    const { app } = makeApp(composioEntry("com.google/gmail"));
    const res = await app.request("http://nb.test/v1/composio-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "com.google/gmail" }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("composio_unconfigured");
  });

  test("(e) returns 400 wrong_auth_kind when catalog entry isn't composio-backed", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail_test";
    // Catalog entry exists but its auth kind is `dcr` — the request
    // is well-formed but the connector is the wrong type for this
    // endpoint. /v1/mcp-auth/initiate is the right destination.
    const entry = {
      id: "com.example/native",
      name: "Native",
      description: "test",
      iconUrl: "https://example.com/icon.png",
      url: "https://mcp.example.com/mcp",
      auth: "dcr" as const,
    };
    const { app } = makeApp(entry as unknown as ReturnType<typeof composioEntry>);
    const res = await app.request("http://nb.test/v1/composio-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "com.example/native" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("wrong_auth_kind");
  });

  test("(f) returns 400 bad_request when connectorId is malformed", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail_test";

    const { app } = makeApp(composioEntry("com.google/gmail"));
    // `..` substring rejected by isValidConnectorId — defense-in-depth
    // against catalog ids carrying path-traversal markers even though
    // connectorSlug would also disarm them downstream.
    const res = await app.request("http://nb.test/v1/composio-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "../escape" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("returns 404 connector_not_found when catalog has no entry", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail_test";

    const { app } = makeApp(null); // empty catalog
    const res = await app.request("http://nb.test/v1/composio-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "com.google/gmail" }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("connector_not_found");
  });

  test("returns 400 bad_request on non-JSON body", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";

    const { app } = makeApp(composioEntry("com.google/gmail"));
    const res = await app.request("http://nb.test/v1/composio-auth/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });
});

// ── POST /v1/composio-auth/initiate-identity ─────────────────────────
//
// The identity-plane sibling of /initiate: connect a PERSONAL Composio
// connector on the caller's own identity, with NO workspace in context.
// Same dev-mode-auth pattern as the /initiate describe, minus the
// workspace-injection middleware — the route has `requireAuth` but not
// `requireWorkspace`, so it resolves its owner from the verified identity,
// never from a focused workspace. These tests are the identity analog of
// the /initiate happy-path + adopt-existing cases; the workspace path
// above is left byte-identical (the shared `connectComposio` helper only
// varies on `owner`).
describe("POST /v1/composio-auth/initiate-identity", () => {
  const USER_ID = "usr_test";
  const savedEnv: Record<string, string | undefined> = {};
  const TRACKED = [
    "COMPOSIO_API_KEY",
    "COMPOSIO_API_BASE_URL",
    "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
    "NB_TENANT_ID",
    "NB_API_URL",
    "NB_WEB_URL",
  ];

  beforeEach(() => {
    for (const k of TRACKED) savedEnv[k] = process.env[k];
    for (const k of TRACKED) delete process.env[k];
    _resetComposioConfigForTest();
    sdkCalls.listImpl = async () => ({ items: [] });
    sdkCalls.initiateImpl = async () => ({
      redirectUrl: "https://connect.composio.dev/link/lk_identity",
      id: "ca_identity",
    });
  });

  afterEach(() => {
    for (const k of TRACKED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    _resetComposioConfigForTest();
  });

  async function makeIdentityApp(
    catalogEntry: ReturnType<typeof composioEntry> | null,
    dir = "/tmp/nb-initiate-identity-test",
    opts: { seedInstall?: boolean } = {},
  ): Promise<{ app: Hono<AppEnv>; ctx: ReturnType<typeof stubCtx> }> {
    const ctx = stubCtx(dir, catalogEntry, { userId: USER_ID });
    (ctx as unknown as { authOptions: unknown }).authOptions = {
      mode: { type: "dev" },
      eventSink: { emit: () => {} },
    };
    // A personal connector must be installed on the identity before it can be
    // connected; seed the install ref so the route's precheck passes (skip it to
    // exercise the not-installed path).
    if (opts.seedInstall !== false && catalogEntry) {
      await new IdentityConnectorStore({ workDir: dir }).add(USER_ID, {
        url: `https://mcp.example.com/${slugifyServerName(catalogEntry.id)}`,
        serverName: slugifyServerName(catalogEntry.id),
        ui: null,
      });
    }
    const app = new Hono<AppEnv>();
    // No workspace-injection middleware — proves the route needs no workspace.
    app.route("/", composioAuthRoutes(ctx));
    return { app, ctx };
  }

  test("(a) fresh flow: drives Composio with the user identity, carries only the nonce, binds the cookie", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail_test";
    sdkCalls.listImpl = async () => ({ items: [] }); // no existing connection
    let initiateArgs: unknown[] = [];
    sdkCalls.initiateImpl = async (...args: unknown[]) => {
      initiateArgs = args;
      return { redirectUrl: "https://connect.composio.dev/link/lk_identity", id: "ca_identity" };
    };

    const { app } = await makeIdentityApp(composioEntry("com.google/gmail"));
    const res = await app.request("http://nb.test/v1/composio-auth/initiate-identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "com.google/gmail" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizationUrl: string; alreadyConnected?: boolean };
    expect(body.authorizationUrl).toBe("https://connect.composio.dev/link/lk_identity");
    expect(body.alreadyConnected).toBeUndefined();

    // Composio-side identity is the USER namespace (`user:<id>`), never a
    // workspace — single-tenant here (NB_TENANT_ID unset), so no tenant prefix.
    expect(initiateArgs[0]).toBe("user:usr_test");
    expect(initiateArgs[0]).toBe(composioUserId({ type: "user", userId: USER_ID }));

    // The callback URL carries only the nonce — the owner (user vs workspace)
    // and connector live in the server-side flow record, not the query, so the
    // vendor return leg can't be steered to a different owner.
    const cbUrl = new URL((initiateArgs[2] as { callbackUrl: string }).callbackUrl);
    const nonce = cbUrl.searchParams.get("n") ?? "";
    expect(nonce.length).toBeGreaterThan(0);
    expect(cbUrl.searchParams.get("usr")).toBeNull();
    expect(cbUrl.searchParams.get("ws")).toBeNull();
    expect(cbUrl.searchParams.get("cid")).toBeNull();

    // Cookie binds the nonce to this browser session (sha256(nonce)).
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.includes("HttpOnly")).toBe(true);
    expect(setCookie.includes("SameSite=Lax")).toBe(true);
    expect(setCookie.includes("Path=/v1/composio-auth/callback")).toBe(true);
    const cookieHash = /nb_composio_state=([0-9a-f]{64})/.exec(setCookie)?.[1];
    expect(cookieHash).toBe(sha256Hex(nonce));
  });

  test("(b) adopt-existing: writes connection.json under the user root, no workspace state transition", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail_test";
    sdkCalls.listImpl = async () => ({ items: [{ id: "ca_user_active", status: "ACTIVE" }] });
    sdkCalls.initiateImpl = async () => {
      throw new Error("adopt-existing path should not call connectedAccounts.initiate");
    };

    const dir = mkdtempSync(join(tmpdir(), "nb-adopt-identity-"));
    try {
      const { app, ctx } = await makeIdentityApp(composioEntry("com.google/gmail"), dir);
      const res = await app.request("http://nb.test/v1/composio-auth/initiate-identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectorId: "com.google/gmail" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { authorizationUrl: string; alreadyConnected?: boolean };
      expect(body.alreadyConnected).toBe(true);
      // Navigates back to the identity connectors surface, not a workspace one.
      expect(body.authorizationUrl).toContain("/profile/connectors");

      // connection.json landed under the USER credential root.
      const owner = { type: "user", userId: USER_ID } as const;
      const stored = await readComposioConnection(dir, owner, "com.google/gmail");
      expect(stored?.connectedAccountId).toBe("ca_user_active");
      expect(stored?.toolkit).toBe("gmail");
      const path = composioConnectionPath(dir, owner, "com.google/gmail");
      expect(path.includes(join("users", USER_ID, "credentials", "composio"))).toBe(true);

      // Identity source brought online; NO workspace-only state transition
      // (there is no per-principal connection-state machine on the identity plane).
      expect(ctx.__lifecycleCalls.getIdentityConnectorSource.callCount).toBe(1);
      expect(ctx.__lifecycleCalls.getIdentityConnectorSource.lastCall).toEqual({
        userId: USER_ID,
        serverName: "com-google-gmail",
      });
      expect(ctx.__lifecycleCalls.recordConnectionStateChange.callCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(c) 404 connector_not_found when the connector isn't installed on the identity", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_gmail_test";
    const dir = mkdtempSync(join(tmpdir(), "nb-identity-not-installed-"));
    try {
      // Valid catalog entry, but NO install ref seeded → the precheck rejects,
      // mirroring the OAuth identity initiate. Prevents a connect-before-install
      // dangling connection.json.
      const { app } = await makeIdentityApp(composioEntry("com.google/gmail"), dir, {
        seedInstall: false,
      });
      const res = await app.request("http://nb.test/v1/composio-auth/initiate-identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectorId: "com.google/gmail" }),
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("connector_not_found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /v1/composio-auth/callback — identity (user) owner", () => {
  beforeEach(_clearAllConnectFlows);

  test("persists under the user root, recovers the identity source, returns to /profile/connectors", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const entry = composioEntry("com.google/gmail");
      const ctx = stubCtx(dir, entry);
      const app = composioAuthRoutes(ctx);
      const nonce = "deadbeefdeadbeefdeadbeefdeadbeef";
      const userId = "usr_test";
      const cid = "com.google/gmail";
      // An authenticated /initiate-identity registered this user-owned flow.
      registerConnectFlow(nonce, { type: "user", userId }, cid);
      const cookieHash = sha256Hex(nonce);

      const url =
        `http://nb.test/v1/composio-auth/callback?n=${nonce}` +
        "&connected_account_id=ca_user&status=ACTIVE";
      const res = await app.request(url, {
        headers: { cookie: `nb_composio_state=${cookieHash}` },
      });

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("/profile/connectors");
      // Never a workspace connectors URL for an identity connection.
      expect(html).not.toContain("/settings/connectors");

      const owner = { type: "user", userId } as const;
      const stored = await readComposioConnection(dir, owner, cid);
      expect(stored?.connectedAccountId).toBe("ca_user");
      expect(stored?.toolkit).toBe("gmail");
      expect(stored?.status).toBe("ACTIVE");
      const path = composioConnectionPath(dir, owner, cid);
      expect(path.includes(join("users", userId, "credentials", "composio"))).toBe(true);

      // Identity source recovered; NO per-principal workspace state transition.
      expect(ctx.__lifecycleCalls.getIdentityConnectorSource.callCount).toBe(1);
      expect(ctx.__lifecycleCalls.getIdentityConnectorSource.lastCall).toEqual({
        userId,
        serverName: "com-google-gmail",
      });
      expect(ctx.__lifecycleCalls.recordConnectionStateChange.callCount).toBe(0);

      // One-shot cookie cleared on success.
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie.includes("Max-Age=0")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("owner comes from the record, not the query — a spoofed usr= param is ignored", async () => {
    // The owner is whatever the authenticated /initiate registered, not what the
    // vendor return carries. Here a workspace flow is registered; a
    // `usr=usr_attacker` query param must not divert the write to a user root.
    const { dir, cleanup } = freshDir();
    try {
      const ctx = stubCtx(dir, composioEntry("com.google/gmail"));
      const app = composioAuthRoutes(ctx);
      const nonce = "cafecafecafecafecafecafecafecafe";
      registerConnectFlow(nonce, { type: "workspace", wsId: "ws_real" }, "com.google/gmail");
      const url =
        `http://nb.test/v1/composio-auth/callback?n=${nonce}&usr=usr_attacker` +
        "&connected_account_id=ca_xyz&status=ACTIVE";
      const res = await app.request(url, {
        headers: { cookie: `nb_composio_state=${sha256Hex(nonce)}` },
      });

      expect(res.status).toBe(200);
      const { existsSync } = await import("node:fs");
      // Nothing under the spoofed attacker user.
      expect(
        existsSync(
          composioConnectionPath(dir, { type: "user", userId: "usr_attacker" }, "com.google/gmail"),
        ),
      ).toBe(false);
      // The connection landed under the registered workspace owner.
      const stored = await readComposioConnection(
        dir,
        { type: "workspace", wsId: "ws_real" },
        "com.google/gmail",
      );
      expect(stored?.connectedAccountId).toBe("ca_xyz");
    } finally {
      cleanup();
    }
  });
});
