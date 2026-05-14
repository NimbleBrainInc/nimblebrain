/**
 * Tests for `GET /iframe-bridge.js` and the bundled helper script (issue #99).
 *
 * Verifies:
 *   - Route serves the helper as JS with the expected content-type and
 *     short cache TTL.
 *   - Helper script, when executed in a fresh window, exposes the
 *     `NBBridge.{send, on, getHostOrigin}` surface and obeys the
 *     handshake-then-pin origin model.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { IFRAME_BRIDGE_SCRIPT } from "../../../src/api/iframe-bridge-script.ts";
import { iframeBridgeRoutes } from "../../../src/api/routes/iframe-bridge.ts";
import type { AppContext } from "../../../src/api/types.ts";

function createApp() {
  const app = new Hono();
  app.route("/", iframeBridgeRoutes({} as AppContext));
  return app;
}

describe("GET /iframe-bridge.js", () => {
  it("serves the helper as JavaScript", async () => {
    const res = await createApp().request("http://platform.example.com/iframe-bridge.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toContain("max-age=");
    const body = await res.text();
    expect(body).toContain("window.NBBridge");
    expect(body).toContain("getHostOrigin");
  });
});

// ---------------------------------------------------------------------------
// Helper-script behavior — eval the script into a minimal window stub so we
// don't depend on happy-dom (the script is plain ES5, no DOM APIs beyond
// window/parent/addEventListener/postMessage).
// ---------------------------------------------------------------------------

interface CapturedPost {
  data: unknown;
  targetOrigin: string;
}

interface FakeWindow {
  parent: object;
  addEventListener(event: string, handler: (e: unknown) => void): void;
  // Populated by the helper.
  NBBridge?: {
    send(message: unknown): void;
    on(method: string, handler: (msg: { method: string; params?: unknown }) => void): void;
    getHostOrigin(): string | null;
  };
}

function loadHelper(): {
  window: FakeWindow;
  parentInbox: CapturedPost[];
  deliver: (data: unknown, origin: string, source?: object) => void;
} {
  const parentInbox: CapturedPost[] = [];
  const parentStub = {
    postMessage(data: unknown, targetOrigin: string) {
      parentInbox.push({ data, targetOrigin });
    },
  };

  const listeners: Array<(e: unknown) => void> = [];
  const fakeWindow: FakeWindow = {
    parent: parentStub,
    addEventListener(event, handler) {
      if (event === "message") listeners.push(handler);
    },
  };

  // Evaluate the helper with `window` bound to our stub.
  const fn = new Function("window", IFRAME_BRIDGE_SCRIPT);
  fn(fakeWindow);

  function deliver(data: unknown, origin: string, source: object = parentStub): void {
    const event = { data, origin, source };
    for (const handler of listeners) handler(event);
  }

  return { window: fakeWindow, parentInbox, deliver };
}

describe("NBBridge helper behavior", () => {
  it("queues outbound sends until the host origin is pinned, then flushes with pinned origin", () => {
    const { window: w, parentInbox, deliver } = loadHelper();

    // Pre-handshake: queued, no postMessage yet.
    w.NBBridge?.send({ method: "ui/notifications/size-changed", params: { height: 100 } });
    expect(parentInbox).toHaveLength(0);

    // Handshake: legacy ui/initialize notification with matching apiBase.
    deliver(
      {
        jsonrpc: "2.0",
        method: "ui/initialize",
        params: { apiBase: "http://platform.example.com" },
      },
      "http://platform.example.com",
    );

    expect(w.NBBridge?.getHostOrigin()).toBe("http://platform.example.com");
    expect(parentInbox).toHaveLength(1);
    expect(parentInbox[0]?.targetOrigin).toBe("http://platform.example.com");
    expect((parentInbox[0]?.data as { params?: { height?: number } })?.params?.height).toBe(100);

    // Post-handshake: sends go straight through with pinned origin.
    w.NBBridge?.send({ method: "ui/notifications/size-changed", params: { height: 200 } });
    expect(parentInbox).toHaveLength(2);
    expect(parentInbox[1]?.targetOrigin).toBe("http://platform.example.com");
  });

  it("captures host origin from ext-apps ui/initialize response (hostContext.origin)", () => {
    const { window: w, deliver } = loadHelper();

    deliver(
      {
        jsonrpc: "2.0",
        id: 1,
        result: { hostContext: { origin: "https://prod.nimblebrain.ai" } },
      },
      "https://prod.nimblebrain.ai",
    );

    expect(w.NBBridge?.getHostOrigin()).toBe("https://prod.nimblebrain.ai");
  });

  it("rejects handshake when the claimed origin doesn't match event.origin (pretender protection)", () => {
    const { window: w, deliver } = loadHelper();

    // Attacker claims to be the host but their event.origin doesn't match.
    deliver(
      {
        jsonrpc: "2.0",
        method: "ui/initialize",
        params: { apiBase: "http://platform.example.com" },
      },
      "https://evil.example.com",
    );

    expect(w.NBBridge?.getHostOrigin()).toBe(null);
  });

  it("ignores messages whose source is not window.parent", () => {
    const { window: w, deliver } = loadHelper();
    const handlerCalls: number[] = [];
    w.NBBridge?.on("notify", () => handlerCalls.push(1));

    // Handshake with a non-parent source — should not pin origin nor dispatch.
    const otherWindow = { foo: "bar" };
    deliver(
      {
        jsonrpc: "2.0",
        method: "ui/initialize",
        params: { apiBase: "http://platform.example.com" },
      },
      "http://platform.example.com",
      otherWindow,
    );
    expect(w.NBBridge?.getHostOrigin()).toBe(null);
    expect(handlerCalls).toHaveLength(0);
  });

  it("drops post-handshake messages from a different origin", () => {
    const { window: w, deliver } = loadHelper();
    const received: Array<{ method: string }> = [];
    w.NBBridge?.on("synapse/tool-result", (m) => received.push(m));

    // Pin the host.
    deliver(
      {
        jsonrpc: "2.0",
        method: "ui/initialize",
        params: { apiBase: "http://platform.example.com" },
      },
      "http://platform.example.com",
    );

    // Legitimate message from pinned origin — dispatched.
    deliver({ method: "synapse/tool-result", params: { result: {} } }, "http://platform.example.com");
    expect(received).toHaveLength(1);

    // Forgery from a different origin — dropped.
    deliver({ method: "synapse/tool-result", params: { result: {} } }, "https://evil.example.com");
    expect(received).toHaveLength(1);
  });

  it("on() only dispatches handlers registered for the matching method", () => {
    const { window: w, deliver } = loadHelper();
    const a: number[] = [];
    const b: number[] = [];
    w.NBBridge?.on("alpha", () => a.push(1));
    w.NBBridge?.on("beta", () => b.push(1));

    deliver(
      {
        jsonrpc: "2.0",
        method: "ui/initialize",
        params: { apiBase: "http://h.example.com" },
      },
      "http://h.example.com",
    );
    deliver({ method: "alpha" }, "http://h.example.com");
    deliver({ method: "alpha" }, "http://h.example.com");
    deliver({ method: "beta" }, "http://h.example.com");

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
  });
});
