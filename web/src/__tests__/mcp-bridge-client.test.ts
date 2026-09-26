import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock the MCP SDK so tests run without opening real network connections.
//
// We capture the Client and Transport constructors so each test can inspect
// how `mcp-bridge-client.ts` wired them up (endpoint URL, capabilities,
// custom fetch), and control whether `connect()` resolves or rejects.
// ---------------------------------------------------------------------------

interface FakeTransportOptions {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

let transportCtorCalls = 0;
let lastTransportUrl: URL | null = null;
let lastTransportOptions: FakeTransportOptions | null = null;
let transportCloseCalls = 0;

let clientCtorCalls = 0;
let lastClientCapabilities: unknown = null;
let connectShouldReject: Error | null = null;
/** When set, the next `connect()` waits on it — lets a test hold a handshake open. */
let connectGate: Promise<void> | null = null;
let connectCalls = 0;
let clientCloseCalls = 0;

class FakeTransport {
  url: URL;
  options: FakeTransportOptions;
  constructor(url: URL, options?: FakeTransportOptions) {
    transportCtorCalls += 1;
    this.url = url;
    this.options = options ?? {};
    lastTransportUrl = url;
    lastTransportOptions = this.options;
  }
  async close(): Promise<void> {
    transportCloseCalls += 1;
  }
}

class FakeClient {
  transport: FakeTransport | null = null;
  constructor(_info: { name: string; version: string }, options?: { capabilities?: unknown }) {
    clientCtorCalls += 1;
    lastClientCapabilities = options?.capabilities ?? null;
  }
  async connect(transport: FakeTransport): Promise<void> {
    connectCalls += 1;
    this.transport = transport;
    if (connectGate) {
      const gate = connectGate;
      connectGate = null;
      await gate;
    }
    if (connectShouldReject) {
      throw connectShouldReject;
    }
  }
  async close(): Promise<void> {
    clientCloseCalls += 1;
    if (this.transport) {
      await this.transport.close();
    }
  }
}

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: FakeClient,
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: FakeTransport,
}));

// ---------------------------------------------------------------------------
// Use the REAL api/client module (no mock.module) so we don't pollute the
// global module registry — Bun's mock.module is process-global, and a
// mock in one test file silently bleeds into others. We control auth
// state via the real setters.
//
// The lifecycle wiring (auth setters fire `resetMcpBridgeClient` on real
// change) is tested separately in `api-client-lifecycle.test.ts`. We
// neutralize it here in `beforeEach` so each test starts with a known
// cache state, then re-enable it via the real registration where needed.
// ---------------------------------------------------------------------------

import { setActiveWorkspaceId, setAuthLifecycleHandler, setAuthToken } from "../api/client";
import { getMcpBridgeClient, resetMcpBridgeClient, withSessionRetry } from "../mcp-bridge-client";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function resetCounters(): void {
  transportCtorCalls = 0;
  transportCloseCalls = 0;
  clientCtorCalls = 0;
  clientCloseCalls = 0;
  connectCalls = 0;
  connectShouldReject = null;
  connectGate = null;
  lastTransportUrl = null;
  lastTransportOptions = null;
  lastClientCapabilities = null;
}

beforeEach(() => {
  resetCounters();
  // Neutralize the auth lifecycle wiring so our setAuthToken/Workspace
  // calls below don't tear down the cached client mid-test. Tests that
  // need the wiring re-engage it explicitly.
  setAuthLifecycleHandler(null);
  setAuthToken("initial-token");
  setActiveWorkspaceId("ws-initial");
});

afterEach(() => {
  resetMcpBridgeClient();
  setAuthLifecycleHandler(null);
  setAuthToken(null);
  setActiveWorkspaceId(null);
});

