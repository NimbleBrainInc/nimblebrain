// ---------------------------------------------------------------------------
// Bridge tasks-surface tests
//
// The bridge always advertises `hostCapabilities.tasks` and forwards the
// `tasks/*` surface through the MCP bridge client. These tests verify:
//
//   - `ui/initialize` always advertises `hostCapabilities.tasks` so the
//     iframe SDK's capability check permits `callToolAsTask`.
//   - `tasks/get` / `tasks/result` / `tasks/cancel` are forwarded through
//     the MCP bridge client. Errors translate to JSON-RPC envelopes
//     (`-32602` for invalid/not-found, `-32603` internal, etc.).
//   - The bridge subscribes once at creation to `notifications/tasks/status`
//     on the MCP client; each notification is forwarded verbatim (params
//     preserved, including `_meta`) to this iframe. `destroy()` tears down
//     the subscription so post-destroy emissions do not reach the iframe.
//
// Strategy: mock the MCP bridge client with `setNotificationHandler`,
// `removeNotificationHandler`, and `request` hooks so we can emit fake
// `notifications/tasks/status` and assert both forwarding and teardown.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// mcp-bridge-client
//
// We track notification handlers per-method so we can both (a) assert
// that the bridge subscribed, and (b) synthesize notifications at will.
type NotificationHandler = (notification: {
  method: string;
  params: Record<string, unknown>;
}) => void | Promise<void>;

const handlers = new Map<string, NotificationHandler>();

interface McpBehavior {
  request: (
    req: { method: string; params: unknown },
    schema: unknown,
  ) => Promise<Record<string, unknown>>;
}

const defaultBehavior: McpBehavior = {
  request: async ({ method, params }) => {
    const p = params as { taskId?: string };
    if (method === "tasks/get") {
      return {
        taskId: p.taskId ?? "t-1",
        status: "working",
        ttl: 60_000,
        createdAt: "2026-04-22T00:00:00Z",
        lastUpdatedAt: "2026-04-22T00:00:01Z",
      };
    }
    if (method === "tasks/result") {
      return {
        content: [{ type: "text", text: "done" }],
        structuredContent: { ok: true },
        _meta: {
          "io.modelcontextprotocol/related-task": { taskId: p.taskId ?? "t-1" },
        },
      };
    }
    if (method === "tasks/cancel") {
      return {
        taskId: p.taskId ?? "t-1",
        status: "cancelled",
        ttl: 60_000,
        createdAt: "2026-04-22T00:00:00Z",
        lastUpdatedAt: "2026-04-22T00:00:02Z",
      };
    }
    return {};
  },
};
let mcpBehavior: McpBehavior = defaultBehavior;

const mcpRequest = mock((req: { method: string; params: unknown }, schema: unknown) =>
  mcpBehavior.request(req, schema),
);

const setNotificationHandler = mock(
  (schema: { shape?: { method?: { value?: string } } }, handler: NotificationHandler) => {
    // The SDK derives the method from the schema's `method` literal; in
    // happy-dom land we read it from the zod shape. Fall back to a known
    // constant for the tasks/status case.
    const method = schema?.shape?.method?.value ?? "notifications/tasks/status";
    handlers.set(method, handler);
  },
);

const removeNotificationHandler = mock((method: string) => {
  handlers.delete(method);
});

let getClientShouldReject: Error | null = null;
mock.module("../../mcp-bridge-client", () => ({
  getMcpBridgeClient: async () => {
    if (getClientShouldReject) throw getClientShouldReject;
    return {
      request: mcpRequest,
      setNotificationHandler,
      removeNotificationHandler,
      // These two are called by bridge.ts code paths we don't exercise
      // in this test file (tools/call, resources/read) but need to exist
      // so any accidental hit doesn't crash.
      callTool: mock(async () => ({ content: [], structuredContent: {} })),
      readResource: mock(async () => ({ contents: [] })),
    };
  },
  resetMcpBridgeClient: () => {
    /* noop */
  },
}));

// Import bridge AFTER mocks so it picks up the stubs.
const { createBridge } = await import("../../bridge/bridge");

// ---------------------------------------------------------------------------
// Test harness — shared with bridge-transport.test.ts but re-defined here
// so this file is self-contained.
// ---------------------------------------------------------------------------

