// ---------------------------------------------------------------------------
// Bridge transport tests — Task 008 (feature-flagged REST ↔ MCP swap)
//
// These tests exercise the behavioral contract from `008-bridge-swap-transport.md`:
//
//   - Flag off  → `tools/call` and `resources/read` run through the legacy
//                 REST helpers in `web/src/api/client.ts` (zero regression).
//   - Flag on   → both branches forward through the MCP SDK bridge client.
//   - `INTERNAL_APPS` trust-list authz precedes transport selection and is
//     enforced on BOTH paths identically.
//   - Task-augmented `tools/call` (`params.task` present) routes through the
//     SDK's generic request path and the `CreateTaskResult` flows back to
//     the iframe verbatim — within the fast-path budget the spec requires.
//
// Strategy: mock the three injected dependencies (REST client, MCP client,
// feature flag) and watch which side got called per message. We simulate
// postMessage by dispatching a MessageEvent directly at the window with
// `source` set to the iframe's contentWindow, because happy-dom wires
// postMessage through the same mechanism.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — each dependency is replaced with an observable stub so tests can
// inspect call shape, argument forwarding, and error propagation.
// ---------------------------------------------------------------------------

// api/client (REST transport)
const restCallTool = mock(async (_server: string, _tool: string, _args?: unknown) => ({
  content: [{ type: "text", text: "rest-ok" }],
  structuredContent: { via: "rest" },
}));
const restReadResource = mock(async (_server: string, _uri: string) => ({
  contents: [{ uri: "ui://demo", text: "rest-bytes" }],
}));

mock.module("../../api/client", () => ({
  callTool: restCallTool,
  readResource: restReadResource,
}));

// mcp-bridge-client (SDK transport)
//
// We don't care about the real SDK — only that `callTool`, `readResource`,
// and `request` get invoked with the right shapes. The returned promise is
// configurable per-test via `mcpBehavior`.
interface McpBehavior {
  callTool: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
  readResource: (params: { uri: string }) => Promise<Record<string, unknown>>;
  request: (
    req: { method: string; params: unknown },
    schema: unknown,
  ) => Promise<Record<string, unknown>>;
}

let mcpBehavior: McpBehavior = {
  callTool: async () => ({
    content: [{ type: "text", text: "mcp-ok" }],
    structuredContent: { via: "mcp" },
  }),
  readResource: async () => ({
    contents: [{ uri: "ui://demo", text: "mcp-bytes" }],
  }),
  request: async () => ({
    task: {
      taskId: "task-abc",
      status: "working",
      ttl: 1000,
      createdAt: "2026-01-01T00:00:00Z",
      lastUpdatedAt: "2026-01-01T00:00:00Z",
    },
  }),
};

const mcpCallTool = mock((p: { name: string; arguments?: Record<string, unknown> }) =>
  mcpBehavior.callTool(p),
);
const mcpReadResource = mock((p: { uri: string }) => mcpBehavior.readResource(p));
const mcpRequest = mock((req: { method: string; params: unknown }, schema: unknown) =>
  mcpBehavior.request(req, schema),
);

let getClientShouldReject: Error | null = null;
const getClientCalls = { count: 0 };
mock.module("../../mcp-bridge-client", () => ({
  getMcpBridgeClient: async () => {
    getClientCalls.count += 1;
    if (getClientShouldReject) throw getClientShouldReject;
    return {
      callTool: mcpCallTool,
      readResource: mcpReadResource,
      request: mcpRequest,
    };
  },
  resetMcpBridgeClient: () => {
    /* noop */
  },
}));

// features — toggled per test
let bridgeUseMcpFlag = false;
mock.module("../../features", () => ({
  getBridgeUseMcp: () => bridgeUseMcpFlag,
  setBridgeUseMcp: (v: boolean) => {
    bridgeUseMcpFlag = v;
  },
}));

// Import bridge AFTER mocks are registered so it picks up the stubs.
const { createBridge } = await import("../../bridge/bridge");

// ---------------------------------------------------------------------------
// Test harness: a minimal iframe whose contentWindow can both receive
// postMessage (so the bridge can reply) and act as the `source` on inbound
// events.
// ---------------------------------------------------------------------------

