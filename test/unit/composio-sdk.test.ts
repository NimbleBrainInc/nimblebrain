import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── @composio/core mock ─────────────────────────────────────────────
//
// Bun's `mock.module` is hoisted before the SUT imports, so this stub
// captures every SDK call the platform makes. Each test replaces the
// implementations on `sdkCalls` to drive behaviour. Keeping the mock
// at the module boundary (rather than reaching into the platform's
// own wrappers) means the tests exercise the exact same code path
// production does — type assertions, error shapes, everything.

interface SdkCalls {
  listImpl: (q: unknown) => Promise<{ items?: Array<{ id?: unknown; status?: unknown }> }>;
  initiateImpl: (...args: unknown[]) => Promise<unknown>;
  deleteImpl: (id: string) => Promise<void>;
  createImpl: (...args: unknown[]) => Promise<unknown>;
  /** Last-seen client construction args — verify baseURL / apiKey wiring. */
  ctorArgs: Array<{ apiKey: string; baseURL?: string }>;
  /** Last-seen `composio.create()` config — verify direct_tools, allowlist. */
  lastCreateConfig: unknown;
}

const sdkCalls: SdkCalls = {
  listImpl: async () => ({ items: [] }),
  initiateImpl: async () => ({ redirectUrl: "https://composio.test/link", id: "ca_default" }),
  deleteImpl: async () => undefined,
  createImpl: async () => ({
    sessionId: "session_default",
    mcp: { type: "http", url: "https://composio.test/mcp/x", headers: { "x-api-key": "k" } },
  }),
  ctorArgs: [],
  lastCreateConfig: undefined,
};

mock.module("@composio/core", () => ({
  Composio: class {
    connectedAccounts = {
      list: (q: unknown) => sdkCalls.listImpl(q),
      initiate: (...args: unknown[]) => sdkCalls.initiateImpl(...args),
      delete: (id: string) => sdkCalls.deleteImpl(id),
    };
    constructor(opts: { apiKey: string; baseURL?: string }) {
      sdkCalls.ctorArgs.push(opts);
    }
    create(userId: string, config: unknown) {
      sdkCalls.lastCreateConfig = config;
      return sdkCalls.createImpl(userId, config);
    }
  },
}));

// SUT imports must come AFTER the mock.module hoist (the file order is
// what gets hoisted, but explicit ordering keeps intent obvious).
const sdk = await import("../../src/composio/sdk.ts");
const {
  _resetComposioConfigForTest,
  composioUserId,
  createComposioSession,
  deleteComposioConnectedAccount,
  findActiveComposioConnection,
  initiateComposioConnection,
  validateComposioConfig,
} = sdk;
// The bouncer-config module also caches at process scope. Multi-tenant
// safety tests need both caches reset to read freshly-set env vars.
const { _resetBouncerModeForTest } = await import("../../src/oauth/bouncer-config.ts");

// ── Env helpers ─────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};
const TRACKED = [
  "COMPOSIO_API_KEY",
  "COMPOSIO_API_BASE_URL",
  "NB_TENANT_ID",
  "NB_OAUTH_BOUNCER_CALLBACK_URL",
  "NB_OAUTH_BOUNCER_TENANT_KEY",
];

beforeEach(() => {
  for (const k of TRACKED) savedEnv[k] = process.env[k];
  for (const k of TRACKED) delete process.env[k];
  _resetComposioConfigForTest();
  _resetBouncerModeForTest();
  sdkCalls.ctorArgs.length = 0;
  sdkCalls.lastCreateConfig = undefined;
  sdkCalls.listImpl = async () => ({ items: [] });
  sdkCalls.initiateImpl = async () => ({ redirectUrl: "https://composio.test/link", id: "ca_x" });
  sdkCalls.deleteImpl = async () => undefined;
  sdkCalls.createImpl = async () => ({
    sessionId: "session_default",
    mcp: { type: "http", url: "https://composio.test/mcp/x", headers: { "x-api-key": "k" } },
  });
});

