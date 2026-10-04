// ---------------------------------------------------------------------------
// NotificationsProvider — the live-then-reconciled contract.
//
// Pins:
//   1. `notification.created` triggers a REFETCH, not a count from the frame.
//      The count is the server's `unread`, over the whole inbox, not a tally
//      of whatever page came back.
//   2. A burst of frames is ONE read. A poll cycle delivers a batch; forty
//      events must not be forty `notifications__list` calls.
//   3. A `notification.read` frame refetches. Read state is shared across the
//      workspace, so a teammate's mark must clear this bell.
//   4. A reconnect refetches. The workspace stream has no `Last-Event-Id`
//      replay, so everything that arrived during the gap is simply absent —
//      without this an inbox left open through a deploy is silently stale.
//   5. Every read and mark names the provider's workspace. The active
//      workspace is a module variable other writers move, so a call addressed
//      through it can answer for a workspace the provider never asked about.
//
// Drives the REAL events-client singleton through `setConnectorForTest`
// rather than mocking `../hooks/useEvents`: a module mock is process-global
// and would leave `subscribe` stubbed for every file loaded after this one.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import { __internal__ } from "../api/events-client";
import type { ConnectEventsOptions, EventConnection } from "../api/sse";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "ws_005b519ef7efc353";

let listCalls = 0;
let listed: Array<Record<string, unknown>> = [];
let markReadArgs: unknown[] = [];
let addressed: Array<string | undefined> = [];
let listArgs: unknown[] = [];
/** The server's total, when a test needs it to differ from the page. */
let serverUnread: number | null = null;