interface TestIframe {
  iframe: HTMLIFrameElement;
  /** Messages the bridge posted back to the iframe. */
  inbox: unknown[];
  /** Inject a message from the iframe to the host. */
  send(data: unknown): void;
  /** Wait for the next inbox entry that passes `pred`, up to `timeoutMs`. */
  waitFor(pred: (msg: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
  cleanup(): void;
}

function makeTestIframe(): TestIframe {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);

  const inbox: unknown[] = [];
  // Replace `contentWindow` with a stub whose `postMessage` captures inbound
  // host→iframe traffic for assertions. Real happy-dom iframes can deliver
  // postMessage but it's much simpler to capture this way.
  const stubWindow = {
    postMessage(data: unknown) {
      inbox.push(data);
    },
  } as Window;
  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    get: () => stubWindow,
  });

  function send(data: unknown): void {
    // happy-dom's `dispatchEvent` checks `event instanceof Event` against
    // its own Event class, so we must construct the event via the
    // happy-dom `window` global. We then override the `source` getter
    // so the bridge's `event.source === iframe.contentWindow` security
    // check matches our stub.
    const WindowMessageEvent = (window as unknown as { MessageEvent: typeof MessageEvent })
      .MessageEvent;
    const event = new WindowMessageEvent("message", { data });
    Object.defineProperty(event, "source", {
      configurable: true,
      get: () => stubWindow,
    });
    window.dispatchEvent(event);
  }

  async function waitFor(pred: (msg: unknown) => boolean, timeoutMs = 500): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`Timed out after ${timeoutMs}ms; inbox: ${JSON.stringify(inbox, null, 2)}`);
  }

  function cleanup(): void {
    document.body.removeChild(iframe);
  }

  return { iframe, inbox, send, waitFor, cleanup };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  bridgeUseMcpFlag = false;
  getClientShouldReject = null;
  getClientCalls.count = 0;
  restCallTool.mockClear();
  restReadResource.mockClear();
  mcpCallTool.mockClear();
  mcpReadResource.mockClear();
  mcpRequest.mockClear();
  mcpBehavior = {
    callTool: async () => ({
      content: [{ type: "text", text: "mcp-ok" }],
      structuredContent: { via: "mcp" },
    }),
    readResource: async () => ({
      contents: [{ uri: "ui://demo", text: "mcp-bytes" }],
    }),
    request: async () => ({
      task: {
        taskId: "task-abc",
        status: "working",
        ttl: 1000,
        createdAt: "2026-01-01T00:00:00Z",
        lastUpdatedAt: "2026-01-01T00:00:00Z",
      },
    }),
  };
});

let activeBridge: { destroy(): void } | null = null;
let activeFrame: TestIframe | null = null;

afterEach(() => {
  activeBridge?.destroy();
  activeFrame?.cleanup();
  activeBridge = null;
  activeFrame = null;
});