afterEach(() => {
  for (const k of TRACKED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _resetComposioConfigForTest();
  _resetBouncerModeForTest();
});

// ── validateComposioConfig ──────────────────────────────────────────

describe("validateComposioConfig", () => {
  test("returns not configured when COMPOSIO_API_KEY is unset", () => {
    expect(validateComposioConfig().configured).toBe(false);
  });

  test("returns configured with default base URL when only API key is set", () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    const cfg = validateComposioConfig();
    expect(cfg.configured).toBe(true);
    expect(cfg.baseUrl).toBe("https://backend.composio.dev");
  });

  test("honors COMPOSIO_API_BASE_URL override", () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_API_BASE_URL = "https://composio.example.com";
    expect(validateComposioConfig().baseUrl).toBe("https://composio.example.com");
  });

  test("rejects non-http(s) COMPOSIO_API_BASE_URL (open-redirect mitigation)", () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_API_BASE_URL = "javascript:alert(1)";
    expect(() => validateComposioConfig()).toThrow(/http\(s\)/);
  });

  test("rejects malformed COMPOSIO_API_BASE_URL", () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_API_BASE_URL = "not a url";
    expect(() => validateComposioConfig()).toThrow(/valid URL/);
  });

  test("requires NB_TENANT_ID in bouncer (multi-tenant) mode", () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    // Minimal bouncer config — both vars must be set or `getBouncerMode`
    // throws on the partial-config branch. We're testing that bouncer +
    // missing NB_TENANT_ID fails specifically on the composio check.
    process.env.NB_OAUTH_BOUNCER_CALLBACK_URL = "https://b.test/v1/mcp-auth/callback";
    process.env.NB_OAUTH_BOUNCER_TENANT_KEY = Buffer.alloc(32, 1).toString("base64");
    // NB_TENANT_ID intentionally unset.
    expect(() => validateComposioConfig()).toThrow();
  });

  test("caches the result across calls (set-once at startup)", () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    const first = validateComposioConfig();
    delete process.env.COMPOSIO_API_KEY;
    const second = validateComposioConfig();
    expect(second).toBe(first); // same object, no re-read
  });
});

// ── composioUserId ──────────────────────────────────────────────────

describe("composioUserId", () => {
  test("returns wsId alone when NB_TENANT_ID unset", () => {
    expect(composioUserId("ws_01abc")).toBe("ws_01abc");
  });

  test("prefixes tenant id when NB_TENANT_ID set", () => {
    process.env.NB_TENANT_ID = "hq";
    expect(composioUserId("ws_01abc")).toBe("hq:ws_01abc");
  });

  test("trims whitespace on NB_TENANT_ID", () => {
    process.env.NB_TENANT_ID = "  hq  ";
    expect(composioUserId("ws_01abc")).toBe("hq:ws_01abc");
  });
});

// ── findActiveComposioConnection ────────────────────────────────────

describe("findActiveComposioConnection", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_test";
  });

  test("returns null when Composio reports no accounts", async () => {
    sdkCalls.listImpl = async () => ({ items: [] });
    const result = await findActiveComposioConnection({
      apiKey: "k_test",
      userId: "ws_x",
      authConfigId: "ac_x",
    });
    expect(result).toBeNull();
  });

  test("returns first ACTIVE account when one exists", async () => {
    sdkCalls.listImpl = async () => ({
      items: [{ id: "ca_first", status: "ACTIVE" }],
    });
    const result = await findActiveComposioConnection({
      apiKey: "k_test",
      userId: "ws_x",
      authConfigId: "ac_x",
    });
    expect(result).toEqual({ id: "ca_first", status: "ACTIVE" });
  });

  test("ignores entries with missing id (defensive against SDK shape drift)", async () => {
    sdkCalls.listImpl = async () => ({ items: [{ status: "ACTIVE" }] });
    const result = await findActiveComposioConnection({
      apiKey: "k_test",
      userId: "ws_x",
      authConfigId: "ac_x",
    });
    expect(result).toBeNull();
  });

  test("passes the right query params to the SDK", async () => {
    let captured: unknown;
    sdkCalls.listImpl = async (q) => {
      captured = q;
      return { items: [] };
    };
    await findActiveComposioConnection({
      apiKey: "k_test",
      userId: "hq:ws_42",
      authConfigId: "ac_gmail",
    });
    expect(captured).toEqual({
      userIds: ["hq:ws_42"],
      authConfigIds: ["ac_gmail"],
      statuses: ["ACTIVE"],
      limit: 1,
    });
  });
});

