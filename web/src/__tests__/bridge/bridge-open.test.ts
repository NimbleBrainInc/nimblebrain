// ---------------------------------------------------------------------------
// ai.nimblebrain/open and ai.nimblebrain/open-connector-settings (ADR-0052).
//
//   - `open` hands the shell the URI and is answered `{}` once it has acted
//   - a refusal reaches the app as an error carrying the shell's reason
//   - settings are the sender's own: the bridge names the connector, and a
//     param of the same name from the app changes nothing
//   - a bridge with no shell behind it refuses at once, never leaving the app
//     waiting
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient, realMcpBridgeClient } from "../../../test/setup";
import { OPEN_CONNECTOR_SETTINGS_METHOD, OPEN_METHOD } from "../../bridge/extensions";
import type { BridgeCallbacks } from "../../bridge/types";

mock.module("../../api/client", () => ({
  ...realClient,
  getActiveWorkspaceId: () => "ws_0076759dbbe19fcc",
}));

mock.module("../../mcp-bridge-client", () => ({
  ...realMcpBridgeClient,
  sendMcpRequest: mock(async () => ({ result: { content: [] } })),
}));

const { createBridge } = await import("../../bridge/bridge");

interface Reply {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/** Mount a bridge on a stub iframe, and send it messages as the app. */
function mount(callbacks: BridgeCallbacks) {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const inbox: unknown[] = [];
  const stubWindow = {
    postMessage(data: unknown) {
      inbox.push(data);
    },
  } as Window;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => stubWindow });
  const bridge = createBridge(iframe, "crm", callbacks);
  cleanup = () => {
    bridge.destroy();
    iframe.remove();
  };
  const send = (data: unknown) => {
    const WindowMessageEvent = window.MessageEvent;
    const event = new WindowMessageEvent("message", { data });
    Object.defineProperty(event, "source", { configurable: true, get: () => stubWindow });
    window.dispatchEvent(event);
  };
  const reply = async (id: string | number): Promise<Reply> => {
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const hit = inbox.find((m) => (m as Reply).id === id);
      if (hit) return hit as Reply;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no reply to ${id}; inbox: ${JSON.stringify(inbox)}`);
  };
  const open = (id: string | number, uri: string) =>
    send({ jsonrpc: "2.0", id, method: OPEN_METHOD, params: { uri } });
  const openSettings = (id: string | number, params: Record<string, unknown> = {}) =>
    send({ jsonrpc: "2.0", id, method: OPEN_CONNECTOR_SETTINGS_METHOD, params });
  return { open, openSettings, reply };
}

describe("ai.nimblebrain/open", () => {
  test("hands the shell the URI and answers {} once it has acted", async () => {
    const opened: string[] = [];
    const app = mount({ onOpen: async (uri) => void opened.push(uri) });
    app.open(1, "files://fl_1");
    expect((await app.reply(1)).result).toEqual({});
    expect(opened).toEqual(["files://fl_1"]);
  });

  test("a refusal reaches the app with the shell's reason", async () => {
    const app = mount({
      onOpen: async (uri) => {
        throw new Error(`Nothing in this workspace opens ${uri}.`);
      },
    });
    app.open(1, "nope://1");
    const { error } = await app.reply(1);
    expect(error?.code).toBe(-32602);
    expect(error?.message).toBe("Nothing in this workspace opens nope://1.");
  });

  test("with no shell behind the bridge, it refuses at once", async () => {
    const app = mount({});
    app.open(1, "files://fl_1");
    app.openSettings(2);
    expect((await app.reply(1)).error?.code).toBe(-32601);
    expect((await app.reply(2)).error?.code).toBe(-32601);
  });
});

describe("ai.nimblebrain/open-connector-settings", () => {
  test("opens the sender's own settings, whatever the app names", async () => {
    const opened: string[] = [];
    const app = mount({ onOpenConnectorSettings: async (s) => void opened.push(s) });
    app.openSettings(1, { serverName: "someone-else" });
    expect((await app.reply(1)).result).toEqual({});
    expect(opened).toEqual(["crm"]);
  });
});
