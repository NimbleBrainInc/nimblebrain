// ---------------------------------------------------------------------------
// A personal connector's view renders inline, and its bridge stays its own
//
// Pins:
//   1. A done tool call from a personal connector (`my_fixture__ping`) whose
//      result names a `ui://` view mounts it, fetched under the marked name, so
//      the server resolves the caller's own connection and never the
//      workspace's `fixture`.
//   2. The view's `tools/call` goes to `/mcp` under the marked name and names
//      the personal app as its source; a call naming the workspace's
//      `fixture__ping` is refused by the bridge and never sent.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { loadAppFrame } from "../../test/app-frame";
import { realClient, realMcpBridgeClient } from "../../test/setup";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchedApps: string[] = [];
mock.module("../api/client", () => ({
  ...realClient,
  getResources: async (appName: string) => {
    fetchedApps.push(appName);
    return { html: "<html><head></head><body></body></html>" };
  },
}));

const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
mock.module("../mcp-bridge-client", () => ({
  ...realMcpBridgeClient,
  sendMcpRequest: mock(async (method: string, params: Record<string, unknown>) => {
    sent.push({ method, params });
    return { result: { content: [{ type: "text", text: "ok" }] } };
  }),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { NoticeProvider } = await import("../components/notices");
const { ThemeProvider } = await import("../context/ThemeContext");
const { BlockTimeline } = await import("../components/BlockTimeline");
const { setActiveWorkspaceId } = await import("../api/client");
type ContentBlock = import("../hooks/chat-store").ContentBlock;
type Message = { id?: string; error?: { data?: Record<string, unknown> } };

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  fetchedApps.length = 0;
  sent.length = 0;
});

function viewCall(id: string, name: string): ContentBlock {
  return {
    type: "tool",
    toolCalls: [
      {
        id,
        name,
        status: "done",
        input: {},
        resourceUri: "ui://fixture/report",
        appName: name.slice(0, name.indexOf("__")),
        result: { content: [{ type: "text", text: "ok" }], isError: false },
        ms: 5,
      },
    ],
  };
}

async function mountTimeline(blocks: ContentBlock[]): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        NoticeProvider,
        null,
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(BlockTimeline, {
              blocks,
              isCurrentMessage: false,
              streamingState: null,
              preparingTool: null,
              displayDetail: "balanced",
            }),
          ),
        ),
      ),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  teardown = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

describe("a personal connector's view in the chat", () => {
  test("mounts inline, fetched under the marked name", async () => {
    const container = await mountTimeline([viewCall("t1", "my_fixture__ping")]);
    expect(fetchedApps).toEqual(["my_fixture"]);
    expect(container.querySelectorAll("iframe").length).toBe(1);
  });

  test("its bridge calls the personal tool, and refuses the workspace's", async () => {
    setActiveWorkspaceId("ws_0076759dbbe19fcc");
    const container = await mountTimeline([viewCall("t1", "my_fixture__ping")]);
    const iframe = container.querySelector("iframe");
    if (!iframe) throw new Error("no iframe mounted");
    const inbox: Message[] = [];
    const send = loadAppFrame(iframe, {
      postMessage(data: unknown) {
        inbox.push(data as Message);
      },
    } as Window).post;
    send({
      jsonrpc: "2.0",
      id: "init",
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        appInfo: { name: "iframe", version: "1.0.0" },
        appCapabilities: {},
      },
    });
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });

    await act(async () => {
      send({ jsonrpc: "2.0", id: "own", method: "tools/call", params: { name: "ping" } });
      send({
        jsonrpc: "2.0",
        id: "workspace",
        method: "tools/call",
        params: { name: "fixture__ping" },
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    const calls = sent.filter((s) => s.method === "tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.name).toBe("my_fixture__ping");
    expect(calls[0]?.params._meta).toEqual({ "ai.nimblebrain/source": "my_fixture" });
    expect(inbox.find((m) => m.id === "workspace")?.error).toBeDefined();
  });
});
