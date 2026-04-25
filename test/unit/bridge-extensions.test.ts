import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { BridgeCallbacks } from "../../web/src/bridge/types.ts";

// ---------------------------------------------------------------------------
// Minimal DOM mocks — enough to exercise the bridge's postMessage handling
// without a full browser environment.
// ---------------------------------------------------------------------------

type Listener = (event: unknown) => void;

/** Fake iframe whose contentWindow can capture postMessage calls. */
function makeFakeIframe() {
  const posted: unknown[] = [];
  const loadListeners: Listener[] = [];

  const iframe = {
    contentWindow: {
      postMessage(data: unknown, _origin: string) {
        posted.push(data);
      },
    },
    addEventListener(event: string, fn: Listener) {
      if (event === "load") loadListeners.push(fn);
    },
    removeEventListener(event: string, fn: Listener) {
      if (event === "load") {
        const idx = loadListeners.indexOf(fn);
        if (idx >= 0) loadListeners.splice(idx, 1);
      }
    },
  } as unknown as HTMLIFrameElement;

  return { iframe, posted, loadListeners };
}

// Track window-level event listeners so we can dispatch MessageEvents manually.
const windowListeners = new Map<string, Set<Listener>>();
const customEventsFired: { type: string; detail: unknown }[] = [];

const origAddEventListener = globalThis.window?.addEventListener;
const origRemoveEventListener = globalThis.window?.removeEventListener;
const origDispatchEvent = globalThis.window?.dispatchEvent;

beforeEach(() => {
  windowListeners.clear();
  customEventsFired.length = 0;

  // Provide a minimal `window` shim when running outside a browser.
  if (typeof globalThis.window === "undefined") {
    (globalThis as Record<string, unknown>).window = globalThis;
  }

  (globalThis as unknown as { open: unknown }).open = mock(() => null);

  globalThis.window.addEventListener = ((type: string, fn: Listener) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type)!.add(fn);
  }) as unknown as typeof window.addEventListener;

  globalThis.window.removeEventListener = ((type: string, fn: Listener) => {
    windowListeners.get(type)?.delete(fn);
  }) as unknown as typeof window.removeEventListener;

  globalThis.window.dispatchEvent = ((event: Event & { detail?: unknown }) => {
    customEventsFired.push({ type: event.type, detail: event.detail });
    return true;
  }) as unknown as typeof window.dispatchEvent;

  // Provide a minimal document shim so getHostThemeMode() doesn't throw.
  if (typeof globalThis.document === "undefined") {
    (globalThis as Record<string, unknown>).document = {
      documentElement: { classList: { contains: () => false } },
    };
  }

  // Provide window.location so bridge can read origin.
  if (!globalThis.window?.location) {
    (globalThis.window as Record<string, unknown>).location = {
      origin: "http://localhost:27246",
      href: "http://localhost:27246/",
    };
  }

  // Provide CustomEvent if missing (Bun doesn't ship it outside happy-dom).
  if (typeof globalThis.CustomEvent === "undefined") {
    (globalThis as Record<string, unknown>).CustomEvent = class FakeCustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    };
  }
});

afterEach(() => {
  if (origAddEventListener) globalThis.window.addEventListener = origAddEventListener;
  if (origRemoveEventListener) globalThis.window.removeEventListener = origRemoveEventListener;
  if (origDispatchEvent) globalThis.window.dispatchEvent = origDispatchEvent;
});

/** Simulate a postMessage from the iframe to the host. */
function simulatePostMessage(
  iframe: HTMLIFrameElement,
  data: unknown,
) {
  const listeners = windowListeners.get("message");
  if (!listeners) return;
  const event = { data, source: iframe.contentWindow } as MessageEvent;
  for (const fn of listeners) fn(event);
}

// We need to import *after* mocking window so the bridge module picks up our shims.
// Dynamic import inside each describe would be ideal, but to keep it simple we rely
// on the beforeEach running before the bridge registers its listener (which it does
// only when createBridge is called).

// eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic import after mocks
const { createBridge } = await import("../../web/src/bridge/bridge.ts");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bridge — ui/message (spec format)", () => {
  it("dispatches nb:chat custom event when no callback is provided", () => {
    const { iframe } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "hello from iframe" }] },
    });

    expect(customEventsFired).toContainEqual({
      type: "nb:chat",
      detail: { message: "hello from iframe", context: undefined },
    });

    handle.destroy();
  });

  it("invokes onChat callback when provided", () => {
    const { iframe } = makeFakeIframe();
    const received: string[] = [];
    const callbacks: BridgeCallbacks = {
      onChat: (msg) => received.push(msg),
    };
    const handle = createBridge(iframe, "test-app", callbacks);

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "callback chat" }] },
    });

    expect(received).toEqual(["callback chat"]);
    // Should NOT dispatch a custom event when callback handles it.
    expect(customEventsFired.filter((e) => e.type === "nb:chat")).toHaveLength(0);

    handle.destroy();
  });

  it("extracts _meta.context from content blocks", () => {
    const { iframe } = makeFakeIframe();
    const received: Array<{ msg: string; ctx: unknown }> = [];
    const handle = createBridge(iframe, "test-app", {
      onChat: (msg, ctx) => received.push({ msg, ctx }),
    });

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      method: "ui/message",
      params: {
        role: "user",
        content: [{ type: "text", text: "with context", _meta: { context: { action: "test" } } }],
      },
    });

    expect(received[0]?.msg).toBe("with context");
    expect(received[0]?.ctx).toEqual({ action: "test" });

    handle.destroy();
  });
});

describe("Bridge — ui/message prompt action", () => {
  it("handles prompt action extension", () => {
    const { iframe } = makeFakeIframe();
    const prompts: string[] = [];
    const handle = createBridge(iframe, "test-app", {
      onPromptAction: (p) => prompts.push(p),
    });

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      method: "ui/message",
      params: { action: "prompt", value: "suggested prompt" },
    });

    expect(prompts).toEqual(["suggested prompt"]);
    handle.destroy();
  });

  it("handles ui/open-link by calling window.open", () => {
    const { iframe } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      method: "ui/open-link",
      params: { url: "https://example.com" },
    });

    expect((globalThis as unknown as { open: ReturnType<typeof mock> }).open).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener",
    );

    handle.destroy();
  });

  it("handles ui/notifications/size-changed via callback", () => {
    const { iframe } = makeFakeIframe();
    const heights: number[] = [];
    const handle = createBridge(iframe, "test-app", {
      onResize: (h) => heights.push(h),
    });

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 500 },
    });

    expect(heights).toEqual([500]);
    handle.destroy();
  });
});

