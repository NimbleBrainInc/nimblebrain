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

/**
 * A module namespace is readonly, so the upload is swapped here rather than on
 * the imported binding. Defaults to throwing: a test that reaches the uploader
 * without meaning to should say so, not silently upload nothing.
 */
let uploadStub: (files: File[]) => Promise<{ files: unknown[] }> = async () => {
  throw new Error("uploadResource not stubbed in this test");
};

mock.module("../../api/client", () => ({
  ...realClient,
  getActiveWorkspaceId: () => "ws_test",
  uploadResource: (files: File[]) => uploadStub(files),
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
    // Keyed by the identifier MCP Tasks is registered under as an official MCP
    // extension, which is what an app that knows the extension looks for. The
    // literal is pinned here, not just its presence: a typo is a key no app
    // reads.
    expect(sent.hostCapabilities.experimental).toEqual({
      "io.modelcontextprotocol/tasks": tasks,
    });

    // What the official `App` keeps: it stores the parsed result, not the raw
    // frame, so a key this parse strips is a key no app built on it can read.
    const parsed = McpUiInitializeResultSchema.parse(reply.result);
    expect(parsed.hostCapabilities.experimental?.["io.modelcontextprotocol/tasks"]).toEqual(tasks);
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

// ---------------------------------------------------------------------------
// Request ids, and answering the two requests that used to go unanswered
//
// A JSON-RPC id is a string or a number, and the MCP SDK numbers requests from
// zero — so an app built on the spec's own client sends numeric ids. The
// schemas took `Type.String()` for these methods, which made the validator drop
// every such frame: the link never opened, the message never arrived, and the
// app's promise never settled.
//
// `ui/message` and `ui/open-link` are requests in the spec. The host served
// both and answered neither, which a client with a deadline reads as a failure.
// Both forms still arrive — an app on an older SDK sends them as notifications,
// which take no answer.
// ---------------------------------------------------------------------------

describe("spec request ids", () => {
  const replyTo = (id: string | number) => (m: unknown) => (m as { id?: unknown })?.id === id;

  /** Replace `window.open` for one test, and report what it was asked to open. */
  function captureOpen(): { opened: string[]; restore(): void } {
    const opened: string[] = [];
    const original = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      // What the browser returns with `noopener` set, opened or blocked.
      return null;
    }) as typeof window.open;
    return {
      opened,
      restore: () => {
        window.open = original;
      },
    };
  }

  test("a ui/message carrying a numeric id is answered", async () => {
    const frame = mount("db-query", { onChat: () => {} });
    await handshake(frame);

    frame.send({
      jsonrpc: "2.0",
      id: 7,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "hi" }] },
    });

    const reply = (await frame.waitFor(replyTo(7))) as { result: unknown };
    expect(reply.result).toEqual({});
  });

  test("a ui/message whose handler throws is still answered, as an error", async () => {
    const frame = mount("db-query", {
      onChat: () => {
        throw new Error("the host failed to deliver it");
      },
    });
    await handshake(frame);

    frame.send({
      jsonrpc: "2.0",
      id: 10,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "hi" }] },
    });

    const reply = (await frame.waitFor(replyTo(10))) as { result: unknown };
    expect(reply.result).toEqual({ isError: true });
  });

  test("a ui/open-link carrying a numeric id opens the URL and is answered", async () => {
    const open = captureOpen();
    try {
      const frame = mount();
      await handshake(frame);

      frame.send({
        jsonrpc: "2.0",
        id: 8,
        method: "ui/open-link",
        params: { url: "https://example.com/forecast" },
      });

      const reply = (await frame.waitFor(replyTo(8))) as { result: unknown };
      expect(open.opened).toEqual(["https://example.com/forecast"]);
      expect(reply.result).toEqual({});
    } finally {
      open.restore();
    }
  });

  test("the notification form is still served, and answered with nothing", async () => {
    const open = captureOpen();
    try {
      const frame = mount();
      await handshake(frame);
      // Replies only: the bridge also posts a legacy `ui/initialize` notification
      // when the iframe fires `load`, which is not an answer to anything.
      const replies = () =>
        frame.inbox.filter((m) => {
          const id = (m as { id?: unknown })?.id;
          return id !== undefined && id !== null;
        });
      const before = replies().length;

      frame.send({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com/notification" },
      });
      await new Promise((r) => setTimeout(r, 25));

      expect(open.opened).toEqual(["https://example.com/notification"]);
      expect(replies().length).toBe(before);
    } finally {
      open.restore();
    }
  });

  test("a ui/update-model-context carrying id 0 is answered, because zero is an id", async () => {
    const frame = mount();
    await handshake(frame);

    frame.send({
      jsonrpc: "2.0",
      id: 0,
      method: "ui/update-model-context",
      params: { structuredContent: { visible: "rows 1-20" } },
    });

    const reply = (await frame.waitFor(replyTo(0))) as { result: unknown };
    expect(reply.result).toEqual({});
  });
});

