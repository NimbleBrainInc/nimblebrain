// ---------------------------------------------------------------------------
// Bridge `resources/list` / `resources/templates/list`
//
// `ui/initialize` advertises `serverResources`, which promises the app its own
// server's resource listings as well as reads. Every iframe shares one `/mcp`
// session, so the bridge alone knows which app asked: it names that app's
// server in the request's `_meta`, forwards only the iframe's `cursor`, and
// hands the server's answer back — `nextCursor` included — untouched.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const listResources = mock(async (_params: unknown) => ({
  resources: [{ uri: "notes://0", name: "note 0" }],
  nextCursor: "1",
}));
const listResourceTemplates = mock(async (_params: unknown) => ({
  resourceTemplates: [{ uriTemplate: "notes://{index}", name: "note" }],
}));

mock.module("../../mcp-bridge-client", () => ({
  getMcpBridgeClient: async () => ({
    callTool: async () => ({ content: [], structuredContent: {} }),
    readResource: async () => ({ contents: [] }),
    listResources,
    listResourceTemplates,
    request: async () => ({}),
    setNotificationHandler: () => {},
    removeNotificationHandler: () => {},
  }),
  resetMcpBridgeClient: () => {},
  withSessionRetry: async <T>(op: () => Promise<T>): Promise<T> => op(),
}));

const { createBridge, RESOURCE_SOURCE_META_KEY } = await import("../../bridge/bridge");

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

  return { iframe, inbox, send, waitFor, cleanup: () => document.body.removeChild(iframe) };
}

let activeBridge: { destroy(): void } | null = null;
let activeFrame: TestIframe | null = null;

beforeEach(() => {
  listResources.mockClear();
  listResourceTemplates.mockClear();
});

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

const byId = (id: string) => (m: unknown) => (m as { id?: string })?.id === id;

describe("resources/list", () => {
  test("lists the app's own server, with its cursor, and returns the answer untouched", async () => {
    const frame = mount("notes");
    frame.send({
      jsonrpc: "2.0",
      id: "l-1",
      method: "resources/list",
      params: { cursor: "0" },
    });

    const reply = await frame.waitFor(byId("l-1"));
    expect(listResources).toHaveBeenCalledWith({
      cursor: "0",
      _meta: { [RESOURCE_SOURCE_META_KEY]: "notes" },
    });
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: "l-1",
      result: { resources: [{ uri: "notes://0", name: "note 0" }], nextCursor: "1" },
    });
  });

  test("an external app cannot list another server by naming it", async () => {
    const frame = mount("notes");
    frame.send({
      jsonrpc: "2.0",
      id: "l-2",
      method: "resources/list",
      params: { server: "files" },
    });

    await frame.waitFor(byId("l-2"));
    expect(listResources).toHaveBeenCalledWith({ _meta: { [RESOURCE_SOURCE_META_KEY]: "notes" } });
  });

  test("with no params, only the app's own server is named", async () => {
    const frame = mount("notes");
    frame.send({ jsonrpc: "2.0", id: "l-3", method: "resources/list" });

    await frame.waitFor(byId("l-3"));
    expect(listResources).toHaveBeenCalledWith({ _meta: { [RESOURCE_SOURCE_META_KEY]: "notes" } });
  });

  test("a failed listing is a JSON-RPC error, not a hang", async () => {
    listResources.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const frame = mount("notes");
    frame.send({ jsonrpc: "2.0", id: "l-4", method: "resources/list" });

    expect(await frame.waitFor(byId("l-4"))).toEqual({
      jsonrpc: "2.0",
      id: "l-4",
      error: { code: -32000, message: "boom" },
    });
  });
});

describe("resources/templates/list", () => {
  test("lists the app's own server's templates", async () => {
    const frame = mount("notes");
    frame.send({ jsonrpc: "2.0", id: "t-1", method: "resources/templates/list" });

    const reply = await frame.waitFor(byId("t-1"));
    expect(listResourceTemplates).toHaveBeenCalledWith({
      _meta: { [RESOURCE_SOURCE_META_KEY]: "notes" },
    });
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: "t-1",
      result: { resourceTemplates: [{ uriTemplate: "notes://{index}", name: "note" }] },
    });
  });
});
