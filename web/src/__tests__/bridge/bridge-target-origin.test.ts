// ---------------------------------------------------------------------------
// Bridge handshake `hostContext.origin` (issue #99)
//
// The platform's iframe bridge sends `hostContext.origin =
// window.location.origin` in the ext-apps `ui/initialize` response so the
// Synapse SDK helper can use it as `targetOrigin` on iframe→parent
// postMessage and validate `event.origin` on inbound.
//
// Host outbound postMessage stays `"*"` because the iframes are srcdoc
// (opaque "null" origin) and `postMessage` does not accept the literal
// "null" string as a targetOrigin — `"*"` is the only legal value for
// targeting a null-origin window. Tightening host→iframe requires the
// sandbox-proxy work tracked in iframe.ts and is out of scope here.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../mcp-bridge-client", () => ({
  getMcpBridgeClient: async () => ({
    callTool: async () => ({ content: [], structuredContent: {} }),
    readResource: async () => ({ contents: [] }),
    request: async () => ({}),
    setNotificationHandler: () => {},
    removeNotificationHandler: () => {},
  }),
  resetMcpBridgeClient: () => {},
  withSessionRetry: async <T>(op: () => Promise<T>): Promise<T> => op(),
}));

const { createBridge } = await import("../../bridge/bridge");

interface CapturedPost {
  data: unknown;
  targetOrigin: string;
}

interface TestIframe {
  iframe: HTMLIFrameElement;
  posts: CapturedPost[];
  send(data: unknown): void;
  waitFor(pred: (p: CapturedPost) => boolean, timeoutMs?: number): Promise<CapturedPost>;
  cleanup(): void;
}

function makeTestIframe(): TestIframe {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);

  const posts: CapturedPost[] = [];
  const stubWindow = {
    postMessage(data: unknown, targetOrigin: string) {
      posts.push({ data, targetOrigin });
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

  async function waitFor(
    pred: (p: CapturedPost) => boolean,
    timeoutMs = 500,
  ): Promise<CapturedPost> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = posts.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`Timed out; posts: ${JSON.stringify(posts, null, 2)}`);
  }

  return {
    iframe,
    posts,
    send,
    waitFor,
    cleanup: () => document.body.removeChild(iframe),
  };
}

let activeBridge: { destroy(): void } | null = null;
let activeFrame: TestIframe | null = null;

beforeEach(() => {
  activeBridge = null;
  activeFrame = null;
});

afterEach(() => {
  activeBridge?.destroy();
  activeFrame?.cleanup();
});

function mount(appName: string): TestIframe {
  const frame = makeTestIframe();
  activeFrame = frame;
  activeBridge = createBridge(frame.iframe, appName);
  return frame;
}

describe("ext-apps handshake hostContext.origin", () => {
  test("ui/initialize response includes hostContext.origin = window.location.origin", async () => {
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: 7,
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26" },
    });

    const reply = (await frame.waitFor((p) => (p.data as { id?: number })?.id === 7)).data as {
      result: { hostContext: { origin?: string } };
    };

    expect(reply.result.hostContext.origin).toBe(window.location.origin);
  });
});

describe("host → iframe postMessage targetOrigin (regression pin)", () => {
  // The literal string "null" is NOT a valid `postMessage` targetOrigin —
  // browsers throw `DOMException: An invalid or illegal string was
  // specified`. For srcdoc iframes (opaque "null" origin), the spec-
  // sanctioned values are "*" or "/", and only "*" actually delivers.
  // Pin to "*" so any future tightening attempt has to also solve the
  // null-origin problem (likely via sandbox-proxy).
  test("ui/initialize response uses targetOrigin '*' (srcdoc null-origin constraint)", async () => {
    const frame = mount("synapse-research");

    frame.send({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26" },
    });

    const reply = await frame.waitFor((p) => (p.data as { id?: number })?.id === 1);
    expect(reply.targetOrigin).toBe("*");
  });
});