describe("Bridge — ext-apps dual protocol", () => {
  it("responds to ext-apps ui/initialize request with handshake", () => {
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    // ext-apps App class sends ui/initialize as a JSON-RPC request (has id)
    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: "init-1",
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        clientInfo: { name: "TestApp", version: "1.0.0" },
        capabilities: {},
      },
    });

    // Should respond with a proper JSON-RPC result
    const response = posted.find(
      (m: unknown) => (m as Record<string, unknown>).id === "init-1" && "result" in (m as Record<string, unknown>),
    ) as Record<string, unknown> | undefined;
    expect(response).toBeDefined();
    expect(response!.jsonrpc).toBe("2.0");
    const result = response!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2026-01-26");
    expect(result.hostInfo).toEqual({ name: "nimblebrain", version: "1.0.0" });
    expect(result.hostCapabilities).toBeDefined();

    handle.destroy();
  });

  it("responds to ui/initialize when id is a number (ext-apps SDK / Reboot client default)", () => {
    // `@modelcontextprotocol/ext-apps` client (which Reboot's React app uses via
    // `@reboot-dev/reboot-react`) sends request IDs as numbers starting at 0.
    // JSON-RPC 2.0 allows both strings and numbers — a prior string-only check
    // left Reboot iframes stuck at "Connecting to MCP host..." forever.
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: 0,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        clientInfo: { name: "TestApp", version: "1.0.0" },
        capabilities: {},
      },
    });

    const response = posted.find(
      (m: unknown) =>
        (m as Record<string, unknown>).id === 0 && "result" in (m as Record<string, unknown>),
    ) as Record<string, unknown> | undefined;
    expect(response).toBeDefined();
    expect(response!.jsonrpc).toBe("2.0");
    const result = response!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2026-01-26");

    handle.destroy();
  });

  it("accepts ui/initialize with numeric edge-case IDs (negative, MAX_SAFE_INTEGER)", () => {
    // All JS numbers are valid JSON-RPC ids per spec; pick two uncommon ones
    // to catch any accidental coercion-via-truthiness or integer-overflow
    // checks sneaking into the handler.
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    for (const id of [-1, Number.MAX_SAFE_INTEGER]) {
      simulatePostMessage(iframe, {
        jsonrpc: "2.0",
        id,
        method: "ui/initialize",
        params: {
          protocolVersion: "2026-01-26",
          clientInfo: { name: "T", version: "1" },
          capabilities: {},
        },
      });
    }

    const responses = posted.filter(
      (m: unknown) => "result" in (m as Record<string, unknown>),
    ) as Record<string, unknown>[];
    expect(responses.some((r) => r.id === -1)).toBe(true);
    expect(responses.some((r) => r.id === Number.MAX_SAFE_INTEGER)).toBe(true);

    handle.destroy();
  });

  it("ui/initialize response filters hostContext.styles.variables to spec-allowed keys only", () => {
    // Strict ext-apps SDK clients (Reboot's `@reboot-dev/reboot-react` uses
    // Zod to validate the response) reject unknown variable keys. Our theme
    // map contains NB extensions (`--nb-*`) and a couple of out-of-spec
    // legacy keys (`--color-text-accent`, `--font-text-base-*`); those must
    // not appear on the wire.
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: 7,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        clientInfo: { name: "T", version: "1" },
        capabilities: {},
      },
    });

    const response = posted.find(
      (m: unknown) =>
        (m as Record<string, unknown>).id === 7 && "result" in (m as Record<string, unknown>),
    ) as Record<string, unknown> | undefined;
    const hostContext = (response!.result as Record<string, unknown>).hostContext as {
      styles: { variables: Record<string, string> };
    };
    const keys = Object.keys(hostContext.styles.variables);
    expect(keys.some((k) => k.startsWith("--nb-"))).toBe(false);
    expect(keys).not.toContain("--color-text-accent");
    expect(keys).not.toContain("--font-text-base-size");
    expect(keys).not.toContain("--font-text-base-line-height");
    // And we should still be sending the core spec-allowed ones
    expect(keys).toContain("--color-background-primary");
    expect(keys).toContain("--font-sans");

    handle.destroy();
  });

  it("setHostContext filters hostContext.styles.variables centrally (all callers)", () => {
    // Regression guard for the theme-toggle path: SlotRenderer was calling
    // setHostContext with unfiltered tokens (--nb-* keys included), tearing
    // down strict Zod-validating clients on every theme toggle. The filter
    // now lives INSIDE bridge.setHostContext so callers can't bypass.
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    // Pass unfiltered tokens that include an NB extension and an out-of-spec key.
    handle.setHostContext({
      theme: "light",
      styles: {
        variables: {
          "--color-background-primary": "#fff",
          "--nb-color-danger": "#dc2626",
          "--color-text-accent": "#0055FF",
        },
      },
    });

    const notification = posted.find(
      (m: unknown) =>
        (m as Record<string, unknown>).method === "ui/notifications/host-context-changed",
    ) as Record<string, unknown> | undefined;
    expect(notification).toBeDefined();
    const params = notification!.params as {
      styles: { variables: Record<string, string> };
    };
    const keys = Object.keys(params.styles.variables);
    // `--nb-*` and `--color-text-accent` must not cross the wire
    expect(keys.some((k) => k.startsWith("--nb-"))).toBe(false);
    expect(keys).not.toContain("--color-text-accent");
    expect(keys).not.toContain("--font-text-base-size");
    // Spec-allowed keys are present
    expect(keys).toContain("--color-background-primary");

    handle.destroy();
  });

  it("accepts ui/notifications/initialized without error", () => {
    const { iframe } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    // Should not throw
    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      method: "ui/notifications/initialized",
      params: {},
    });

    handle.destroy();
  });

  it("accepts ui/notifications/request-teardown without error", () => {
    const { iframe } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    // Should not throw
    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      method: "ui/notifications/request-teardown",
      params: {},
    });

    handle.destroy();
  });

  it("still sends legacy ui/initialize notification on iframe load", () => {
    const { iframe, posted, loadListeners } = makeFakeIframe();
    createBridge(iframe, "test-app");

    // Simulate iframe load
    for (const fn of loadListeners) fn({});

    const initMsg = posted.find(
      (m: unknown) => (m as Record<string, unknown>).method === "ui/initialize" && !("id" in (m as Record<string, unknown>)),
    );
    expect(initMsg).toBeDefined();
  });

  it("setHostContext sends ext-apps host-context-changed notification", () => {
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    handle.setHostContext({ theme: "dark" });

    const msg = posted.find(
      (m: unknown) => (m as Record<string, unknown>).method === "ui/notifications/host-context-changed",
    ) as Record<string, unknown> | undefined;
    expect(msg).toBeDefined();
    expect((msg!.params as Record<string, unknown>).theme).toBe("dark");

    handle.destroy();
  });

  it("sendToolInput sends ext-apps tool-input notification", () => {
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    handle.sendToolInput({ arguments: { location: "NYC" } });

    const msg = posted.find(
      (m: unknown) => (m as Record<string, unknown>).method === "ui/notifications/tool-input",
    ) as Record<string, unknown> | undefined;
    expect(msg).toBeDefined();
    expect((msg!.params as Record<string, unknown>).arguments).toEqual({ location: "NYC" });

    handle.destroy();
  });

  it("tools/call works without server param (ext-apps style)", async () => {
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    // ext-apps sends tools/call without server param
    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: "tc-1",
      method: "tools/call",
      params: { name: "get_greeting", arguments: { name: "World" } },
    });

    // The bridge should route via appName ("test-app") regardless of missing server param.
    // We can't easily test the full fetch chain, but we can verify it doesn't crash.
    // The tool call will fail (no real server), but the bridge should send an error response.
    await new Promise((r) => setTimeout(r, 50));

    // Should have attempted to respond (either result or error)
    const response = posted.find(
      (m: unknown) => (m as Record<string, unknown>).id === "tc-1",
    );
    expect(response).toBeDefined();

    handle.destroy();
  });
});