describe("getMcpBridgeClient", () => {
  test("returns a connected Client after first call", async () => {
    const client = await getMcpBridgeClient();

    expect(client).toBeInstanceOf(FakeClient);
    expect(transportCtorCalls).toBe(1);
    expect(clientCtorCalls).toBe(1);
    expect(connectCalls).toBe(1);

    // Transport is pointed at the active workspace's endpoint
    expect(lastTransportUrl?.pathname).toBe("/mcp/ws-initial");

    // Client advertises the task cancel capability during init handshake
    expect(lastClientCapabilities).toEqual({ tasks: { cancel: {} } });
  });

  test("subsequent calls return the same Client instance (singleton)", async () => {
    const a = await getMcpBridgeClient();
    const b = await getMcpBridgeClient();
    const c = await getMcpBridgeClient();

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(transportCtorCalls).toBe(1);
    expect(connectCalls).toBe(1);
  });

  test("concurrent calls share a single in-flight initialize handshake", async () => {
    const [a, b, d] = await Promise.all([
      getMcpBridgeClient(),
      getMcpBridgeClient(),
      getMcpBridgeClient(),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(d);
    expect(transportCtorCalls).toBe(1);
    expect(connectCalls).toBe(1);
  });

  test("init failure surfaces as a rejected promise, does not throw synchronously", async () => {
    connectShouldReject = new Error("handshake failed");

    // Must not throw synchronously — any error must arrive via the promise.
    let p: Promise<unknown> | undefined;
    expect(() => {
      p = getMcpBridgeClient();
    }).not.toThrow();
    expect(p).toBeDefined();

    await expect(p).rejects.toThrow("handshake failed");

    // Transport was cleaned up on failure.
    expect(transportCloseCalls).toBe(1);
  });

  test("rejects with no active workspace, and builds no transport", async () => {
    setActiveWorkspaceId(null);
    await expect(getMcpBridgeClient()).rejects.toThrow(/No active workspace/);
    expect(transportCtorCalls).toBe(0);
  });

  test("retries after a failed init (singleton cleared)", async () => {
    connectShouldReject = new Error("first failure");
    await expect(getMcpBridgeClient()).rejects.toThrow("first failure");

    connectShouldReject = null;
    const client = await getMcpBridgeClient();
    expect(client).toBeInstanceOf(FakeClient);
    expect(clientCtorCalls).toBe(2);
    expect(connectCalls).toBe(2);
  });
});

describe("resetMcpBridgeClient", () => {
  test("closes the transport and a subsequent call returns a fresh instance", async () => {
    const first = await getMcpBridgeClient();

    resetMcpBridgeClient();

    // Give the async close time to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(clientCloseCalls).toBe(1);

    const second = await getMcpBridgeClient();
    expect(second).not.toBe(first);
    expect(transportCtorCalls).toBe(2);
    expect(connectCalls).toBe(2);
  });

  test("is a no-op when no client has been created", () => {
    expect(() => resetMcpBridgeClient()).not.toThrow();
    expect(clientCloseCalls).toBe(0);
    expect(transportCloseCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bridge lifecycle vs auth/workspace setters. The platform binds an
// `Mcp-Session-Id` to the identity AND the workspace in its URL, so both a
// logout and a workspace switch drop the session, and a request for one
// workspace never goes out on another workspace's session.
// ---------------------------------------------------------------------------

/** The workspace path a client's transport targets. */
function pathOf(client: unknown): string | undefined {
  return (client as FakeClient).transport?.url.pathname;
}

describe("bridge session lifecycle vs auth/workspace setters", () => {
  test("workspace switch closes the old session and opens one on the new path", async () => {
    const first = await getMcpBridgeClient();
    expect(pathOf(first)).toBe("/mcp/ws-initial");

    setActiveWorkspaceId("ws-after-switch");
    await Promise.resolve();
    await Promise.resolve();
    expect(clientCloseCalls).toBe(1);

    const second = await getMcpBridgeClient();
    expect(second).not.toBe(first);
    expect(pathOf(second)).toBe("/mcp/ws-after-switch");
    expect(clientCtorCalls).toBe(2);
  });

  test("no request for workspace B goes out on workspace A's session, even mid-handshake", async () => {
    // Hold A's handshake open, switch to B while it is in flight, and ask
    // again: the B caller must get a client whose transport targets B's path,
    // never A's still-pending one.
    let releaseA: () => void = () => {};
    connectGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const forA = getMcpBridgeClient();

    setActiveWorkspaceId("ws-b");
    const forB = getMcpBridgeClient();
    releaseA();

    const [clientA, clientB] = await Promise.all([forA, forB]);
    expect(clientB).not.toBe(clientA);
    expect(pathOf(clientA)).toBe("/mcp/ws-initial");
    expect(pathOf(clientB)).toBe("/mcp/ws-b");

    // And every later B call stays on B's session.
    expect(await getMcpBridgeClient()).toBe(clientB);
  });

  test("returning to a workspace opens a fresh session for it", async () => {
    const first = await getMcpBridgeClient();
    setActiveWorkspaceId("ws-b");
    await getMcpBridgeClient();
    setActiveWorkspaceId("ws-initial");
    const again = await getMcpBridgeClient();
    expect(again).not.toBe(first);
    expect(pathOf(again)).toBe("/mcp/ws-initial");
  });

  test("logout (setAuthToken null) drops the bridge client", async () => {
    setAuthLifecycleHandler(resetMcpBridgeClient);

    const first = await getMcpBridgeClient();
    expect(clientCtorCalls).toBe(1);

    // Logout / identity change — handler runs, transport closes.
    setAuthToken(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(clientCloseCalls).toBe(1);

    // Next bridge call builds a fresh client.
    const second = await getMcpBridgeClient();
    expect(second).not.toBe(first);
    expect(clientCtorCalls).toBe(2);
    expect(connectCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Session-not-found recovery — fixes the symptom in #141 where a stale
// `Mcp-Session-Id` (after a server-side TTL eviction or process restart)
// would lock every iframe call into a permanent error until page refresh.
// ---------------------------------------------------------------------------

describe("withSessionRetry", () => {
  /**
   * The platform's exact 404 body, embedded inside the SDK transport's
   * wrapper text. Matching `mcp-server.ts::handlePost`. If the wording on
   * the server side changes, this test breaks loudly — which is the point.
   */
  const SESSION_NOT_FOUND_TRANSPORT_ERROR = new Error(
    `Streamable HTTP error: Error POSTing to endpoint: ${JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found" },
      id: null,
    })}`,
  );

  test("returns the operation's value when no error", async () => {
    const op = mock(async () => "ok");
    const result = await withSessionRetry(op);
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("retries once on session-not-found and returns the second-call value", async () => {
    let invocations = 0;
    const op = async () => {
      invocations += 1;
      if (invocations === 1) throw SESSION_NOT_FOUND_TRANSPORT_ERROR;
      return "recovered";
    };

    // Prime the singleton so the reset path actually has something to close.
    await getMcpBridgeClient();
    expect(clientCtorCalls).toBe(1);

    const result = await withSessionRetry(op);
    expect(result).toBe("recovered");
    expect(invocations).toBe(2);

    // After-the-fact wait for the async client.close() the reset triggers.
    await Promise.resolve();
    await Promise.resolve();
    expect(clientCloseCalls).toBe(1);
  });

  test("recognizes the parsed error.data.reason variant (forward-compat with #162)", async () => {
    let invocations = 0;
    const op = async () => {
      invocations += 1;
      if (invocations === 1) {
        // Simulate the post-#162 SDK exposing parsed JSON-RPC error data.
        throw Object.assign(new Error("session miss"), {
          data: { reason: "unavailable" },
        });
      }
      return "recovered";
    };

    const result = await withSessionRetry(op);
    expect(result).toBe("recovered");
    expect(invocations).toBe(2);
  });

  test("propagates non-session errors without retrying", async () => {
    let invocations = 0;
    const op = async () => {
      invocations += 1;
      throw new Error("Tool execution failed: bad input");
    };

    await expect(withSessionRetry(op)).rejects.toThrow("Tool execution failed");
    expect(invocations).toBe(1);
  });

  test("propagates the second error if the retry also fails", async () => {
    let invocations = 0;
    const op = async () => {
      invocations += 1;
      if (invocations === 1) throw SESSION_NOT_FOUND_TRANSPORT_ERROR;
      throw new Error("auth failed on retry");
    };

    await expect(withSessionRetry(op)).rejects.toThrow("auth failed on retry");
    expect(invocations).toBe(2);
  });

  test("retried op gets a fresh client (singleton was dropped)", async () => {
    const firstClient = await getMcpBridgeClient();
    expect(clientCtorCalls).toBe(1);

    let invocations = 0;
    let secondClient: unknown = null;
    await withSessionRetry(async () => {
      invocations += 1;
      if (invocations === 1) throw SESSION_NOT_FOUND_TRANSPORT_ERROR;
      // The op closes over getMcpBridgeClient — second invocation must
      // see a freshly-constructed client, not the dead singleton.
      secondClient = await getMcpBridgeClient();
      return "ok";
    });

    expect(secondClient).not.toBe(firstClient);
    expect(clientCtorCalls).toBe(2);
    expect(connectCalls).toBe(2);
  });
});

describe("per-request header generation", () => {
  test("reads getAuthToken on each fetch (not cached at construction), and sends no workspace header", async () => {
    await getMcpBridgeClient();
    const customFetch = lastTransportOptions?.fetch;
    expect(customFetch).toBeDefined();
    if (!customFetch) return;

    // Replace global fetch with a capture that records what headers arrived.
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url, headers });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      // First request — uses the initial token/workspace.
      await customFetch("https://example.test/mcp", { method: "POST" });

      // Rotate the token before the second request. The module MUST read a
      // fresh value; if it had cached headers at construction, the old value
      // would leak through.
      setAuthToken("rotated-token");

      await customFetch("https://example.test/mcp", { method: "POST" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.authorization).toBe("Bearer initial-token");
    expect(calls[1]?.headers.authorization).toBe("Bearer rotated-token");
    // The workspace is in the URL; no request names it in a header.
    expect(calls.every((c) => c.headers["x-workspace-id"] === undefined)).toBe(true);
  });

  test("a 401 on /mcp silently refreshes the session and retries (idle-expiry bug)", async () => {
    // Reading the token per-request only picks up a refresh SOMEBODY ELSE did.
    // A user parked on a rendered app produces nothing but bridge traffic, so
    // before this the session just expired underneath them: every /mcp call
    // 401'd until a page reload re-bootstrapped auth. The bridge must drive the
    // refresh itself, through the REST client's shared interceptor.
    setAuthToken("__cookie__"); // deployed posture: session rides the cookie
    await getMcpBridgeClient();
    const customFetch = lastTransportOptions?.fetch;
    expect(customFetch).toBeDefined();
    if (!customFetch) return;

    const calls: string[] = [];
    let mcpCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("/v1/auth/refresh")) {
        return new Response("{}", { status: 200 });
      }
      // First /mcp call is the expired session; the post-refresh retry succeeds.
      mcpCalls += 1;
      return new Response("{}", {
        status: mcpCalls === 1 ? 401 : 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let res: Response;
    try {
      res = await customFetch("https://example.test/mcp", { method: "POST" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("/mcp");
    expect(calls[1]).toContain("/v1/auth/refresh");
    expect(calls[2]).toContain("/mcp");
  });

  test("cookie-mode token ('__cookie__') omits the Authorization header", async () => {
    setAuthToken("__cookie__");
    setActiveWorkspaceId("ws-cookie");

    await getMcpBridgeClient();
    const customFetch = lastTransportOptions?.fetch;
    if (!customFetch) throw new Error("custom fetch not configured");

    let capturedHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      await customFetch("https://example.test/mcp", { method: "POST" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedHeaders.authorization).toBeUndefined();
    expect(capturedHeaders["x-workspace-id"]).toBeUndefined();
  });

  test("omits the Authorization header when unauthenticated", async () => {
    setAuthToken(null);

    await getMcpBridgeClient();
    const customFetch = lastTransportOptions?.fetch;
    if (!customFetch) throw new Error("custom fetch not configured");

    let capturedHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      await customFetch("https://example.test/mcp", { method: "POST" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedHeaders.authorization).toBeUndefined();
    expect(capturedHeaders["x-workspace-id"]).toBeUndefined();
  });
});
