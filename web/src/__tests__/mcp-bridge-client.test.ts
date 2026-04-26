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
import { getMcpBridgeClient, resetMcpBridgeClient } from "../mcp-bridge-client";

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

    // Transport is pointed at /mcp
    expect(lastTransportUrl?.pathname).toBe("/mcp");

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

describe("per-request header generation", () => {
  test("reads getAuthToken and getActiveWorkspaceId on each fetch (not cached at construction)", async () => {
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

      // Rotate both before the second request. The module MUST read fresh
      // values; if it had cached headers at construction, the old values
      // would leak through.
      setAuthToken("rotated-token");
      setActiveWorkspaceId("ws-rotated");

      await customFetch("https://example.test/mcp", { method: "POST" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.authorization).toBe("Bearer initial-token");
    expect(calls[0]?.headers["x-workspace-id"]).toBe("ws-initial");

    expect(calls[1]?.headers.authorization).toBe("Bearer rotated-token");
    expect(calls[1]?.headers["x-workspace-id"]).toBe("ws-rotated");
  });

  test("cookie-mode token ('__cookie__') omits Authorization header but still sends X-Workspace-Id", async () => {
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
    expect(capturedHeaders["x-workspace-id"]).toBe("ws-cookie");
  });

  test("omits both headers when unauthenticated", async () => {
    setAuthToken(null);
    setActiveWorkspaceId(null);

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
