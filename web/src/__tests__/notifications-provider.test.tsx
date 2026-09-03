// ---------------------------------------------------------------------------
// NotificationsProvider — the live-then-reconciled contract.
//
// Pins:
//   1. `notification.created` triggers a REFETCH, not a render from the frame.
//      The frame is a summary (no body, no link, no payload), so rendering
//      from it would put a different item on screen than a reload would.
//   2. A burst of frames is ONE read. A poll cycle delivers a batch; forty
//      events must not be forty `notifications__list` calls.
//   3. A reconnect refetches. The workspace stream has no `Last-Event-Id`
//      replay, so everything that arrived during the gap is simply absent —
//      without this an inbox left open through a deploy is silently stale.
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

const WS = "ws_outbound";

let listCalls = 0;
let listed: Array<Record<string, unknown>> = [];
let markReadArgs: unknown[] = [];

mock.module("../api/client", () => ({
  ...realClient,
  callTool: mock(async (_source: string, tool: string, args: Record<string, unknown>) => {
    if (tool === "mark_read") {
      markReadArgs.push(args);
      return { content: [{ type: "text", text: JSON.stringify({ marked: [], skipped: [] }) }] };
    }
    listCalls += 1;
    return {
      content: [{ type: "text", text: JSON.stringify({ notifications: listed }) }],
    };
  }),
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
 * `markAllRead` is handed out through `markAllRef` so the mark-read test can
 * call it without a DOM affordance — this file is about the provider, and the
 * page has its own test.
 */
let markAllRef: (() => Promise<void>) | null = null;

function probeElement(seen: { unread: number }) {
  function Probe() {
    const value = useNotifications();
    seen.unread = value.unread;
    markAllRef = value.markAllRead;
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
      React.createElement(
        NotificationsProvider,
        { token: "t", workspaceId: WS },
        probeElement(seen),
      ),
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

    // The frame says an urgent item arrived. What lands on screen is whatever
    // the refetch returns — here, deliberately, a different level.
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
      });
    });
    await settle();

    expect(listCalls).toBe(2);
    expect(seen.unread).toBe(1);
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
      lastOptions?.onEvent("notification.delivery_failed", { workspaceId: WS });
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

describe("marking read", () => {
  test("paints before the call returns, and sends the ids", async () => {
    listed = [notification()];
    const seen = { unread: 0 };
    await mount(seen);
    expect(seen.unread).toBe(1);

    // The list the server would return has NOT changed — the drop to zero can
    // only come from the optimistic paint.
    await act(async () => {
      await markAll();
    });
    expect(seen.unread).toBe(0);
    expect(markReadArgs).toEqual([{ ids: ["acme:evt_1"] }]);
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
  await markAllRef?.();
}