function mount(appName: string): TestIframe {
  const frame = makeTestIframe();
  activeFrame = frame;
  activeBridge = createBridge(frame.iframe, appName);
  return frame;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tools/call — transport selection", () => {
  test("flag off routes to REST /v1/tools/call (regression guard)", async () => {
    bridgeUseMcpFlag = false;
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/call",
      params: { name: "start_research", arguments: { query: "hi" } },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "1")) as {
      result: { content: unknown[]; structuredContent?: unknown };
    };
    expect(reply.result.structuredContent).toEqual({ via: "rest" });
    expect(restCallTool).toHaveBeenCalledTimes(1);
    expect(mcpCallTool).not.toHaveBeenCalled();
    expect(mcpRequest).not.toHaveBeenCalled();
    expect(getClientCalls.count).toBe(0);
  });

  test("flag on routes to MCP client callTool, NOT REST", async () => {
    bridgeUseMcpFlag = true;
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "2",
      method: "tools/call",
      params: { name: "search", arguments: { q: "mcp" } },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "2")) as {
      result: { content: unknown[]; structuredContent?: unknown };
    };
    expect(reply.result.structuredContent).toEqual({ via: "mcp" });
    expect(mcpCallTool).toHaveBeenCalledTimes(1);
    expect(restCallTool).not.toHaveBeenCalled();

    // The wire name is qualified with the app's own server per REST-parity.
    const [callParams] = mcpCallTool.mock.calls[0] ?? [];
    expect(callParams).toEqual({
      name: "synapse-research__search",
      arguments: { q: "mcp" },
    });
  });

  test("flag toggled between calls takes effect without remount (read per call)", async () => {
    bridgeUseMcpFlag = false;
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "a",
      method: "tools/call",
      params: { name: "t", arguments: {} },
    });
    await frame.waitFor((m) => (m as { id?: string })?.id === "a");

    bridgeUseMcpFlag = true;
    frame.send({
      jsonrpc: "2.0",
      id: "b",
      method: "tools/call",
      params: { name: "t", arguments: {} },
    });
    await frame.waitFor((m) => (m as { id?: string })?.id === "b");

    expect(restCallTool).toHaveBeenCalledTimes(1);
    expect(mcpCallTool).toHaveBeenCalledTimes(1);
  });

  test("task-augmented call returns CreateTaskResult to the iframe (<1s)", async () => {
    bridgeUseMcpFlag = true;
    const frame = mount("synapse-research");

    const t0 = Date.now();
    frame.send({
      jsonrpc: "2.0",
      id: "t1",
      method: "tools/call",
      params: {
        name: "start_research",
        arguments: { query: "deep" },
        task: { ttl: 1000 },
      },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "t1", 1000)) as {
      result: { task: { taskId: string; status: string } };
    };
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1000);
    expect(reply.result.task?.taskId).toBe("task-abc");
    expect(reply.result.task?.status).toBe("working");

    // Task-augmented path uses the generic request() — not callTool —
    // because CreateTaskResult doesn't match CallToolResultSchema.
    expect(mcpRequest).toHaveBeenCalledTimes(1);
    expect(mcpCallTool).not.toHaveBeenCalled();

    const [req] = mcpRequest.mock.calls[0] ?? [];
    expect(req).toMatchObject({
      method: "tools/call",
      params: expect.objectContaining({ task: { ttl: 1000 } }),
    });
  });

  test("MCP client connection failure surfaces as JSON-RPC error (not silent)", async () => {
    bridgeUseMcpFlag = true;
    getClientShouldReject = new Error("connect refused");
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "err-1",
      method: "tools/call",
      params: { name: "x", arguments: {} },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "err-1")) as {
      error?: { code: number; message: string };
    };
    expect(reply.error?.code).toBe(-32000);
    expect(reply.error?.message).toContain("connect refused");
  });

  test("tool result with isError translates to JSON-RPC error on the MCP path", async () => {
    bridgeUseMcpFlag = true;
    mcpBehavior.callTool = async () => ({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "err-2",
      method: "tools/call",
      params: { name: "x", arguments: {} },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "err-2")) as {
      error?: { code: number; message: string };
    };
    expect(reply.error).toEqual({ code: -32000, message: "boom" });
  });
});

describe("tools/call — INTERNAL_APPS authz precedes transport", () => {
  test("external app with params.server is locked to its own server on REST path", async () => {
    bridgeUseMcpFlag = false;
    const frame = mount("synapse-research"); // not in INTERNAL_APPS

    frame.send({
      jsonrpc: "2.0",
      id: "a1",
      method: "tools/call",
      params: { name: "t", arguments: {}, server: "nb" }, // attempted cross-call
    });
    await frame.waitFor((m) => (m as { id?: string })?.id === "a1");

    // REST helper was called, but with the app's own server (not "nb").
    expect(restCallTool).toHaveBeenCalledTimes(1);
    const args = restCallTool.mock.calls[0] ?? [];
    expect(args[0]).toBe("synapse-research");
  });

  test("external app with params.server is locked to its own server on MCP path", async () => {
    bridgeUseMcpFlag = true;
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "a2",
      method: "tools/call",
      params: { name: "t", arguments: {}, server: "nb" },
    });
    await frame.waitFor((m) => (m as { id?: string })?.id === "a2");

    // MCP client received a name qualified with the app's server,
    // NOT "nb" — the authz rule is enforced identically on both paths.
    expect(mcpCallTool).toHaveBeenCalledTimes(1);
    const [callParams] = mcpCallTool.mock.calls[0] ?? [];
    expect((callParams as { name: string }).name).toBe("synapse-research__t");
  });

  test("internal app with params.server is allowed to cross-call on REST path", async () => {
    bridgeUseMcpFlag = false;
    const frame = mount("nb"); // IS in INTERNAL_APPS

    frame.send({
      jsonrpc: "2.0",
      id: "a3",
      method: "tools/call",
      params: { name: "briefing", arguments: {}, server: "home" },
    });
    await frame.waitFor((m) => (m as { id?: string })?.id === "a3");

    expect(restCallTool).toHaveBeenCalledTimes(1);
    const args = restCallTool.mock.calls[0] ?? [];
    expect(args[0]).toBe("home");
  });

  test("internal app with params.server is allowed to cross-call on MCP path", async () => {
    bridgeUseMcpFlag = true;
    const frame = mount("nb");

    frame.send({
      jsonrpc: "2.0",
      id: "a4",
      method: "tools/call",
      params: { name: "briefing", arguments: {}, server: "home" },
    });
    await frame.waitFor((m) => (m as { id?: string })?.id === "a4");

    expect(mcpCallTool).toHaveBeenCalledTimes(1);
    const [callParams] = mcpCallTool.mock.calls[0] ?? [];
    expect((callParams as { name: string }).name).toBe("home__briefing");
  });
});

