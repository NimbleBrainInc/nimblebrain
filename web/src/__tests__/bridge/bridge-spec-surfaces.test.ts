// ---------------------------------------------------------------------------
// Bridge spec-surface tests
//
// Three spec requests the host answers, and the capabilities it advertises for
// them. Each was previously absent, and an absent handler on this bridge is
// silent — the switch drops the message and the app's promise never settles —
// so these assert that something comes back at all as much as what it says.
//
//   - `ui/download-file`: spec resource blocks, not an already-materialised
//     Blob. Inline `text` and base64 `blob` download; a `ResourceLink` is
//     refused, because fetching an iframe-supplied URI would make the host an
//     SSRF proxy carrying the user's cookies.
//   - `ui/request-display-mode`: answered with the mode actually in effect,
//     which the host does not let an app change.
//   - `notifications/message`: reaches the console. The `logging` capability
//     is advertised, so it has to land somewhere.
//
// Plus: the tasks capability is advertised where an app built on the spec's
// own client can still see it — `hostCapabilities.experimental`, keyed by
// identifier — as well as in the sibling field today's SDK reads.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../../test/setup";

mock.module("../../api/client", () => ({
  ...realClient,
  getActiveWorkspaceId: () => "ws_test",
  uploadResource: async () => {
    throw new Error("uploadResource not stubbed in this test");
  },
}));

mock.module("../../mcp-bridge-client", () => ({
  getMcpBridgeClient: async () => ({
    callTool: mock(async () => ({ content: [], structuredContent: {} })),
    readResource: mock(async () => ({ contents: [] })),
    request: mock(async () => ({})),
    setNotificationHandler: mock(() => {}),
    removeNotificationHandler: mock(() => {}),
  }),
  resetMcpBridgeClient: () => {
    /* noop */
  },
  withSessionRetry: async <T>(op: () => Promise<T>): Promise<T> => op(),
}));

const { createBridge } = await import("../../bridge/bridge");

// ---------------------------------------------------------------------------
// Harness
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

let activeBridge: { destroy(): void } | null = null;
let activeFrame: TestIframe | null = null;

/** Anchors `triggerDownload` clicked, so a download is observable. */
let downloads: Array<{ filename: string }> = [];
let origClick: () => void;

beforeEach(() => {
  downloads = [];
  origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    downloads.push({ filename: this.download });
  };
});

afterEach(() => {
  HTMLAnchorElement.prototype.click = origClick;
  activeBridge?.destroy();
  activeFrame?.cleanup();
  activeBridge = null;
  activeFrame = null;
});

function mount(appName = "db-query", callbacks?: Parameters<typeof createBridge>[2]): TestIframe {
  const frame = makeTestIframe();
  activeFrame = frame;
  activeBridge = createBridge(frame.iframe, appName, callbacks);
  return frame;
}

const isReplyTo = (id: string) => (m: unknown) => (m as { id?: string })?.id === id;

async function handshake(frame: TestIframe): Promise<Record<string, unknown>> {
  frame.send({
    jsonrpc: "2.0",
    id: "init",
    method: "ui/initialize",
    params: {
      protocolVersion: "2026-01-26",
      clientInfo: { name: "iframe", version: "1.0.0" },
      capabilities: {},
    },
  });
  const reply = (await frame.waitFor(isReplyTo("init"))) as {
    result: { hostCapabilities: Record<string, unknown> };
  };
  return reply.result.hostCapabilities;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ui/initialize — advertised capabilities", () => {
  test("advertises downloadFile, now that ui/download-file is answered", async () => {
    const capabilities = await handshake(mount());
    expect(capabilities.downloadFile).toEqual({});
  });

  test("advertises tasks where the SDK actually reads it", async () => {
    const capabilities = await handshake(mount());
    // The SDK reads `hostCapabilities.tasks` off the raw result rather than
    // through a spec schema, so it sees this even though the ext-apps
    // capability type names no such field. Dropping it would turn
    // `callToolAsTask` off everywhere.
    expect(capabilities.tasks).toEqual({ cancel: {}, requests: { tools: { call: {} } } });
  });

  test("advertises tasks under experimental, and the key survives the spec's own parse", async () => {
    const { McpUiInitializeResultSchema } = await import("@modelcontextprotocol/ext-apps");
    const frame = mount();
    frame.send({
      jsonrpc: "2.0",
      id: "init-exp",
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        clientInfo: { name: "iframe", version: "1.0.0" },
        capabilities: {},
      },
    });
    const reply = (await frame.waitFor(isReplyTo("init-exp"))) as { result: unknown };
    const tasks = { cancel: {}, requests: { tools: { call: {} } } };

    const sent = reply.result as { hostCapabilities: Record<string, unknown> };
    expect(sent.hostCapabilities.experimental).toEqual({ "ai.nimblebrain/tasks": tasks });

    // What the official `App` keeps: it stores the parsed result, not the raw
    // frame, so a key this parse strips is a key no app built on it can read.
    const parsed = McpUiInitializeResultSchema.parse(reply.result);
    expect(parsed.hostCapabilities.experimental?.["ai.nimblebrain/tasks"]).toEqual(tasks);
  });
});