describe("Bridge — unknown message types", () => {
  it("ignores unknown methods without crashing", () => {
    const { iframe } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    // Should not throw.
    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      method: "ui/unknownMethod",
      params: {},
    });

    // No custom events should have been fired.
    expect(customEventsFired).toHaveLength(0);

    handle.destroy();
  });

  it("ignores malformed messages (no method)", () => {
    const { iframe } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    simulatePostMessage(iframe, { foo: "bar" });
    simulatePostMessage(iframe, null);
    simulatePostMessage(iframe, "just a string");

    expect(customEventsFired).toHaveLength(0);
    handle.destroy();
  });
});

// ---------------------------------------------------------------------------
// ui/initialize hostContext extensions
// ---------------------------------------------------------------------------

describe("Bridge — ui/initialize hostContext extensions", () => {
  /** Find the response posted in reply to a `ui/initialize` request. */
  function findInitResponse(posted: unknown[]) {
    return posted.find(
      (m) =>
        m &&
        typeof m === "object" &&
        (m as Record<string, unknown>).id === "init-1" &&
        typeof (m as Record<string, unknown>).result === "object",
    ) as { result: { hostContext: Record<string, unknown> } } | undefined;
  }

  it("merges getHostExtensions() into hostContext alongside spec fields", () => {
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app", {
      getHostExtensions: () => ({ workspace: { id: "ws_a", name: "Alpha" } }),
    });

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: "init-1",
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26", appInfo: { name: "x", version: "1" } },
    });

    const response = findInitResponse(posted);
    expect(response?.result.hostContext).toMatchObject({
      workspace: { id: "ws_a", name: "Alpha" },
      theme: expect.anything(),
      styles: expect.anything(),
    });
    handle.destroy();
  });

  it("invokes getHostExtensions() exactly once per ui/initialize", () => {
    const { iframe } = makeFakeIframe();
    let calls = 0;
    const handle = createBridge(iframe, "test-app", {
      getHostExtensions: () => {
        calls++;
        return { workspace: { id: "ws_a", name: "Alpha" } };
      },
    });

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: "init-1",
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26", appInfo: { name: "x", version: "1" } },
    });

    expect(calls).toBe(1);
    handle.destroy();
  });

  it("spec fields (theme, styles) win over same-named extension keys", () => {
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app", {
      getHostExtensions: () => ({
        // Adversarial caller tries to override a spec field — bridge must ignore.
        theme: "WRONG",
        styles: { variables: { "--evil": "true" } },
        workspace: { id: "ws_a", name: "Alpha" },
      }),
    });

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: "init-1",
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26", appInfo: { name: "x", version: "1" } },
    });

    const response = findInitResponse(posted);
    const ctx = response?.result.hostContext as Record<string, unknown>;
    expect(ctx.theme).not.toBe("WRONG");
    expect((ctx.styles as Record<string, unknown>).variables).not.toMatchObject({ "--evil": "true" });
    expect(ctx.workspace).toEqual({ id: "ws_a", name: "Alpha" });
    handle.destroy();
  });

  it("missing getHostExtensions yields a hostContext with no extensions", () => {
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app");

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: "init-1",
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26", appInfo: { name: "x", version: "1" } },
    });

    const response = findInitResponse(posted);
    const ctx = response?.result.hostContext as Record<string, unknown>;
    expect(ctx).toMatchObject({ theme: expect.anything(), styles: expect.anything() });
    expect(ctx.workspace).toBeUndefined();
    handle.destroy();
  });

  it("a throwing getHostExtensions does not drop the ui/initialize response", () => {
    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "test-app", {
      getHostExtensions: () => {
        throw new Error("boom");
      },
    });

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: "init-1",
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26", appInfo: { name: "x", version: "1" } },
    });

    const response = findInitResponse(posted);
    expect(response).toBeDefined();
    const ctx = response?.result.hostContext as Record<string, unknown>;
    // Spec fields still present; extensions silently dropped on throw.
    expect(ctx).toMatchObject({ theme: expect.anything(), styles: expect.anything() });
    expect(ctx.workspace).toBeUndefined();
    handle.destroy();
  });
});
