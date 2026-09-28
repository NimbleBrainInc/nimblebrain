// ---------------------------------------------------------------------------
// App state lifetime
//
// `ui/update-model-context` is the pushing view's current context, so the
// state lives exactly as long as that view's bridge. `getAppState` answers
// from the live bridges of an app; a destroyed bridge contributes nothing,
// a reopened view reports nothing until it pushes its own state, and a view
// on screen beats one scrolled out of sight.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../../test/setup";

mock.module("../../api/client", () => ({
  ...realClient,
  getActiveWorkspaceId: () => "ws_test",
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

const { createBridge, getAppState } = await import("../../bridge/bridge");

// The test DOM has no layout, so a stub observer lets each view report its
// own visibility: `setOnScreen` delivers the entry a real observer would.
const screenCallbacks = new Map<Element, IntersectionObserverCallback>();
const RealIntersectionObserver = globalThis.IntersectionObserver;
globalThis.IntersectionObserver = class {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    screenCallbacks.set(target, this.callback);
  }
  disconnect() {}
} as unknown as typeof IntersectionObserver;

afterAll(() => {
  globalThis.IntersectionObserver = RealIntersectionObserver;
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface View {
  destroy(): void;
  push(state: Record<string, unknown>): void;
  setOnScreen(onScreen: boolean): void;
}

const live: Array<{ destroy(): void }> = [];

afterEach(() => {
  for (const cleanup of live.splice(0)) cleanup.destroy();
});

/** Mount a bridge on a stub iframe; `push` sends it a ui/update-model-context. */
function mountView(appName: string): View {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const stubWindow = { postMessage() {} } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => stubWindow });

  const bridge = createBridge(iframe, appName);
  let destroyed = false;
  const view: View = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      bridge.destroy();
      document.body.removeChild(iframe);
    },
    push(state) {
      const WindowMessageEvent = (window as unknown as { MessageEvent: typeof MessageEvent })
        .MessageEvent;
      const event = new WindowMessageEvent("message", {
        data: {
          jsonrpc: "2.0",
          method: "ui/update-model-context",
          params: { structuredContent: state },
        },
      });
      Object.defineProperty(event, "source", { configurable: true, get: () => stubWindow });
      window.dispatchEvent(event);
    },
    setOnScreen(onScreen) {
      const entry = { isIntersecting: onScreen } as IntersectionObserverEntry;
      screenCallbacks.get(iframe)?.([entry], {} as IntersectionObserver);
    },
  };
  live.push(view);
  return view;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app state lifetime", () => {
  test("a view's state is gone once its bridge is destroyed", () => {
    const view = mountView("lifetime-destroy");
    view.push({ visible: "rows 1-20" });
    expect(getAppState("lifetime-destroy")?.state).toEqual({ visible: "rows 1-20" });

    view.destroy();
    expect(getAppState("lifetime-destroy")).toBeUndefined();
  });

  test("destroying one of two views of an app keeps the other's state", () => {
    const slot = mountView("lifetime-two");
    const inline = mountView("lifetime-two");
    slot.push({ from: "slot" });
    inline.push({ from: "inline" });

    inline.destroy();
    expect(getAppState("lifetime-two")?.state).toEqual({ from: "slot" });
  });

  test("with two live views, the most recent push wins", () => {
    const slot = mountView("lifetime-latest");
    const inline = mountView("lifetime-latest");
    slot.push({ from: "slot", n: 1 });
    inline.push({ from: "inline" });
    expect(getAppState("lifetime-latest")?.state).toEqual({ from: "inline" });

    slot.push({ from: "slot", n: 2 });
    expect(getAppState("lifetime-latest")?.state).toEqual({ from: "slot", n: 2 });
  });

  test("a view on screen beats a later push from one off screen", () => {
    const slot = mountView("lifetime-screen");
    const inline = mountView("lifetime-screen");
    inline.setOnScreen(false);
    slot.push({ from: "slot" });
    inline.push({ from: "inline" });
    expect(getAppState("lifetime-screen")?.state).toEqual({ from: "slot" });

    inline.setOnScreen(true);
    expect(getAppState("lifetime-screen")?.state).toEqual({ from: "inline" });
  });

  test("with no view on screen, the most recent push still answers", () => {
    const slot = mountView("lifetime-offscreen");
    const inline = mountView("lifetime-offscreen");
    slot.push({ from: "slot" });
    inline.push({ from: "inline" });
    slot.setOnScreen(false);
    inline.setOnScreen(false);
    expect(getAppState("lifetime-offscreen")?.state).toEqual({ from: "inline" });
  });

  test("a reopened view reports nothing until it pushes", () => {
    const first = mountView("lifetime-reopen");
    first.push({ record: "old" });
    first.destroy();

    const reopened = mountView("lifetime-reopen");
    expect(getAppState("lifetime-reopen")).toBeUndefined();

    reopened.push({ record: "new" });
    expect(getAppState("lifetime-reopen")?.state).toEqual({ record: "new" });
  });

  test("state is scoped to the app that pushed it", () => {
    mountView("lifetime-a").push({ app: "a" });
    expect(getAppState("lifetime-b")).toBeUndefined();
  });
});