describe("resources/read — transport selection", () => {
  test("flag off routes to REST /v1/resources/read", async () => {
    bridgeUseMcpFlag = false;
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "r1",
      method: "resources/read",
      params: { uri: "ui://demo" },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "r1")) as {
      result: { contents: unknown[] };
    };
    expect(reply.result.contents).toEqual([{ uri: "ui://demo", text: "rest-bytes" }]);
    expect(restReadResource).toHaveBeenCalledTimes(1);
    expect(mcpReadResource).not.toHaveBeenCalled();
  });

  test("flag on routes to MCP client readResource, NOT REST", async () => {
    bridgeUseMcpFlag = true;
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "r2",
      method: "resources/read",
      params: { uri: "ui://demo" },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "r2")) as {
      result: { contents: unknown[] };
    };
    expect(reply.result.contents).toEqual([{ uri: "ui://demo", text: "mcp-bytes" }]);
    expect(mcpReadResource).toHaveBeenCalledTimes(1);
    expect(restReadResource).not.toHaveBeenCalled();
  });

  test("ui:// URI returns the same payload via both paths (diff)", async () => {
    // Force both paths to return the same canonical contents so the diff
    // is meaningful: this guards against accidental shape divergence at
    // the bridge boundary, e.g. unwrapping `contents` or stripping fields.
    const canonical = {
      contents: [{ uri: "ui://demo/main.html", mimeType: "text/html", text: "<h1>hi</h1>" }],
    };
    restReadResource.mockImplementation(async () => canonical);
    mcpBehavior.readResource = async () => canonical;

    bridgeUseMcpFlag = false;
    let frame = mount("synapse-research");
    frame.send({
      jsonrpc: "2.0",
      id: "d1",
      method: "resources/read",
      params: { uri: "ui://demo/main.html" },
    });
    const restReply = (await frame.waitFor((m) => (m as { id?: string })?.id === "d1")) as {
      result: unknown;
    };
    activeBridge?.destroy();
    activeFrame?.cleanup();

    bridgeUseMcpFlag = true;
    frame = mount("synapse-research");
    activeFrame = frame;
    frame.send({
      jsonrpc: "2.0",
      id: "d2",
      method: "resources/read",
      params: { uri: "ui://demo/main.html" },
    });
    const mcpReply = (await frame.waitFor((m) => (m as { id?: string })?.id === "d2")) as {
      result: unknown;
    };

    expect(restReply.result).toEqual(mcpReply.result);
  });

  test("MCP readResource error forwards as JSON-RPC -32000", async () => {
    bridgeUseMcpFlag = true;
    mcpBehavior.readResource = async () => {
      throw new Error("resource not found");
    };
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "r-err",
      method: "resources/read",
      params: { uri: "ui://missing" },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "r-err")) as {
      error?: { code: number; message: string };
    };
    expect(reply.error?.code).toBe(-32000);
    expect(reply.error?.message).toContain("resource not found");
  });
});

describe("resources/read — INTERNAL_APPS authz precedes transport", () => {
  test("external app with params.server is rejected (scoped to own server) — REST", async () => {
    bridgeUseMcpFlag = false;
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "s1",
      method: "resources/read",
      params: { uri: "ui://x", server: "nb" },
    });
    await frame.waitFor((m) => (m as { id?: string })?.id === "s1");

    expect(restReadResource).toHaveBeenCalledTimes(1);
    // Server arg is the app's own name, not "nb".
    expect(restReadResource.mock.calls[0]?.[0]).toBe("synapse-research");
  });

  test("internal app with params.server is allowed to cross-call — REST", async () => {
    bridgeUseMcpFlag = false;
    const frame = mount("nb");

    frame.send({
      jsonrpc: "2.0",
      id: "s2",
      method: "resources/read",
      params: { uri: "ui://home/view", server: "home" },
    });
    await frame.waitFor((m) => (m as { id?: string })?.id === "s2");

    expect(restReadResource).toHaveBeenCalledTimes(1);
    expect(restReadResource.mock.calls[0]?.[0]).toBe("home");
  });
});
