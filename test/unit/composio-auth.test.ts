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
  composioConnectionPath,
  readComposioConnection,
} from "../../src/bundles/composio-connection.ts";
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
}

function stubCtx(
  workDir: string,
  catalogEntry: ReturnType<typeof composioEntry> | null,
  options: { ensureSourceRegisteredError?: Error } = {},
): AppContext & { __lifecycleCalls: StubLifecycleCalls } {
  const calls: StubLifecycleCalls = {
    recordConnectionStateChange: { lastCall: null, callCount: 0 },
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
  test("writes connection.json AND transitions lifecycle state when cookie matches", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const entry = composioEntry("com.google/gmail");
      const ctx = stubCtx(dir, entry);
      const app = composioAuthRoutes(ctx);
      const nonce = "deadbeefdeadbeefdeadbeefdeadbeef";
      const wsId = "ws_test";
      const cid = "com.google/gmail";
      const cookieHash = sha256Hex(`${nonce}.${cid}.${wsId}`);

      const url =
        `http://nb.test/v1/composio-auth/callback?cid=${encodeURIComponent(cid)}` +
        `&ws=${wsId}&n=${nonce}&connected_account_id=ca_xyz&status=ACTIVE`;
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

  test("rejects when nonce cookie missing", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const entry = composioEntry("com.google/gmail");
      const app = composioAuthRoutes(stubCtx(dir, entry));
      const url =
        "http://nb.test/v1/composio-auth/callback?cid=com.google/gmail&ws=ws_test" +
        "&n=abc123&connected_account_id=ca_xyz&status=ACTIVE";
      const res = await app.request(url);
      expect(res.status).toBe(400);
      // No connection.json written.
      const path = composioConnectionPath(dir, { type: "workspace", wsId: "ws_test" }, "com.google/gmail");
      const { existsSync } = await import("node:fs");
      expect(existsSync(path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("rejects when nonce cookie does not match (wrong wsId)", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const entry = composioEntry("com.google/gmail");
      const app = composioAuthRoutes(stubCtx(dir, entry));
      // Cookie was bound to ws_real, but callback URL claims ws_attacker.
      const goodHash = sha256Hex("n.com.google/gmail.ws_real");
      const url =
        "http://nb.test/v1/composio-auth/callback?cid=com.google/gmail&ws=ws_attacker" +
        "&n=n&connected_account_id=ca_xyz&status=ACTIVE";
      const res = await app.request(url, {
        headers: { cookie: `nb_composio_state=${goodHash}` },
      });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("400s on missing required params", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const app = composioAuthRoutes(stubCtx(dir, composioEntry("com.google/gmail")));
      // Missing connectedAccountId.
      const res = await app.request(
        "http://nb.test/v1/composio-auth/callback?cid=com.google/gmail&ws=ws_test&n=abc",
      );
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("400s when the catalog entry is not composio-backed", async () => {
    const { dir, cleanup } = freshDir();
    try {
      // No matching catalog entry returned by stub.
      const app = composioAuthRoutes(stubCtx(dir, null));
      const nonce = "x";
      const wsId = "ws_test";
      const cid = "com.google/gmail";
      const cookieHash = sha256Hex(`${nonce}.${cid}.${wsId}`);
      const url =
        "http://nb.test/v1/composio-auth/callback?cid=com.google/gmail&ws=ws_test&n=x" +
        "&connected_account_id=ca_xyz&status=ACTIVE";
      const res = await app.request(url, {
        headers: { cookie: `nb_composio_state=${cookieHash}` },
      });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("rejects malformed cid (path-traversal substring) before reading cookie", async () => {
    // Bind a valid cookie hash for the malformed cid so the test fails
    // at the cid validation step rather than the session-mismatch step.
    // Without the cookie binding, this test would pass for the wrong
    // reason — verifying nothing about cid validation specifically.
    const { dir, cleanup } = freshDir();
    try {
      const app = composioAuthRoutes(stubCtx(dir, composioEntry("com.google/gmail")));
      const cid = "../escape";
      const nonce = "n";
      const wsId = "ws_test";
      const cookieHash = sha256Hex(`${nonce}.${cid}.${wsId}`);
      const url =
        "http://nb.test/v1/composio-auth/callback?cid=" +
        encodeURIComponent(cid) +
        `&ws=${wsId}&n=${nonce}&connected_account_id=ca_xyz`;
      const res = await app.request(url, {
        headers: { cookie: `nb_composio_state=${cookieHash}` },
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("invalid cid");
    } finally {
      cleanup();
    }
  });

  test("rejects cid containing `//` substring", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const app = composioAuthRoutes(stubCtx(dir, composioEntry("com.google/gmail")));
      const cid = "com//google/gmail";
      const nonce = "n";
      const wsId = "ws_test";
      const cookieHash = sha256Hex(`${nonce}.${cid}.${wsId}`);
      const url =
        "http://nb.test/v1/composio-auth/callback?cid=" +
        encodeURIComponent(cid) +
        `&ws=${wsId}&n=${nonce}&connected_account_id=ca_xyz`;
      const res = await app.request(url, {
        headers: { cookie: `nb_composio_state=${cookieHash}` },
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("invalid cid");
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
    // callback. The actual hash value is sha256(nonce.cid.ws); we
    // can't predict the nonce, so assert structural properties only.
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
