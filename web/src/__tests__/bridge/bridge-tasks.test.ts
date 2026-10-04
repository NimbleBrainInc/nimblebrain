// ---------------------------------------------------------------------------
// Bridge tasks tests: the tasks extension (io.modelcontextprotocol/tasks,
// SEP-2663, MCP 2026-07-28), app <-> host
//
//   - `ui/initialize` declares the extension under `experimental`, as `{}`.
//   - A `tools/call` opts in by naming the extension in its `_meta` client
//     capabilities; the bridge then sends it opted in, and passes through
//     whatever the server answered: a complete `CallToolResult` or a flat task.
//     Without the claim it is an ordinary call. A 2025 `params.task` is not
//     forwarded and opts nothing in.
//   - `tasks/get` and `tasks/cancel` are forwarded and their answers passed
//     through: the flat task, with `result` or `error` inlined once terminal,
//     `input_required` included. `tasks/result` and `tasks/list` are not
//     served (-32601).
//   - Every task request is scoped to the app's own server.
//
// Strategy: mock `sendMcpRequest` and answer per method from `mcpBehavior`.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient, realMcpBridgeClient } from "../../../test/setup";
import type { McpAnswer, McpRequestOptions } from "../../mcp-bridge-client";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type Params = Record<string, unknown>;
type Behavior = (method: string, params: Params, options?: McpRequestOptions) => Promise<McpAnswer>;

/** A flat task, as the 2026 leg answers one. */
function flatTask(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "task-1",
    status: "working",
    createdAt: "2026-07-28T00:00:00Z",
    lastUpdatedAt: "2026-07-28T00:00:01Z",
    ttlMs: 60_000,
    pollIntervalMs: 1_000,
    ...fields,
  };
}

const defaultBehavior: Behavior = async (method, params) => {
  if (method === "tools/call") {
    return { result: { resultType: "task", ...flatTask() } };
  }
  if (method === "tasks/get") {
    return { result: { resultType: "complete", ...flatTask({ taskId: params.taskId }) } };
  }
  if (method === "tasks/cancel") return { result: { resultType: "complete" } };
  return { error: { code: -32601, message: `Method not found: ${method}` } };
};
let mcpBehavior: Behavior = defaultBehavior;

const mcpSend = mock((method: string, params: Params, options?: McpRequestOptions) =>
  mcpBehavior(method, params, options),
);

// A tool call needs an active workspace: there is no `/mcp` to call without one.
mock.module("../../api/client", () => ({
  ...realClient,
  getActiveWorkspaceId: () => "ws_0076759dbbe19fcc",
}));

mock.module("../../mcp-bridge-client", () => ({
  ...realMcpBridgeClient,
  sendMcpRequest: mcpSend,
}));

// Import bridge AFTER mocks so it picks up the stubs.
const { createBridge, RESOURCE_SOURCE_META_KEY } = await import("../../bridge/bridge");

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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mcpBehavior = defaultBehavior;
  mcpSend.mockClear();
});

let activeBridge: { destroy(): void } | null = null;
let activeFrame: TestIframe | null = null;

afterEach(() => {
  activeBridge?.destroy();
  activeFrame?.cleanup();
  activeBridge = null;
  activeFrame = null;
});

/** The app's side of the handshake's last step; the host posts nothing unsolicited before it. */
function completeHandshake(frame: TestIframe): void {
  frame.send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
}

function mount(appName: string): TestIframe {
  const frame = makeTestIframe();
  activeFrame = frame;
  activeBridge = createBridge(frame.iframe, appName);
  return frame;
}

// ---------------------------------------------------------------------------
// ui/initialize — capability advertisement
// ---------------------------------------------------------------------------

const byId = (id: string | number) => (m: unknown) => (m as { id?: unknown })?.id === id;

/** The `_meta` an app sends to opt a `tools/call` in to the tasks extension. */
const OPT_IN = {
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} },
  },
};

async function initialize(frame: TestIframe, id: string): Promise<Record<string, unknown>> {
  frame.send({
    jsonrpc: "2.0",
    id,
    method: "ui/initialize",
    params: {
      protocolVersion: "2026-01-26",
      clientInfo: { name: "iframe", version: "1.0.0" },
      capabilities: {},
    },
  });
  const reply = (await frame.waitFor(byId(id))) as {
    result: { hostCapabilities: Record<string, unknown> };
  };
  return reply.result.hostCapabilities;
}

