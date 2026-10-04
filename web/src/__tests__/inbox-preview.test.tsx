// ---------------------------------------------------------------------------
// InboxToggle's preview — the bell's look at what is unread.
//
// Pins:
//   1. Opening reads the unread items and shows the newest five, each linking
//      to its row in the inbox (`?item=`). Opening marks nothing read.
//   2. With more unread than shown, the footer says how many and links to the
//      inbox.
//   3. Nothing unread says so.
//   4. "Mark all read" marks every unread item the read returned.
//   5. Urgency first, then newest, as the inbox orders them, so an urgent item
//      is never cut from the five.
//   6. `formatAgo` reads minutes, hours, then days.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type { NotificationView } from "../api/notifications";
import type { NotificationsValue } from "../context/NotificationsContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

let listed: NotificationView[] = [];
let listArgs: Array<Record<string, unknown>> = [];

mock.module("../api/client", () => ({
  ...realClient,
  callTool: mock(async (_source: string, tool: string, args: Record<string, unknown>) => {
    if (tool === "list") listArgs.push(args);
    // Newest first, capped at `limit`, honouring `unreadOnly` and `level`.
    const rank = { info: 0, attention: 1, urgent: 2 } as const;
    const matching = [...listed]
      .sort((a, b) => b.seq - a.seq)
      .filter((n) => !args?.unreadOnly || !n.readAt)
      .filter((n) => !args?.level || rank[n.level] >= rank[args.level as keyof typeof rank]);
    const limit = (args?.limit as number | undefined) ?? 20;
    const out = {
      notifications: matching.slice(0, limit),
      unread: 0,
      hasMore: matching.length > limit,
    };
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }),
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { NotificationsContext } = await import("../context/NotificationsContext");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { InboxToggle, formatAgo } = await import("../components/shell/InboxToggle");

function item(n: number, over: Partial<NotificationView> = {}): NotificationView {
  return {
    id: `acme:evt_${n}`,
    seq: n,
    source: "acme",
    name: "domain.active",
    level: "info",
    title: `item ${n}`,
    timestamp: "2026-09-01T18:42:10.000Z",
    receivedAt: "2026-09-01T18:43:00.000Z",
    data: {},
    ...over,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

async function openPreview(
  items: NotificationView[],
  markRead: NotificationsValue["markRead"] = async () => {},
): Promise<void> {
  listed = items;
  listArgs = [];
  const value: NotificationsValue = {
    unread: items.filter((n) => !n.readAt).length,
    revision: 0,
    refresh: () => {},
    markRead,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/w/000f7ed6658f9d30/"]}>
        <WorkspaceProvider
          initialWorkspaces={[
            { id: "ws_000f7ed6658f9d30", name: "Acme", connectorCount: 0, memberCount: 1 },
          ]}
          initialActiveId="ws_000f7ed6658f9d30"
        >
          <NotificationsContext.Provider value={value}>
            <InboxToggle />
          </NotificationsContext.Provider>
        </WorkspaceProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    byTestId("top-bar-inbox")?.click();
  });
}

// The popup portals to the body, so look there rather than in the container.
const allByTestId = (id: string) =>
  Array.from(document.body.getElementsByTagName("*")).filter(
    (el) => el.getAttribute("data-testid") === id,
  ) as HTMLElement[];
const byTestId = (id: string) => allByTestId(id)[0];

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the bell's preview", () => {
  test("shows the newest five unread, each linking to its row, and marks nothing", async () => {
    const markRead = mock<NotificationsValue["markRead"]>(async () => {});
    await openPreview(
      [1, 2, 3, 4, 5, 6, 7].map((n) => item(n)),
      markRead,
    );
    expect(listArgs.at(-1)?.unreadOnly).toBe(true);
    const rows = allByTestId("inbox-preview-item");
    expect(rows).toHaveLength(5);
    expect(rows[0]?.getAttribute("href")).toBe(
      "/w/000f7ed6658f9d30/notifications?item=acme%3Aevt_7",
    );
    expect(markRead).not.toHaveBeenCalled();
  });

  test("with more unread than shown, the footer says how many", async () => {
    await openPreview([1, 2, 3, 4, 5, 6, 7].map((n) => item(n)));
    const footer = byTestId("inbox-preview-view-all");
    expect(footer?.textContent).toBe("View all 7 unread in the inbox");
    expect(footer?.getAttribute("href")).toBe("/w/000f7ed6658f9d30/notifications");
  });

  test("nothing unread says so", async () => {
    await openPreview([item(1, { readAt: "2026-09-01T19:00:00.000Z" })]);
    expect(byTestId("inbox-preview-empty")).toBeDefined();
    expect(byTestId("inbox-preview-mark-all")).toBeUndefined();
    expect(byTestId("inbox-preview-view-all")?.textContent).toBe("Open the inbox");
  });

  test("Mark all read marks every unread item the read returned", async () => {
    const markRead = mock<NotificationsValue["markRead"]>(async () => {});
    await openPreview(
      [1, 2, 3, 4, 5, 6].map((n) => item(n)),
      markRead,
    );
    await act(async () => {
      byTestId("inbox-preview-mark-all")?.click();
    });
    expect([...(markRead.mock.calls[0]?.[0] ?? [])].sort()).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => `acme:evt_${n}`),
    );
  });
});

describe("order", () => {
  test("an urgent item older than one read of the unread still leads", async () => {
    await openPreview([
      item(1, { level: "urgent", title: "on fire" }),
      ...Array.from({ length: 120 }, (_, i) => item(i + 2)),
    ]);
    expect(allByTestId("inbox-preview-item")[0]?.textContent).toContain("on fire");
  });

  test("an urgent item is shown ahead of newer routine ones", async () => {
    await openPreview([
      item(1, { level: "urgent", title: "on fire" }),
      ...[2, 3, 4, 5, 6, 7].map((n) => item(n)),
    ]);
    expect(allByTestId("inbox-preview-item")[0]?.textContent).toContain("on fire");
  });
});

describe("formatAgo", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  test("minutes, then hours, then days", () => {
    expect(formatAgo("2026-10-03T11:59:40.000Z", now)).toBe("just now");
    expect(formatAgo("2026-10-03T11:55:00.000Z", now)).toBe("5 min ago");
    expect(formatAgo("2026-10-03T09:00:00.000Z", now)).toBe("3 h ago");
    expect(formatAgo("2026-10-01T12:00:00.000Z", now)).toBe("2 d ago");
  });
});
