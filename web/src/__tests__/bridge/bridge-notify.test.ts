// ---------------------------------------------------------------------------
// ai.nimblebrain/notify — an app asks the host to show a notice.
//
//   - a valid request reaches `onNotify` and is answered `{}`
//   - the app cannot choose its own label; the host labels it
//   - a bad level, an empty or long title, or a long description is answered
//     -32602 with the reason, not dropped and left waiting
//   - a burst past the limit is refused, so one app cannot fill the screen,
//     and the budget comes back once the window has passed
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient, realMcpBridgeClient } from "../../../test/setup";
import { NOTIFY_METHOD } from "../../bridge/extensions";
import type { AppNotice, BridgeCallbacks } from "../../bridge/types";

mock.module("../../api/client", () => ({
  ...realClient,
  getActiveWorkspaceId: () => "ws_0076759dbbe19fcc",
}));

mock.module("../../mcp-bridge-client", () => ({
  ...realMcpBridgeClient,
  sendMcpRequest: mock(async () => ({ result: { content: [] } })),
}));

const { createBridge, createNoticeLimiter } = await import("../../bridge/bridge");

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
    const WindowMessageEvent = (window as unknown as { MessageEvent: typeof MessageEvent })
      .MessageEvent;
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
  const notify = (id: string | number, params: Record<string, unknown>) =>
    send({ jsonrpc: "2.0", id, method: NOTIFY_METHOD, params });
  return { notify, reply };
}

describe("ai.nimblebrain/notify", () => {
  test("a valid notice reaches the host and is answered {}", async () => {
    const seen: AppNotice[] = [];
    const app = mount({ onNotify: (n) => seen.push(n) });
    app.notify(1, {
      level: "success",
      title: "  Report exported  ",
      description: "Saved to Files.",
    });
    expect((await app.reply(1)).result).toEqual({});
    expect(seen).toEqual([
      { level: "success", title: "Report exported", description: "Saved to Files." },
    ]);
  });

  test("the app cannot choose its own label", async () => {
    const seen: AppNotice[] = [];
    const app = mount({ onNotify: (n) => seen.push(n) });
    app.notify(1, { level: "info", title: "Hello", source: "NimbleBrain" });
    await app.reply(1);
    expect(seen[0]).not.toHaveProperty("source");
  });

  test("a bad level, title or description is answered -32602, never shown", async () => {
    const seen: AppNotice[] = [];
    const app = mount({ onNotify: (n) => seen.push(n) });
    app.notify(1, { level: "critical", title: "x" });
    app.notify(2, { level: "info", title: "   " });
    app.notify(3, { level: "info", title: "x".repeat(121) });
    app.notify(4, { level: "info", title: "x", description: "y".repeat(501) });
    for (const id of [1, 2, 3, 4]) {
      expect((await app.reply(id)).error?.code).toBe(-32602);
    }
    expect((await app.reply(1)).error?.message).toContain("level must be one of");
    expect(seen).toEqual([]);
  });

  test("a burst past the limit is refused", async () => {
    const seen: AppNotice[] = [];
    const app = mount({ onNotify: (n) => seen.push(n) });
    for (let i = 1; i <= 6; i++) app.notify(i, { level: "info", title: `n${i}` });
    for (let i = 1; i <= 5; i++) expect((await app.reply(i)).result).toEqual({});
    const sixth = await app.reply(6);
    expect(sixth.error?.code).toBe(-32000);
    expect(sixth.error?.message).toContain("Too many notices");
    expect(seen).toHaveLength(5);
  });

  test("the budget comes back once the window has passed", () => {
    let t = 0;
    const withinLimit = createNoticeLimiter(() => t);
    for (let i = 0; i < 5; i++) expect(withinLimit()).toBe(true);
    t = 9_999;
    expect(withinLimit()).toBe(false);
    t = 10_000;
    expect(withinLimit()).toBe(true);
  });

  test("a host that shows no notices answers -32601", async () => {
    const app = mount({});
    app.notify(1, { level: "info", title: "x" });
    expect((await app.reply(1)).error?.code).toBe(-32601);
  });
});