describe("ui/initialize — tasks capability", () => {
  test("the tasks extension is declared under its identifier, as an empty object", async () => {
    const hostCapabilities = await initialize(mount("research"), "init-1");
    // `experimental`, not a top-level `tasks`: the official ext-apps `App`
    // parses the handshake result against the spec schema, which names no
    // `tasks` field and strips one.
    expect(
      (hostCapabilities.experimental as Record<string, unknown>)["io.modelcontextprotocol/tasks"],
    ).toEqual({});
    expect(hostCapabilities.tasks).toBeUndefined();
    // Existing capabilities preserved.
    expect(hostCapabilities.openLinks).toEqual({});
  });

  test("hostCapabilities.serverResources.listChanged is advertised, in the spec's shape", async () => {
    // The host relays the app server's `notifications/resources/list_changed`
    // to its views (hooks/useServerNotificationRelay.ts); this is the promise
    // that it does.
    const { McpUiHostCapabilitiesSchema } = await import("@modelcontextprotocol/ext-apps");
    const hostCapabilities = await initialize(mount("research"), "init-2");
    expect(hostCapabilities.serverResources).toEqual({ listChanged: true });
    expect(McpUiHostCapabilitiesSchema.safeParse(hostCapabilities).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tools/call — opting in
// ---------------------------------------------------------------------------

describe("tools/call — the tasks extension", () => {
  test("an opted-in call answered with a task gets the flat task, verbatim", async () => {
    const frame = mount("research");
    frame.send({
      jsonrpc: "2.0",
      id: "c1",
      method: "tools/call",
      params: { name: "start_research", arguments: { query: "deep" }, _meta: OPT_IN },
    });

    const reply = await frame.waitFor(byId("c1"));
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: "c1",
      result: { resultType: "task", ...flatTask() },
    });
    // An app may never see `resultType` (the SDK in ext-apps strips it), so the
    // task must read as one without it: `taskId` and `status` at the top level,
    // and no `content`.
    const result = (reply as { result: Record<string, unknown> }).result;
    expect(result.taskId).toBe("task-1");
    expect(result.status).toBe("working");
    expect("content" in result).toBe(false);
    expect(mcpSend).toHaveBeenCalledWith(
      "tools/call",
      {
        name: "research__start_research",
        arguments: { query: "deep" },
        _meta: { [RESOURCE_SOURCE_META_KEY]: "research" },
      },
      { tasks: true },
    );
  });

  test("an opted-in call the server answers outright gets the CallToolResult", async () => {
    const answered = {
      resultType: "complete",
      content: [{ type: "text", text: "done" }],
      structuredContent: { ok: true },
    };
    mcpBehavior = async () => ({ result: answered });
    const frame = mount("research");
    frame.send({
      jsonrpc: "2.0",
      id: "c2",
      method: "tools/call",
      params: { name: "start_research", arguments: {}, _meta: OPT_IN },
    });

    expect(await frame.waitFor(byId("c2"))).toEqual({ jsonrpc: "2.0", id: "c2", result: answered });
  });

  test("a call without the claim is an ordinary call", async () => {
    mcpBehavior = async () => ({ result: { content: [] } });
    const frame = mount("research");
    frame.send({
      jsonrpc: "2.0",
      id: "c3",
      method: "tools/call",
      params: { name: "start_research", arguments: {} },
    });

    await frame.waitFor(byId("c3"));
    expect(mcpSend.mock.calls[0]?.[2]).toEqual({ tasks: false });
  });

  test("a claim naming other extensions only is not an opt-in", async () => {
    mcpBehavior = async () => ({ result: { content: [] } });
    const frame = mount("research");
    frame.send({
      jsonrpc: "2.0",
      id: "c4",
      method: "tools/call",
      params: {
        name: "start_research",
        arguments: {},
        _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { other: {} } } },
      },
    });

    await frame.waitFor(byId("c4"));
    expect(mcpSend.mock.calls[0]?.[2]).toEqual({ tasks: false });
  });

  test("a 2025 params.task is ignored: an ordinary call, with no task forwarded", async () => {
    mcpBehavior = async () => ({ result: { content: [{ type: "text", text: "ran" }] } });
    const frame = mount("research");
    frame.send({
      jsonrpc: "2.0",
      id: "c5",
      method: "tools/call",
      params: { name: "start_research", arguments: {}, task: { ttl: 1000 } },
    });

    expect(await frame.waitFor(byId("c5"))).toEqual({
      jsonrpc: "2.0",
      id: "c5",
      result: { content: [{ type: "text", text: "ran" }] },
    });
    const [, params, options] = mcpSend.mock.calls[0] ?? [];
    expect(params).toEqual({
      name: "research__start_research",
      arguments: {},
      _meta: { [RESOURCE_SOURCE_META_KEY]: "research" },
    });
    expect(options).toEqual({ tasks: false });
  });
});

// ---------------------------------------------------------------------------
// tasks/get, tasks/cancel
// ---------------------------------------------------------------------------

describe("tasks/get and tasks/cancel — passed through", () => {
  test("tasks/get answers the flat task", async () => {
    const frame = mount("research");
    frame.send({ jsonrpc: "2.0", id: "g1", method: "tasks/get", params: { taskId: "task-9" } });

    expect(await frame.waitFor(byId("g1"))).toEqual({
      jsonrpc: "2.0",
      id: "g1",
      result: { resultType: "complete", ...flatTask({ taskId: "task-9" }) },
    });
  });

  test("a completed task carries its CallToolResult inline", async () => {
    const outcome = {
      resultType: "complete",
      ...flatTask({ status: "completed" }),
      result: { content: [{ type: "text", text: "done" }], structuredContent: { ok: true } },
    };
    mcpBehavior = async () => ({ result: outcome });
    const frame = mount("research");
    frame.send({ jsonrpc: "2.0", id: "g2", method: "tasks/get", params: { taskId: "task-1" } });

    expect(await frame.waitFor(byId("g2"))).toEqual({ jsonrpc: "2.0", id: "g2", result: outcome });
  });

  test("a failed task carries its error inline, as a result", async () => {
    const outcome = {
      resultType: "complete",
      ...flatTask({ status: "failed" }),
      error: { code: -32603, message: "connector went away" },
    };
    mcpBehavior = async () => ({ result: outcome });
    const frame = mount("research");
    frame.send({ jsonrpc: "2.0", id: "g3", method: "tasks/get", params: { taskId: "task-1" } });

    expect(await frame.waitFor(byId("g3"))).toEqual({ jsonrpc: "2.0", id: "g3", result: outcome });
  });

  test("an input_required task passes through for the app to handle", async () => {
    const outcome = { resultType: "complete", ...flatTask({ status: "input_required" }) };
    mcpBehavior = async () => ({ result: outcome });
    const frame = mount("research");
    frame.send({ jsonrpc: "2.0", id: "g4", method: "tasks/get", params: { taskId: "task-1" } });

    expect(await frame.waitFor(byId("g4"))).toEqual({ jsonrpc: "2.0", id: "g4", result: outcome });
  });

  test("tasks/cancel answers what the server answered", async () => {
    const frame = mount("research");
    frame.send({ jsonrpc: "2.0", id: "x1", method: "tasks/cancel", params: { taskId: "task-1" } });

    expect(await frame.waitFor(byId("x1"))).toEqual({
      jsonrpc: "2.0",
      id: "x1",
      result: { resultType: "complete" },
    });
    expect(mcpSend.mock.calls[0]?.[0]).toBe("tasks/cancel");
  });

  test("a server's -32602 (not found) keeps its code", async () => {
    mcpBehavior = async () => ({
      error: { code: -32602, message: "Failed to retrieve task: Task not found" },
    });
    const frame = mount("research");
    frame.send({ jsonrpc: "2.0", id: "e1", method: "tasks/get", params: { taskId: "nope" } });

    expect(await frame.waitFor(byId("e1"))).toEqual({
      jsonrpc: "2.0",
      id: "e1",
      error: { code: -32602, message: "Failed to retrieve task: Task not found" },
    });
  });

  test("a request that got no answer is -32000", async () => {
    mcpBehavior = async () => {
      throw new Error("network down");
    };
    const frame = mount("research");
    frame.send({ jsonrpc: "2.0", id: "e2", method: "tasks/get", params: { taskId: "task-1" } });

    const reply = (await frame.waitFor(byId("e2"))) as {
      error?: { code: number; message: string };
    };
    expect(reply.error).toEqual({ code: -32000, message: "network down" });
  });
});

describe("2025 task methods are not served", () => {
  for (const method of ["tasks/result", "tasks/list"]) {
    test(`${method} is method-not-found, and nothing reaches /mcp`, async () => {
      const frame = mount("research");
      frame.send({ jsonrpc: "2.0", id: `n-${method}`, method, params: { taskId: "task-1" } });

      const reply = (await frame.waitFor(byId(`n-${method}`))) as { error?: { code: number } };
      expect(reply.error?.code).toBe(-32601);
      expect(mcpSend).not.toHaveBeenCalled();
    });
  }

  test("no task status notification reaches the app", async () => {
    const frame = mount("research");
    completeHandshake(frame);
    frame.send({
      jsonrpc: "2.0",
      id: "s1",
      method: "tools/call",
      params: { name: "t", _meta: OPT_IN },
    });
    await frame.waitFor(byId("s1"));
    await new Promise((r) => setTimeout(r, 20));

    expect(
      frame.inbox.filter((m) => (m as { method?: string }).method === "notifications/tasks/status"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Every iframe's requests reach `/mcp` as one client, so `/mcp` cannot tell
// which app a task request came from. The bridge can: it names the resolved
// server under `RESOURCE_SOURCE_META_KEY`, as it does for resource reads and
// listings, and `/mcp` answers only for a task that server ran.
// ---------------------------------------------------------------------------
describe("tasks/* — scoped to the app's own server", () => {
  const METHODS = ["tasks/get", "tasks/cancel"] as const;
  const scopedTo = (server: string) => ({ [RESOURCE_SOURCE_META_KEY]: server });

  /** Send each task method as `appName` with `params`; return what reached `/mcp`, in order. */
  async function forwardedAs(appName: string, params: Record<string, unknown>) {
    const frame = mount(appName);
    for (const method of METHODS) {
      const id = `scope-${method}`;
      frame.send({ jsonrpc: "2.0", id, method, params });
      await frame.waitFor(byId(id));
    }
    return mcpSend.mock.calls.map(([method, sent]) => ({ method, params: sent }));
  }

  test("an external app's task requests name its own server", async () => {
    const sent = await forwardedAs("research", { taskId: "task-1" });
    expect(sent).toEqual(
      METHODS.map((method) => ({
        method,
        params: { taskId: "task-1", _meta: scopedTo("research") },
      })),
    );
  });

  test("the iframe's own _meta and any other param are not forwarded", async () => {
    const sent = await forwardedAs("research", {
      taskId: "task-1",
      _meta: scopedTo("files"),
      extra: "dropped",
    });
    expect(sent).toEqual(
      METHODS.map((method) => ({
        method,
        params: { taskId: "task-1", _meta: scopedTo("research") },
      })),
    );
  });

  test("an app naming another server is held to its own", async () => {
    const sent = await forwardedAs("research", {
      taskId: "task-1",
      server: "files",
      _meta: { "ai.nimblebrain/server": "files" },
    });
    expect(sent).toEqual(
      METHODS.map((method) => ({
        method,
        params: { taskId: "task-1", _meta: scopedTo("research") },
      })),
    );
  });

  // The regression guard: no app name carries cross-source reach.
  for (const appName of ["nb", "settings", "home", "usage"]) {
    test(`an app named "${appName}" naming another server is held to its own`, async () => {
      const sent = await forwardedAs(appName, {
        taskId: "task-1",
        server: "research",
        _meta: { "ai.nimblebrain/server": "research" },
      });
      expect(sent).toEqual(
        METHODS.map((method) => ({
          method,
          params: { taskId: "task-1", _meta: scopedTo(appName) },
        })),
      );
    });
  }
});