interface TestIframe {
  iframe: HTMLIFrameElement;
  inbox: unknown[];
  send(data: unknown): void;
  waitFor(pred: (msg: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
  cleanup(): void;
}

function makeTestIframe(): TestIframe {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);

  const inbox: unknown[] = [];
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

// Wait for the bridge's async subscription to settle (one microtask tick
// after `getMcpBridgeClient()` resolves).
async function waitForSubscription(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (handlers.has("notifications/tasks/status")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Bridge did not subscribe to notifications/tasks/status");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  getClientShouldReject = null;
  mcpBehavior = defaultBehavior;
  mcpRequest.mockClear();
  setNotificationHandler.mockClear();
  removeNotificationHandler.mockClear();
  handlers.clear();
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
// ui/initialize — capability advertisement
// ---------------------------------------------------------------------------

describe("ui/initialize — tasks capability", () => {
  test("hostCapabilities.tasks is advertised", async () => {
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "init-1",
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        clientInfo: { name: "iframe", version: "1.0.0" },
        capabilities: {},
      },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "init-1")) as {
      result: { hostCapabilities: Record<string, unknown> };
    };
    expect(reply.result.hostCapabilities.tasks).toEqual({
      cancel: {},
      requests: { tools: { call: {} } },
    });
    // Existing capabilities preserved.
    expect(reply.result.hostCapabilities.openLinks).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// tasks/* forwarding
// ---------------------------------------------------------------------------

describe("tasks/* forwarding — iframe → MCP client", () => {
  test("tasks/get forwards taskId and returns GetTaskResult", async () => {
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "g-1",
      method: "tasks/get",
      params: { taskId: "task-abc" },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "g-1")) as {
      result: { taskId: string; status: string };
    };
    expect(reply.result.taskId).toBe("task-abc");
    expect(reply.result.status).toBe("working");

    expect(mcpRequest).toHaveBeenCalledTimes(1);
    const [req] = mcpRequest.mock.calls[0] ?? [];
    expect(req).toMatchObject({ method: "tasks/get", params: { taskId: "task-abc" } });
  });

  test("tasks/result forwards taskId and returns CallToolResult payload", async () => {
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "r-1",
      method: "tasks/result",
      params: { taskId: "task-xyz" },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "r-1")) as {
      result: {
        content: Array<{ text?: string }>;
        structuredContent?: { ok: boolean };
        _meta?: Record<string, unknown>;
      };
    };
    expect(reply.result.content?.[0]?.text).toBe("done");
    expect(reply.result.structuredContent).toEqual({ ok: true });
    // _meta passthrough preserves the related-task binding (Non-Negotiable
    // Rule 4 — forward the result verbatim).
    expect(reply.result._meta?.["io.modelcontextprotocol/related-task"]).toEqual({
      taskId: "task-xyz",
    });

    const [req] = mcpRequest.mock.calls[0] ?? [];
    expect(req).toMatchObject({ method: "tasks/result", params: { taskId: "task-xyz" } });
  });

  test("tasks/cancel forwards taskId and returns cancelled Task", async () => {
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "c-1",
      method: "tasks/cancel",
      params: { taskId: "task-cc" },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "c-1")) as {
      result: { taskId: string; status: string };
    };
    expect(reply.result.taskId).toBe("task-cc");
    expect(reply.result.status).toBe("cancelled");
  });
});

describe("tasks/* error translation", () => {
  test("server -32602 (invalid taskId) preserved on the wire", async () => {
    mcpBehavior = {
      request: async () => {
        const err = new Error("task not found") as Error & { code?: number };
        err.code = -32602;
        throw err;
      },
    };
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "e-1",
      method: "tasks/get",
      params: { taskId: "nope" },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "e-1")) as {
      error?: { code: number; message: string };
    };
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error?.message).toContain("task not found");
  });

  test("unknown/internal error surfaces as -32603", async () => {
    mcpBehavior = {
      request: async () => {
        throw new Error("connection dropped");
      },
    };
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: "e-2",
      method: "tasks/cancel",
      params: { taskId: "x" },
    });

    const reply = (await frame.waitFor((m) => (m as { id?: string })?.id === "e-2")) as {
      error?: { code: number; message: string };
    };
    expect(reply.error?.code).toBe(-32603);
    expect(reply.error?.message).toContain("connection dropped");
  });
});