mock.module("../api/client", () => ({
  ...realClient,
  callTool: mock(
    async (
      _source: string,
      tool: string,
      args: Record<string, unknown>,
      opts?: { workspaceId?: string },
    ) => {
      addressed.push(opts?.workspaceId);
      if (tool === "mark_read") {
        markReadArgs.push(args);
        const ids = (args as { ids: string[] }).ids;
        const readAt = "2026-09-01T19:00:00.000Z";
        listed = listed.map((n) => (ids.includes(n.id as string) ? { ...n, readAt } : n));
        return { content: [{ type: "text", text: JSON.stringify({ marked: ids, skipped: [] }) }] };
      }
      listCalls += 1;
      listArgs.push(args);
      const unread = serverUnread ?? listed.filter((n) => !n.readAt).length;
      return {
        content: [{ type: "text", text: JSON.stringify({ notifications: listed, unread }) }],
      };
    },
  ),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { NotificationsProvider } = await import("../context/NotificationsProvider");
const { useNotifications } = await import("../context/NotificationsContext");

let lastOptions: ConnectEventsOptions | null = null;

class FakeConnection implements EventConnection {
  close(): void {}
}

/**
 * Renders nothing and reports what the context holds.
 *
 * `markRead` is handed out through `markReadRef` so the mark-read test can
 * call it without a DOM affordance — this file is about the provider, and the
 * page has its own test.
 */
let markReadRef: ((ids: string[]) => Promise<void>) | null = null;

function probeElement(seen: { unread: number }) {
  function Probe() {
    const value = useNotifications();
    seen.unread = value.unread;
    markReadRef = value.markRead;
    return null;
  }
  return React.createElement(Probe);
}

let unmount: (() => void) | null = null;

async function mount(seen: { unread: number }): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(NotificationsProvider, {
        workspaceId: WS,
        children: probeElement(seen),
      }),
    );
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
}

/** Let the provider's coalescing window close and the read settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

beforeEach(() => {
  listCalls = 0;
  listed = [];
  markReadArgs = [];
  addressed = [];
  listArgs = [];
  serverUnread = null;
  lastOptions = null;
  __internal__.resetForTest();
  __internal__.setConnectorForTest((options: ConnectEventsOptions) => {
    lastOptions = options;
    return new FakeConnection();
  });
});

afterEach(() => {
  unmount?.();
  unmount = null;
  __internal__.resetForTest();
  __internal__.setConnectorForTest(null);
});

describe("the first read", () => {
  test("happens on mount, without waiting out the coalescing window", async () => {
    listed = [notification()];
    const seen = { unread: 0 };
    await mount(seen);
    expect(listCalls).toBe(1);
    expect(seen.unread).toBe(1);
  });
});

describe("a live frame", () => {
  test("triggers a refetch rather than being rendered", async () => {
    const seen = { unread: 0 };
    await mount(seen);
    expect(listCalls).toBe(1);

    // The frame says an item arrived. The count on the bell is whatever the
    // refetch returns, not one added for the frame.
    listed = [notification({ level: "info" })];
    await act(async () => {
      lastOptions?.onEvent("notification.created", {
        workspaceId: WS,
        id: "acme:evt_1",
        seq: 1,
        source: "acme",
        name: "domain.active",
        level: "urgent",
        title: "from the frame",
        receivedAt: "2026-09-01T18:43:00.000Z",
        unread: 1,
      });
    });
    await settle();

    expect(listCalls).toBe(2);
    expect(seen.unread).toBe(1);
  });

  test("a read frame refetches, so a teammate's mark clears the bell", async () => {
    listed = [notification()];
    const seen = { unread: 0 };
    await mount(seen);
    expect(seen.unread).toBe(1);

    // Read state is shared across the workspace: someone else marked it.
    listed = [notification({ readAt: "2026-09-01T19:00:00.000Z" })];
    await act(async () => {
      lastOptions?.onEvent("notification.read", {
        workspaceId: WS,
        ids: ["acme:evt_1"],
        unread: 0,
      });
    });
    await settle();

    expect(listCalls).toBe(2);
    expect(seen.unread).toBe(0);
  });

  test("a burst of frames is one read", async () => {
    const seen = { unread: 0 };
    await mount(seen);
    listCalls = 0;

    await act(async () => {
      for (let i = 0; i < 40; i++) {
        lastOptions?.onEvent("notification.created", {
          workspaceId: WS,
          id: `acme:evt_${i}`,
          seq: i,
          source: "acme",
          name: "domain.active",
          level: "info",
          title: `t${i}`,
          receivedAt: "2026-09-01T18:43:00.000Z",
          unread: 1,
        });
      }
    });
    await settle();

    expect(listCalls).toBe(1);
  });

  test("a delivery failure refetches too — the ledger lives on the item", async () => {
    const seen = { unread: 0 };
    await mount(seen);
    listCalls = 0;

    await act(async () => {
      lastOptions?.onEvent("notification.delivery_failed", {
        workspaceId: WS,
        id: "n1",
        seq: 1,
        routeId: "rt_1",
        target: "slack",
        attempts: 3,
        outcome: "failed",
      });
    });
    await settle();

    expect(listCalls).toBe(1);
  });
});

describe("a reconnect", () => {
  test("refetches, because the stream has no replay", async () => {
    const seen = { unread: 0 };
    await mount(seen);
    listCalls = 0;

    await act(async () => {
      lastOptions?.onReconnect?.();
    });
    await settle();

    expect(listCalls).toBe(1);
  });
});

describe("the count", () => {
  test("is the server's total, not a tally of the page", async () => {
    listed = [notification()];
    serverUnread = 140;
    const seen = { unread: 0 };
    await mount(seen);
    expect(seen.unread).toBe(140);
    // One item is enough to carry the count; the list is the page's to read.
    expect(listArgs).toEqual([{ limit: 1 }]);
  });
});

describe("marking read", () => {
  test("drops the count, sends the ids, and re-reads the store's count", async () => {
    listed = [notification()];
    const seen = { unread: 0 };
    await mount(seen);
    expect(seen.unread).toBe(1);
    listCalls = 0;

    await act(async () => {
      await markAll();
    });
    expect(seen.unread).toBe(0);
    expect(markReadArgs).toEqual([{ ids: ["acme:evt_1"] }]);
    expect(listCalls).toBe(1);
  });
});

describe("addressing", () => {
  test("every read and mark names the provider's workspace", async () => {
    listed = [notification()];
    const seen = { unread: 0 };
    await mount(seen);
    await act(async () => {
      lastOptions?.onReconnect?.();
    });
    await settle();
    await act(async () => {
      await markAll();
    });

    // Mount, reconnect, the mark, and the re-read after it.
    expect(addressed.length).toBe(4);
    expect(addressed.every((wsId) => wsId === WS)).toBe(true);
  });
});

// -- helpers --------------------------------------------------------------

function notification(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme:evt_1",
    seq: 1,
    source: "acme",
    name: "domain.active",
    level: "info",
    title: "acme-outreach.com is active",
    timestamp: "2026-09-01T18:42:10.000Z",
    receivedAt: "2026-09-01T18:43:00.000Z",
    data: {},
    ...over,
  };
}

async function markAll(): Promise<void> {
  await markReadRef?.(["acme:evt_1"]);
}