describe("synapse/request-file", () => {
  // A JSON-RPC result is an object, and MCP types it as one. The picker used to
  // answer a bare array, a bare object, or `null` — shapes a client that
  // validates against the spec cannot parse, so the call never settled and the
  // picker hung with no error. Both paths are asserted on the wire, because the
  // wrapper is the whole fix and the old shapes were also "truthy and plausible".
  //
  // The OS picker cannot be opened here, so each path is driven at its own seam:
  // a cancel through the focus fallback the bridge installs, and a selection
  // through a stub input whose `click()` fires `change` with files attached.

  test("a cancel answers { files: [] }, not null", async () => {
    const frame = mount();
    await handshake(frame);

    frame.send({
      jsonrpc: "2.0",
      id: "pick-cancel",
      method: "synapse/request-file",
      // `multiple: false` is the case that used to answer a bare `null`.
      params: { multiple: false },
    });

    // No `change` event fires on a cancel; the bridge detects it when focus
    // returns to the window, then settles 300ms later.
    window.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("focus"));

    const reply = (await frame.waitFor(isReplyTo("pick-cancel"), 2000)) as { result: unknown };
    expect(reply.result).toEqual({ files: [] });
  });

  test("a selection answers { files: [...] } for a single file", async () => {
    const entry = { id: "fl_abc", filename: "chart.png", mimeType: "image/png", size: 12 };
    const uploaded: File[][] = [];
    const origUpload = uploadStub;
    uploadStub = async (files: File[]) => {
      uploaded.push(files);
      return { files: [entry] };
    };

    const origCreate = document.createElement.bind(document);
    const file = new File(["x"], "chart.png", { type: "image/png" });
    document.createElement = ((tag: string) => {
      const el = origCreate(tag) as HTMLInputElement;
      if (tag !== "input") return el;
      Object.defineProperty(el, "files", { configurable: true, get: () => [file] });
      // The bridge calls click() to open the picker; fire the selection instead.
      el.click = () => {
        el.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("change"));
      };
      return el;
    }) as typeof document.createElement;

    try {
      const frame = mount();
      await handshake(frame);

      frame.send({
        jsonrpc: "2.0",
        id: "pick-one",
        method: "synapse/request-file",
        params: { multiple: false, maxSize: 1024 },
      });

      const reply = (await frame.waitFor(isReplyTo("pick-one"), 2000)) as { result: unknown };
      // Wrapped, and still wrapped for one file — `pickFile` unwraps SDK-side.
      expect(reply.result).toEqual({ files: [entry] });
      expect(uploaded).toHaveLength(1);
    } finally {
      document.createElement = origCreate as typeof document.createElement;
      uploadStub = origUpload;
    }
  });

  test("multiple: true answers every entry under the same key", async () => {
    const entries = [
      { id: "fl_a", filename: "a.png", mimeType: "image/png", size: 1 },
      { id: "fl_b", filename: "b.png", mimeType: "image/png", size: 2 },
    ];
    const origUpload = uploadStub;
    uploadStub = async () => ({ files: entries });

    const origCreate = document.createElement.bind(document);
    const picked = [
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.png", { type: "image/png" }),
    ];
    document.createElement = ((tag: string) => {
      const el = origCreate(tag) as HTMLInputElement;
      if (tag !== "input") return el;
      Object.defineProperty(el, "files", { configurable: true, get: () => picked });
      el.click = () => {
        el.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("change"));
      };
      return el;
    }) as typeof document.createElement;

    try {
      const frame = mount();
      await handshake(frame);

      frame.send({
        jsonrpc: "2.0",
        id: "pick-many",
        method: "synapse/request-file",
        params: { multiple: true, maxSize: 1024 },
      });

      const reply = (await frame.waitFor(isReplyTo("pick-many"), 2000)) as { result: unknown };
      // `multiple` sizes the picker and nothing else: one file or many, the
      // entries arrive under `files`, in order.
      expect(reply.result).toEqual({ files: entries });
    } finally {
      document.createElement = origCreate as typeof document.createElement;
      uploadStub = origUpload;
    }
  });
});