describe("ui/download-file", () => {
  test("an inline text resource downloads, named from its URI", async () => {
    const frame = mount();
    frame.send({
      jsonrpc: "2.0",
      id: "d1",
      method: "ui/download-file",
      params: {
        contents: [
          {
            type: "resource",
            resource: { uri: "file:///report.csv", mimeType: "text/csv", text: "a,b\n1,2" },
          },
        ],
      },
    });

    const reply = (await frame.waitFor(isReplyTo("d1"))) as { result: Record<string, unknown> };
    expect(reply.result).toEqual({});
    expect(downloads).toEqual([{ filename: "report.csv" }]);
  });

  test("a base64 blob resource downloads", async () => {
    const frame = mount();
    frame.send({
      jsonrpc: "2.0",
      id: "d2",
      method: "ui/download-file",
      params: {
        contents: [
          {
            type: "resource",
            name: "logo.png",
            resource: { uri: "file:///logo.png", mimeType: "image/png", blob: btoa("bytes") },
          },
        ],
      },
    });

    const reply = (await frame.waitFor(isReplyTo("d2"))) as { result: Record<string, unknown> };
    expect(reply.result).toEqual({});
    expect(downloads).toEqual([{ filename: "logo.png" }]);
  });

  test("a ResourceLink is refused rather than fetched", async () => {
    const frame = mount();
    frame.send({
      jsonrpc: "2.0",
      id: "d3",
      method: "ui/download-file",
      params: {
        contents: [{ type: "resource_link", uri: "https://internal.example/secret", name: "x" }],
      },
    });

    // Answered, and answered honestly: the host does not fetch a URI supplied
    // by third-party iframe code, so the app learns to embed the bytes instead
    // of waiting on a download that is never coming.
    const reply = (await frame.waitFor(isReplyTo("d3"))) as { result: Record<string, unknown> };
    expect(reply.result).toEqual({ isError: true });
    expect(downloads).toEqual([]);
  });

  test("a batch mixing a file with a link saves nothing", async () => {
    // All or nothing. Saving what resolved and still reporting `isError` has an
    // app retry the whole request, and the user gets the resolvable file twice.
    const frame = mount();
    frame.send({
      jsonrpc: "2.0",
      id: "d5",
      method: "ui/download-file",
      params: {
        contents: [
          { type: "resource", resource: { uri: "file:///a.csv", text: "a,b" } },
          { type: "resource_link", uri: "https://internal.example/secret", name: "x" },
        ],
      },
    });

    const reply = (await frame.waitFor(isReplyTo("d5"))) as { result: Record<string, unknown> };
    expect(reply.result).toEqual({ isError: true });
    expect(downloads).toEqual([]);
  });

  test("an unparseable base64 payload reports isError", async () => {
    const frame = mount();
    frame.send({
      jsonrpc: "2.0",
      id: "d4",
      method: "ui/download-file",
      params: {
        contents: [{ type: "resource", resource: { uri: "file:///x.bin", blob: "not base64 !!" } }],
      },
    });

    const reply = (await frame.waitFor(isReplyTo("d4"))) as { result: Record<string, unknown> };
    expect(reply.result).toEqual({ isError: true });
    expect(downloads).toEqual([]);
  });
});

describe("ui/request-display-mode", () => {
  test("answers inline when the host publishes no display mode", async () => {
    const frame = mount();
    frame.send({
      jsonrpc: "2.0",
      id: "m1",
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });

    // The request is not granted, and the answer says so rather than echoing
    // it back. `inline` is the spec's own default.
    const reply = (await frame.waitFor(isReplyTo("m1"))) as { result: { mode: string } };
    expect(reply.result.mode).toBe("inline");
  });

  test("does not grant a request, whatever the host publishes", async () => {
    // Placement is the host's layout decision, never the app's. Nothing
    // publishes a `displayMode` today, so the answer is the spec's default.
    const frame = mount("db-query", { getHostExtensions: () => ({ displayMode: "fullscreen" }) });
    frame.send({
      jsonrpc: "2.0",
      id: "m2",
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });

    const reply = (await frame.waitFor(isReplyTo("m2"))) as { result: { mode: string } };
    expect(reply.result.mode).toBe("inline");
  });
});

describe("notifications/message", () => {
  test("an app's log line reaches the console at its own severity", async () => {
    const frame = mount("db-query");
    const lines: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      frame.send({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "warning", logger: "query", data: "slow plan" },
      });
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      console.warn = origWarn;
    }

    const logged = lines.find((args) => String(args[0]).includes("db-query"));
    expect(logged).toBeDefined();
    expect(String(logged?.[0])).toContain("query");
    expect(String(logged?.[0])).toContain("warning");
    expect(logged?.[1]).toBe("slow plan");
  });
});
