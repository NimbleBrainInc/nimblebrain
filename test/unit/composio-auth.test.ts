import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composioAuthRoutes } from "../../src/api/routes/composio-auth.ts";
import { composioCallbackUrl, composioUserId } from "../../src/composio/sdk.ts";
import {
  composioConnectionPath,
  readComposioConnection,
} from "../../src/bundles/composio-connection.ts";
import type { AppContext } from "../../src/api/types.ts";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Minimal AppContext stub. The composio-auth routes touch only the
 * runtime accessor for the connector directory + work dir, plus
 * `isLocalhost` for cookie scoping. requireAuth + requireWorkspace
 * are not exercised by tests below (the callback and proxy routes
 * are unauthenticated by design; the initiate route is covered
 * separately by the helper-function tests).
 */
function stubCtx(
  workDir: string,
  catalogEntry: ReturnType<typeof composioEntry> | null,
): AppContext {
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
  } as unknown as AppContext["runtime"];

  return {
    runtime,
    workspaceStore: { get: async () => null } as unknown as AppContext["workspaceStore"],
    authOptions: {} as AppContext["authOptions"],
    isLocalhost: true,
  } as unknown as AppContext;
}

function composioEntry(id: string) {
  return {
    id,
    name: "Gmail",
    description: "test",
    iconUrl: "https://example.com/icon.png",
    url: "https://backend.composio.dev/v3/mcp/SERVER",
    auth: "composio" as const,
    defaultScope: "workspace" as const,
    composio: {
      toolkit: "gmail",
      authConfigEnv: "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
      serverIdEnv: "COMPOSIO_GMAIL_SERVER_ID",
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
    expect(composioUserId("ws_01abc")).toBe("ws_01abc");
  });

  test("prefixes tenant id when NB_TENANT_ID is set", () => {
    process.env.NB_TENANT_ID = "hq";
    expect(composioUserId("ws_01abc")).toBe("hq:ws_01abc");
  });

  test("trims whitespace on NB_TENANT_ID", () => {
    process.env.NB_TENANT_ID = "  bayze  ";
    expect(composioUserId("ws_01abc")).toBe("bayze:ws_01abc");
  });
});

describe("composioCallbackUrl", () => {
  const origApi = process.env.NB_API_URL;
  afterEach(() => {
    if (origApi === undefined) delete process.env.NB_API_URL;
    else process.env.NB_API_URL = origApi;
  });

  test("uses NB_API_URL when set", () => {
    process.env.NB_API_URL = "https://hq.platform.nimblebrain.ai";
    expect(composioCallbackUrl()).toBe(
      "https://hq.platform.nimblebrain.ai/v1/composio-auth/callback",
    );
  });

  test("trims trailing slashes", () => {
    process.env.NB_API_URL = "https://hq.platform.nimblebrain.ai//";
    expect(composioCallbackUrl()).toBe(
      "https://hq.platform.nimblebrain.ai/v1/composio-auth/callback",
    );
  });

  test("falls back to localhost when unset", () => {
    delete process.env.NB_API_URL;
    expect(composioCallbackUrl()).toBe("http://localhost:27247/v1/composio-auth/callback");
  });
});

describe("GET /v1/composio-auth/proxy", () => {
  const origBase = process.env.COMPOSIO_API_BASE_URL;
  afterEach(() => {
    if (origBase === undefined) delete process.env.COMPOSIO_API_BASE_URL;
    else process.env.COMPOSIO_API_BASE_URL = origBase;
  });

  test("302s to backend.composio.dev with query params preserved", async () => {
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
    process.env.COMPOSIO_API_BASE_URL = "https://composio.example.com";
    const app = composioAuthRoutes(stubCtx("/tmp/work", null));
    const res = await app.request("http://nb.test/v1/composio-auth/proxy?code=abc");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://composio.example.com/api/v3.1/toolkits/auth/callback?code=abc",
    );
  });

  test("does not cache the redirect response", async () => {
    const app = composioAuthRoutes(stubCtx("/tmp/work", null));
    const res = await app.request("http://nb.test/v1/composio-auth/proxy?code=abc");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /v1/composio-auth/callback", () => {
  test("writes connection.json when the nonce cookie matches", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const entry = composioEntry("com.google/gmail");
      const app = composioAuthRoutes(stubCtx(dir, entry));
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

      const stored = await readComposioConnection(dir, wsId, cid);
      expect(stored).not.toBeNull();
      expect(stored?.connectedAccountId).toBe("ca_xyz");
      expect(stored?.toolkit).toBe("gmail");
      expect(stored?.status).toBe("ACTIVE");

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
      const path = composioConnectionPath(dir, "ws_test", "com.google/gmail");
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

  test("rejects malformed cid", async () => {
    const { dir, cleanup } = freshDir();
    try {
      const app = composioAuthRoutes(stubCtx(dir, composioEntry("com.google/gmail")));
      const url =
        "http://nb.test/v1/composio-auth/callback?cid=" +
        encodeURIComponent("../escape") +
        "&ws=ws_test&n=x&connected_account_id=ca_xyz";
      const res = await app.request(url);
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });
});