// ---------------------------------------------------------------------------
// notifications/tasks/status forwarding + subscription teardown
// ---------------------------------------------------------------------------

describe("notifications/tasks/status — forwarding + teardown", () => {
  test("bridge subscribes once at creation", async () => {
    mount("synapse-research");

    await waitForSubscription();
    expect(setNotificationHandler).toHaveBeenCalledTimes(1);
    const [schema] = setNotificationHandler.mock.calls[0] ?? [];
    expect((schema as { shape?: { method?: { value?: string } } })?.shape?.method?.value).toBe(
      "notifications/tasks/status",
    );
  });

  test("emitted notification is forwarded to the iframe verbatim (preserves _meta)", async () => {
    const frame = mount("synapse-research");
    await waitForSubscription();

    const handler = handlers.get("notifications/tasks/status");
    expect(handler).toBeDefined();

    const params = {
      taskId: "task-abc",
      status: "working",
      ttl: 60_000,
      createdAt: "2026-04-22T00:00:00Z",
      lastUpdatedAt: "2026-04-22T00:00:03Z",
      _meta: {
        "io.modelcontextprotocol/related-task": { taskId: "task-abc" },
        custom: "carried-through",
      },
    };
    handler?.({ method: "notifications/tasks/status", params });

    const forwarded = (await frame.waitFor(
      (m) => (m as { method?: string })?.method === "notifications/tasks/status",
    )) as { jsonrpc: "2.0"; method: string; params: Record<string, unknown> };
    expect(forwarded).toEqual({
      jsonrpc: "2.0",
      method: "notifications/tasks/status",
      params,
    });
  });

  test("destroy() unsubscribes — post-destroy emissions do not reach iframe", async () => {
    const frame = mount("synapse-research");
    await waitForSubscription();

    const handler = handlers.get("notifications/tasks/status");
    expect(handler).toBeDefined();

    // Destroy tears down the subscription.
    activeBridge?.destroy();
    activeBridge = null;
    expect(removeNotificationHandler).toHaveBeenCalledWith("notifications/tasks/status");

    // Even if we invoke the stale handler reference directly (simulating
    // the MCP client firing AFTER teardown), `destroyed` guards the
    // postMessage so nothing reaches the iframe.
    handler?.({
      method: "notifications/tasks/status",
      params: {
        taskId: "task-abc",
        status: "completed",
        ttl: 60_000,
        createdAt: "2026-04-22T00:00:00Z",
        lastUpdatedAt: "2026-04-22T00:00:04Z",
      },
    });

    // Give microtasks a chance to drain.
    await new Promise((r) => setTimeout(r, 10));

    const leaked = frame.inbox.find(
      (m) => (m as { method?: string })?.method === "notifications/tasks/status",
    );
    expect(leaked).toBeUndefined();
  });

  test("each bridge instance handles its own forwarding (multi-iframe isolation)", async () => {
    const frame1 = makeTestIframe();
    const bridge1 = createBridge(frame1.iframe, "app-one");
    await waitForSubscription();

    // Replace the first handler's slot by creating a second bridge. Each
    // bridge is per-iframe; the latest subscription wins at the
    // MCP-client level (SDK's setNotificationHandler semantics). The key
    // invariant is that post-destroy the later bridge doesn't leak to a
    // destroyed iframe.
    const frame2 = makeTestIframe();
    const bridge2 = createBridge(frame2.iframe, "app-two");
    // Wait until the second setNotificationHandler landed.
    await new Promise((r) => setTimeout(r, 10));

    const handler = handlers.get("notifications/tasks/status");
    handler?.({
      method: "notifications/tasks/status",
      params: {
        taskId: "task-2",
        status: "working",
        ttl: 60_000,
        createdAt: "2026-04-22T00:00:00Z",
        lastUpdatedAt: "2026-04-22T00:00:05Z",
      },
    });

    // The latest bridge (frame2) receives the notification.
    const hit2 = await frame2.waitFor(
      (m) => (m as { method?: string })?.method === "notifications/tasks/status",
    );
    expect(hit2).toBeDefined();

    bridge1.destroy();
    bridge2.destroy();
    frame1.cleanup();
    frame2.cleanup();
  });
});