// ── initiateComposioConnection ──────────────────────────────────────

describe("initiateComposioConnection", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_test";
  });

  test("returns redirect URL + connectedAccountId from the SDK response", async () => {
    sdkCalls.initiateImpl = async () => ({
      redirectUrl: "https://connect.composio.dev/link/lk_42",
      id: "ca_pending",
    });
    const result = await initiateComposioConnection({
      apiKey: "k_test",
      userId: "ws_x",
      authConfigId: "ac_x",
      callbackUrl: "https://nb.test/v1/composio-auth/callback",
    });
    expect(result.redirectUrl).toBe("https://connect.composio.dev/link/lk_42");
    expect(result.connectedAccountId).toBe("ca_pending");
  });

  test("passes allowMultiple: true (belt-and-suspenders against race)", async () => {
    let capturedOpts: unknown;
    sdkCalls.initiateImpl = async (_userId, _ac, opts) => {
      capturedOpts = opts;
      return { redirectUrl: "https://x", id: "ca_x" };
    };
    await initiateComposioConnection({
      apiKey: "k_test",
      userId: "ws_x",
      authConfigId: "ac_x",
      callbackUrl: "https://nb.test/v1/composio-auth/callback",
    });
    expect((capturedOpts as { allowMultiple?: boolean }).allowMultiple).toBe(true);
  });

  test("falls back to redirectUri / id field names (SDK shape variation)", async () => {
    sdkCalls.initiateImpl = async () => ({
      redirectUri: "https://x.test/auth",
      connectedAccountId: "ca_alt",
    });
    const result = await initiateComposioConnection({
      apiKey: "k_test",
      userId: "ws_x",
      authConfigId: "ac_x",
      callbackUrl: "https://nb.test/cb",
    });
    expect(result).toEqual({ redirectUrl: "https://x.test/auth", connectedAccountId: "ca_alt" });
  });

  test("throws cleanly when Composio omits redirect URL", async () => {
    sdkCalls.initiateImpl = async () => ({ id: "ca_x" });
    await expect(
      initiateComposioConnection({
        apiKey: "k_test",
        userId: "ws_x",
        authConfigId: "ac_x",
        callbackUrl: "https://nb.test/cb",
      }),
    ).rejects.toThrow(/missing redirect URL/);
  });
});

// ── deleteComposioConnectedAccount ──────────────────────────────────

describe("deleteComposioConnectedAccount", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_test";
  });

  test("returns true on success", async () => {
    sdkCalls.deleteImpl = async () => undefined;
    expect(
      await deleteComposioConnectedAccount({ apiKey: "k_test", connectedAccountId: "ca_x" }),
    ).toBe(true);
  });

  test("returns false on SDK error (best-effort, never throws)", async () => {
    sdkCalls.deleteImpl = async () => {
      throw new Error("Composio down");
    };
    expect(
      await deleteComposioConnectedAccount({ apiKey: "k_test", connectedAccountId: "ca_x" }),
    ).toBe(false);
  });

  test("passes the connectedAccountId through to the SDK", async () => {
    let captured = "";
    sdkCalls.deleteImpl = async (id) => {
      captured = id;
    };
    await deleteComposioConnectedAccount({ apiKey: "k_test", connectedAccountId: "ca_target" });
    expect(captured).toBe("ca_target");
  });
});

// ── createComposioSession ───────────────────────────────────────────

