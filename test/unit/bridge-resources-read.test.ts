import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal DOM mocks — same approach as bridge-extensions.test.ts, but scoped
// to the resources/read message flow.
// ---------------------------------------------------------------------------

type Listener = (event: unknown) => void;

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

const windowListeners = new Map<string, Set<Listener>>();

beforeEach(() => {
  windowListeners.clear();

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

  globalThis.window.dispatchEvent = (() => true) as unknown as typeof window.dispatchEvent;

  if (typeof globalThis.document === "undefined") {
    (globalThis as Record<string, unknown>).document = {
      documentElement: { classList: { contains: () => false } },
    };
  }
  if (!globalThis.window?.location) {
    (globalThis.window as Record<string, unknown>).location = {
      origin: "http://localhost:27246",
      href: "http://localhost:27246/",
    };
  }
});

afterEach(() => {
  mock.restore();
});

function simulatePostMessage(iframe: HTMLIFrameElement, data: unknown) {
  const listeners = windowListeners.get("message");
  if (!listeners) return;
  const event = { data, source: iframe.contentWindow } as MessageEvent;
  for (const fn of listeners) fn(event);
}

const readResourceMock = mock(async (_server: string, _uri: string) => ({
  contents: [{ uri: "ui://x/y", text: "ok" }],
}));
const callToolMock = mock(async () => ({
  content: [],
  isError: false,
}));

mock.module("../../web/src/api/client", () => ({
  callTool: callToolMock,
  readResource: readResourceMock,
}));

const { createBridge } = await import("../../web/src/bridge/bridge.ts");

describe("Bridge — resources/read", () => {
  it("forwards the uri to the readResource client and posts the result verbatim", async () => {
    readResourceMock.mockImplementationOnce(async () => ({
      contents: [
        {
          uri: "collateral://exports/e.pdf",
          mimeType: "application/pdf",
          blob: "JVBERi0=",
        },
      ],
    }));

    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "collateral");

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: "rr-1",
      method: "resources/read",
      params: { uri: "collateral://exports/e.pdf" },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(readResourceMock).toHaveBeenCalledWith("collateral", "collateral://exports/e.pdf");

    const response = posted.find(
      (m: unknown) => (m as Record<string, unknown>).id === "rr-1",
    ) as Record<string, unknown> | undefined;
    expect(response).toBeDefined();
    expect(response!.jsonrpc).toBe("2.0");
    const result = response!.result as { contents: unknown[] };
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toEqual({
      uri: "collateral://exports/e.pdf",
      mimeType: "application/pdf",
      blob: "JVBERi0=",
    });

    handle.destroy();
  });

  it("scopes the read to appName by default (ignores params.server for non-internal apps)", async () => {
    const { iframe } = makeFakeIframe();
    const handle = createBridge(iframe, "crm");

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: "rr-2",
      method: "resources/read",
      params: { uri: "ui://crm/main", server: "attacker" },
    });

    await new Promise((r) => setTimeout(r, 10));

    const calls = readResourceMock.mock.calls;
    const last = calls[calls.length - 1];
    expect(last?.[0]).toBe("crm");

    handle.destroy();
  });

  it("honors params.server for internal bundles (e.g., home)", async () => {
    const { iframe } = makeFakeIframe();
    const handle = createBridge(iframe, "home");

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: "rr-3",
      method: "resources/read",
      params: { uri: "ui://crm/main", server: "crm" },
    });

    await new Promise((r) => setTimeout(r, 10));

    const calls = readResourceMock.mock.calls;
    const last = calls[calls.length - 1];
    expect(last?.[0]).toBe("crm");

    handle.destroy();
  });

  it("returns a JSON-RPC error response with code -32000 on failure", async () => {
    readResourceMock.mockImplementationOnce(async () => {
      throw new Error("resource_not_found");
    });

    const { iframe, posted } = makeFakeIframe();
    const handle = createBridge(iframe, "crm");

    simulatePostMessage(iframe, {
      jsonrpc: "2.0",
      id: "rr-4",
      method: "resources/read",
      params: { uri: "ui://crm/missing" },
    });

    await new Promise((r) => setTimeout(r, 10));

    const response = posted.find(
      (m: unknown) => (m as Record<string, unknown>).id === "rr-4",
    ) as Record<string, unknown> | undefined;
    expect(response).toBeDefined();
    const error = response!.error as { code: number; message: string };
    expect(error.code).toBe(-32000);
    expect(error.message).toBe("resource_not_found");

    handle.destroy();
  });
});