describe("createComposioSession", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_test";
  });

  test("returns MCP URL + headers from the session", async () => {
    sdkCalls.createImpl = async () => ({
      sessionId: "s_test",
      mcp: {
        type: "http",
        url: "https://composio.test/mcp/sess/mcp",
        headers: { "x-api-key": "k" },
      },
    });
    const result = await createComposioSession({
      apiKey: "k_test",
      userId: "ws_x",
      toolkit: "gmail",
      authConfigId: "ac_gmail",
    });
    expect(result.url).toBe("https://composio.test/mcp/sess/mcp");
    expect(result.headers).toEqual({ "x-api-key": "k" });
    expect(result.type).toBe("http");
  });

  test("requests direct_tools preset (not the meta-tool router)", async () => {
    await createComposioSession({
      apiKey: "k_test",
      userId: "ws_x",
      toolkit: "gmail",
      authConfigId: "ac_gmail",
    });
    expect((sdkCalls.lastCreateConfig as { sessionPreset?: string }).sessionPreset).toBe(
      "direct_tools",
    );
  });

  test("forwards toolkit + authConfigs mapping", async () => {
    await createComposioSession({
      apiKey: "k_test",
      userId: "ws_x",
      toolkit: "gmail",
      authConfigId: "ac_gmail",
    });
    const cfg = sdkCalls.lastCreateConfig as {
      toolkits?: string[];
      authConfigs?: Record<string, string>;
    };
    expect(cfg.toolkits).toEqual(["gmail"]);
    expect(cfg.authConfigs).toEqual({ gmail: "ac_gmail" });
  });

  test("forwards tool allowlist when provided", async () => {
    await createComposioSession({
      apiKey: "k_test",
      userId: "ws_x",
      toolkit: "gmail",
      authConfigId: "ac_gmail",
      tools: ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"],
    });
    const cfg = sdkCalls.lastCreateConfig as { tools?: Record<string, unknown> };
    expect(cfg.tools).toEqual({
      gmail: ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"],
    });
  });

  test("omits tools key when allowlist is empty", async () => {
    await createComposioSession({
      apiKey: "k_test",
      userId: "ws_x",
      toolkit: "gmail",
      authConfigId: "ac_gmail",
      tools: [],
    });
    const cfg = sdkCalls.lastCreateConfig as { tools?: unknown };
    expect(cfg.tools).toBeUndefined();
  });

  test("throws cleanly when Composio session has no MCP URL", async () => {
    sdkCalls.createImpl = async () => ({ sessionId: "s_x", mcp: { type: "http", url: "" } });
    await expect(
      createComposioSession({
        apiKey: "k_test",
        userId: "ws_x",
        toolkit: "gmail",
        authConfigId: "ac_gmail",
      }),
    ).rejects.toThrow(/missing mcp\.url/);
  });
});

// ── SDK timeout wrapper ─────────────────────────────────────────────

describe("SDK call timeout", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_test";
  });

  test("surfaces a clean timeout error when Composio hangs", async () => {
    // Make `list` never resolve. The wrapper should reject after ~10s,
    // but we don't want this test to actually take 10s — race the
    // promise against a tighter assertion timer below.
    sdkCalls.listImpl = () => new Promise(() => {});
    // Bun's `expect(...).rejects` honors the global test timeout —
    // we override it on this test only.
    await expect(
      findActiveComposioConnection({ apiKey: "k_test", userId: "ws_x", authConfigId: "ac_x" }),
    ).rejects.toThrow(/timed out/);
  }, 15_000);
});

// ── composioClient construction ─────────────────────────────────────

describe("composioClient", () => {
  test("uses default base URL when no override is set", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    // Trigger a client construction via any SDK call.
    sdkCalls.listImpl = async () => ({ items: [] });
    await findActiveComposioConnection({
      apiKey: "k_test",
      userId: "ws_x",
      authConfigId: "ac_x",
    });
    expect(sdkCalls.ctorArgs[0]?.baseURL).toBe("https://backend.composio.dev");
    expect(sdkCalls.ctorArgs[0]?.apiKey).toBe("k_test");
  });

  test("threads COMPOSIO_API_BASE_URL through to the SDK client", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.COMPOSIO_API_BASE_URL = "https://composio.example.com";
    sdkCalls.listImpl = async () => ({ items: [] });
    await findActiveComposioConnection({
      apiKey: "k_test",
      userId: "ws_x",
      authConfigId: "ac_x",
    });
    expect(sdkCalls.ctorArgs[0]?.baseURL).toBe("https://composio.example.com");
  });
});
