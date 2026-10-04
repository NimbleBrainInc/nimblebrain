// ---------------------------------------------------------------------------
// The inbox panel — the five things it must never get wrong.
//
// Pins:
//   1. A connector's `body` is TEXT. Markdown and HTML in it reach the screen
//      as the characters the connector wrote. An inbox that rendered them
//      would be a third-party server drawing in the operator's own chrome.
//   2. A `link.resource` the shell cannot open is not a link. A URI in the
//      server's own scheme has nowhere to go, and an affordance that does
//      nothing is worse than one that never claimed to exist.
//   3. Opening an item marks it read — once, and not again on close.
//   4. The delivery ledger renders only when there is one.
//   5. `?item=` opens the row it names. That query parameter is the tail of the
//      `{{inbox.url}}` a route rendered into Slack or mail, so a reader who
//      followed it must land on the item, not on a list to search.
//   6. Unread is visible on the row, and the header counts the shell's total.
//   7. Each filter reaches the server as the list argument it stands for, from
//      the URL, and a filtered view with nothing in it says so.
//   8. The list is newest first in pages: "Load older" continues below the
//      oldest row, a link to an older item pages down to it, and the count of
//      unread items needing attention covers the whole inbox.
//   9. A level is urgency, not tone: only an urgent row is marked on screen,
//      and a screen reader is told the level of every other row.
//
// The page reads its own list through `notifications__list` (the client's
// `callTool`, stubbed here) and takes the unread total and `markRead` from the
// shell's context, supplied as a value: the provider's own fetching is a
// separate contract (see notifications-provider.test.tsx).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type { InstalledConnector } from "../api/client";
import type { NotificationView } from "../api/notifications";
import type { NotificationsValue } from "../context/NotificationsContext";
import type { PlacementEntry } from "../types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom doesn't expose SyntaxError/TypeError on its Window stub; any
// querySelectorAll trips it. Same patch the other component tests carry.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

let listed: NotificationView[] = [];
let listArgs: Array<Record<string, unknown>> = [];
/** The page's own list reads — one page each — apart from the needs-attention count's. */
const pageReads = () => listArgs.filter((a) => a.limit === 25);

mock.module("../api/client", () => ({
  ...realClient,
  callTool: mock(async (_source: string, tool: string, args: Record<string, unknown>) => {
    if (tool === "list") listArgs.push(args);
    // Pages the way the store does — newest first, `before`, `limit`,
    // `hasMore` — and honours the filters whose answer a test depends on:
    // `unreadOnly` (the held-rows test), `level`, and `ids`.
    const rank = { info: 0, attention: 1, urgent: 2 } as const;
    const matching = [...listed]
      .sort((a, b) => b.seq - a.seq)
      .filter((n) => !args?.unreadOnly || !n.readAt)
      .filter((n) => !args?.level || rank[n.level] >= rank[args.level as keyof typeof rank])
      .filter((n) => args?.before === undefined || n.seq < (args.before as number))
      .filter((n) => !args?.ids || (args.ids as string[]).includes(n.id));
    const limit = (args?.limit as number | undefined) ?? 20;
    const out = {
      notifications: matching.slice(0, limit),
      unread: 0,
      hasMore: matching.length > limit,
    };
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }),
}));

const React = await import("react");
const { NoticeProvider } = await import("../components/notices");
const withNotices = (el: React.ReactNode) => React.createElement(NoticeProvider, null, el);
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useNavigate } = await import("react-router-dom");
const { NotificationsContext } = await import("../context/NotificationsContext");
const { ShellProvider } = await import("../context/ShellContext");
const { WorkspaceAppIconsContext } = await import("../context/WorkspaceAppIconsContext");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { NotificationsPage } = await import("../pages/NotificationsPage");

/** A placement the focused workspace mounts, as the shell reports one. */
const CAMPAIGNS_PLACEMENT = {
  serverName: "acme",
  slot: "sidebar",
  resourceUri: "ui://acme/campaigns",
  priority: 10,
  route: "campaigns",
};

function item(over: Partial<NotificationView> = {}): NotificationView {
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

let unmount: (() => void) | null = null;

/** The router's navigate, so a test can move `?item=` under a mounted page. */
let navigate: ReturnType<typeof useNavigate>;
function NavigateProbe() {
  navigate = useNavigate();
  return null;
}

const WS = {
  id: "ws_005b519ef7efc353",
  name: "Outbound",
  memberCount: 1,
  connectorCount: 0,
  userRole: "admin" as const,
};

/**
 * The shell's context as the provider behaves: `markRead` marks the stub
 * server's rows and moves `revision`, so the page re-reads as it does live.
 */
function LiveNotifications({ children }: { children: React.ReactNode }) {
  const [revision, setRevision] = React.useState(0);
  const value: NotificationsValue = {
    unread: listed.filter((n) => !n.readAt).length,
    revision,
    refresh: () => {},
    markRead: async (ids) => {
      listed = listed.map((n) =>
        ids.includes(n.id) ? { ...n, readAt: "2026-09-01T19:00:00.000Z" } : n,
      );
      setRevision((r) => r + 1);
    },
  };
  return React.createElement(NotificationsContext.Provider, { value }, children);
}

/** An installed connector as the app-icons context lists it. Only the name fields matter here. */
function installedApp(serverName: string, displayName: string): InstalledConnector {
  return {
    serverName,
    connectorName: serverName,
    displayName,
    disconnectable: false,
    version: "1.0.0",
    state: "running",
    scope: "workspace",
    interactive: false,
    toolCount: 0,
  } as InstalledConnector;
}

async function mount(
  { items = [], ...over }: Partial<NotificationsValue> & { items?: NotificationView[] } = {},
  placements: PlacementEntry[] = [],
  entry = "/w/ws-outbound/notifications",
  { live = false, installed = [] }: { live?: boolean; installed?: InstalledConnector[] } = {},
): Promise<{
  container: HTMLDivElement;
  markRead: ReturnType<typeof mock>;
}> {
  listed = items;
  const markRead = mock(async () => {});
  const value: NotificationsValue = {
    unread: 0,
    revision: 0,
    refresh: () => {},
    markRead,
    ...over,
  };
  const routes = React.createElement(
    React.Fragment,
    null,
    React.createElement(NavigateProbe),
    React.createElement(
      Routes,
      null,
      React.createElement(Route, {
        path: "/w/:slug/notifications",
        element: React.createElement(NotificationsPage),
      }),
    ),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      withNotices(
        React.createElement(
          MemoryRouter,
          { initialEntries: [entry] },
          React.createElement(WorkspaceProvider, {
            initialWorkspaces: [WS],
            initialActiveId: WS.id,
            children: React.createElement(
              ShellProvider,
              {
                value: {
                  forSlot: (slot: string) => (slot === "sidebar" ? placements : []),
                  mainRoutes: () => [],
                  shellWorkspaceId: "ws_005b519ef7efc353",
                },
              },
              React.createElement(
                WorkspaceAppIconsContext.Provider,
                {
                  value: {
                    iconFor: () => undefined,
                    connectors: { workspaceId: WS.id, installed },
                  },
                },
                live
                  ? React.createElement(LiveNotifications, { children: routes })
                  : React.createElement(NotificationsContext.Provider, { value }, routes),
              ),
            ),
          }),
        ),
      ),
    );
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  return { container, markRead };
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="notification-row"]'));
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

beforeEach(() => {
  listed = [];
  listArgs = [];
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("a connector's prose is text", () => {
  test("markdown and HTML in the body reach the screen as characters", async () => {
    const body = "**bold** <script>alert(1)</script> [link](https://example.invalid)";
    const { container } = await mount({ items: [item({ body })] });
    await click(rows(container)[0]!);

    expect(container.textContent).toContain(body);
    // Nothing the connector wrote became markup.
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector('a[href^="https://example.invalid"]')).toBeNull();
  });
});

describe("a link is a link only where the shell can open it", () => {
  test("a URI in the connector's own scheme renders as text", async () => {
    const { container } = await mount({
      items: [item({ link: { resource: "acme://campaigns/cmp_1" } })],
    });
    await click(rows(container)[0]!);

    expect(container.textContent).toContain("acme://campaigns/cmp_1");
    const anchors = Array.from(container.querySelectorAll("a"));
    expect(anchors.some((a) => (a.textContent ?? "").includes("Open"))).toBe(false);
  });

  test("a ui:// URI the workspace mounts becomes a link into that app", async () => {
    const { container } = await mount(
      { items: [item({ link: { resource: "ui://acme/campaigns" } })] },
      [CAMPAIGNS_PLACEMENT],
    );
    await click(rows(container)[0]!);

    const open = Array.from(container.querySelectorAll("a")).find((a) =>
      (a.textContent ?? "").includes("Open"),
    );
    expect(open?.getAttribute("href")).toBe("/w/ws-outbound/app/campaigns");
    // The raw URI is not also printed — the affordance replaces it.
    expect(container.textContent).not.toContain("ui://acme/campaigns");
  });

  test("the same URI is text when this workspace mounts no such placement", async () => {
    const { container } = await mount({
      items: [item({ link: { resource: "ui://acme/campaigns" } })],
    });
    await click(rows(container)[0]!);

    expect(container.textContent).toContain("ui://acme/campaigns");
    expect(
      Array.from(container.querySelectorAll("a")).some((a) =>
        (a.textContent ?? "").includes("Open"),
      ),
    ).toBe(false);
  });

  test("an https URL is text too — the inbox is not a delivery vehicle for one", async () => {
    const { container } = await mount({
      items: [item({ link: { resource: "https://phish.invalid/pay" } })],
    });
    await click(rows(container)[0]!);

    const anchors = Array.from(container.querySelectorAll("a"));
    expect(anchors.some((a) => a.getAttribute("href")?.includes("phish.invalid"))).toBe(false);
  });
});

describe("reading", () => {
  test("opening an item marks it read, once", async () => {
    const { container, markRead } = await mount({ items: [item()], unread: 1 });
    const row = rows(container)[0]!;

    await click(row);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0]?.[0]).toEqual(["acme:evt_1"]);

    // Closing is not un-reading: it fires nothing. (Re-opening does not
    // re-mark either, but that is the provider's optimistic `readAt` doing the
    // work, so it belongs to the provider's own test, not to a static value.)
    await click(row);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  test("an already-read item is not re-marked on open", async () => {
    const { container, markRead } = await mount({
      items: [item({ readAt: "2026-09-01T19:00:00.000Z" })],
    });
    await click(rows(container)[0]!);
    expect(markRead).not.toHaveBeenCalled();
  });
});

describe("the delivery ledger", () => {
  test("renders nothing when nothing has been tried", async () => {
    const { container } = await mount({ items: [item()] });
    await click(rows(container)[0]!);
    expect(container.querySelector('[data-testid="delivery-ledger"]')).toBeNull();
  });

  test("shows target, outcome and the last error when there is one", async () => {
    const { container } = await mount({
      items: [
        item({
          deliveries: [
            {
              routeId: "rt_1",
              target: "slack__send_message",
              index: 0,
              kind: "tool",
              attempts: 3,
              outcome: "failed",
              updatedAt: "2026-09-01T19:00:00.000Z",
              lastError: "channel_not_found",
            },
          ],
        }),
      ],
    });
    await click(rows(container)[0]!);

    const ledger = container.querySelector('[data-testid="delivery-ledger"]');
    expect(ledger).not.toBeNull();
    expect(ledger?.textContent).toContain("slack__send_message");
    expect(ledger?.textContent).toContain("failed");
    expect(ledger?.textContent).toContain("channel_not_found");
  });

  test("an agent target inside its window reads as waiting, not as a failure", async () => {
    // A batch that has not closed yet is mid-flight, not broken. An operator
    // scanning for red must not find one here.
    const { container } = await mount({
      items: [
        item({
          deliveries: [
            {
              routeId: "rt_1",
              target: "auto_triage",
              index: 0,
              kind: "agent",
              attempts: 0,
              outcome: "deferred",
              classification: "awaiting_batch",
              updatedAt: "2026-09-01T19:00:00.000Z",
            },
          ],
        }),
      ],
    });
    await click(rows(container)[0]!);

    const ledger = container.querySelector('[data-testid="delivery-ledger"]');
    expect(ledger?.textContent).toContain("auto_triage");
    expect(ledger?.textContent).toContain("batching for the task");
    expect(ledger?.querySelector(".text-destructive")).toBeNull();
  });
});

describe("a level the workspace ceiling clamped", () => {
  test("is shown on the expanded row, because it explains the ledger under it", async () => {
    const { container } = await mount({
      items: [item({ level: "urgent", effectiveLevel: "info" })],
    });
    await click(rows(container)[0]!);
    const line = container.querySelector('[data-testid="effective-level"]');
    expect(line?.textContent).toContain("info");
  });

  test("is absent when nothing was clamped", async () => {
    const { container } = await mount({ items: [item({ level: "urgent" })] });
    await click(rows(container)[0]!);
    expect(container.querySelector('[data-testid="effective-level"]')).toBeNull();
  });
});

describe("a level is urgency, not tone", () => {
  test("only an urgent row is marked; info and attention look alike and are named to a screen reader", async () => {
    const { container } = await mount({
      items: [
        item({ id: "a:1", seq: 1, level: "info", title: "info-row" }),
        item({ id: "a:2", seq: 2, level: "attention", title: "attention-row" }),
        item({ id: "a:3", seq: 3, level: "urgent", title: "urgent-row" }),
      ],
    });
    const byTitle = (title: string) => rows(container).find((r) => r.textContent?.includes(title))!;
    const visible = (row: HTMLElement) => {
      const copy = row.cloneNode(true) as HTMLElement;
      for (const s of Array.from(copy.querySelectorAll(".sr-only"))) s.remove();
      return copy.textContent ?? "";
    };
    const edge = (row: HTMLElement) => row.closest("li")?.className ?? "";
    const spoken = (row: HTMLElement) => row.querySelector(".sr-only")?.textContent;

    expect(visible(byTitle("urgent-row"))).toContain("Urgent");
    expect(edge(byTitle("urgent-row"))).toContain("border-l-destructive");

    for (const title of ["info-row", "attention-row"]) {
      expect(visible(byTitle(title))).not.toContain("Urgent");
      expect(visible(byTitle(title))).not.toContain("Attention");
      expect(edge(byTitle(title))).toContain("border-l-transparent");
    }
    expect(spoken(byTitle("info-row"))).toBe("Info, unread");
    expect(spoken(byTitle("attention-row"))).toBe("Attention, unread");
  });
});

describe("ordering and the empty state", () => {
  test("newest first whatever the level, so a page loaded below never reorders the one above", async () => {
    const { container } = await mount({
      items: [
        item({ id: "a:1", seq: 1, level: "info", title: "info-old" }),
        item({ id: "a:2", seq: 2, level: "urgent", title: "urgent-old" }),
        item({ id: "a:3", seq: 3, level: "info", title: "info-new" }),
      ],
    });
    const titles = rows(container).map(
      (r) => r.querySelector('[data-testid="notification-title"]')?.textContent,
    );
    expect(titles).toEqual(["info-new", "urgent-old", "info-old"]);
  });

  test("an empty inbox says what fills it, not nothing", async () => {
    const { container } = await mount({ items: [] });
    expect(container.textContent).toContain("declares an outbox");
  });
});

describe("?item= — where a link from outside the shell lands", () => {
  test("opens the row it names, and marks it read", async () => {
    const { container, markRead } = await mount(
      {
        items: [
          item({ id: "acme:evt_1", body: "DNS propagated." }),
          item({ id: "acme:evt_2", seq: 2 }),
        ],
      },
      [],
      "/w/ws-outbound/notifications?item=acme%3Aevt_1",
    );
    // Expanded without a click: the body is on screen.
    expect(container.textContent).toContain("DNS propagated.");
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0]?.[0]).toEqual(["acme:evt_1"]);
  });

  test("a new ?item= on the open page opens and marks that row too", async () => {
    // The bell's preview links to `?item=` while the inbox may already be the
    // page on screen, so the page follows the parameter as it changes.
    const { container, markRead } = await mount(
      {
        items: [
          item({ id: "acme:evt_1", body: "DNS propagated." }),
          item({ id: "acme:evt_2", seq: 2, body: "Mailbox warmed." }),
        ],
      },
      [],
      "/w/ws-outbound/notifications?item=acme%3Aevt_1",
    );
    await act(async () => {
      navigate("/w/ws-outbound/notifications?item=acme%3Aevt_2");
    });
    expect(container.textContent).toContain("Mailbox warmed.");
    expect(markRead.mock.calls.map((call) => call[0])).toEqual([["acme:evt_1"], ["acme:evt_2"]]);
  });

  test("an id that names nothing lands on the list and marks nothing", async () => {
    // A link to an item that has aged out of the 90-day window, or to another
    // workspace's. The reader gets the inbox rather than an error.
    const { container, markRead } = await mount(
      { items: [item({ id: "acme:evt_1" })] },
      [],
      "/w/ws-outbound/notifications?item=acme%3Agone",
    );
    expect(rows(container)).toHaveLength(1);
    expect(markRead).not.toHaveBeenCalled();
  });

  test("no ?item= opens nothing", async () => {
    const { container, markRead } = await mount({
      items: [item({ body: "DNS propagated." })],
    });
    expect(container.textContent).not.toContain("DNS propagated.");
    expect(markRead).not.toHaveBeenCalled();
  });
});

describe("subject", () => {
  test("shows on the row only when the title does not already name it", async () => {
    const { container } = await mount({
      items: [
        item({
          id: "a:1",
          seq: 1,
          title: "acme-outreach.com is active",
          subject: "acme-outreach.com",
        }),
        item({ id: "a:2", seq: 2, title: "Sequence finished", subject: "Q4 founders" }),
      ],
    });
    const text = rows(container).map((r) => r.textContent ?? "");
    expect(text[0]).toContain("Q4 founders");
    expect(text[1]?.split("acme-outreach.com").length).toBe(2);
  });

  test("counts as named when only the case differs", async () => {
    const { container } = await mount({
      items: [item({ title: "Acme-Outreach.com is active", subject: "acme-outreach.com" })],
    });
    const text = (rows(container)[0]?.textContent ?? "").toLowerCase();
    expect(text.split("acme-outreach.com").length).toBe(2);
  });
});

describe("unread", () => {
  test("an unread row carries the dot and a read row does not", async () => {
    const { container } = await mount({
      items: [
        item({ id: "a:1", seq: 1, title: "fresh" }),
        item({ id: "a:2", seq: 2, title: "seen", readAt: "2026-09-01T19:00:00.000Z" }),
      ],
    });
    const byTitle = (title: string) => rows(container).find((r) => r.textContent?.includes(title));
    expect(
      byTitle("fresh")?.querySelector('[data-testid="notification-unread-dot"]'),
    ).not.toBeNull();
    expect(byTitle("seen")?.querySelector('[data-testid="notification-unread-dot"]')).toBeNull();
  });

  test("the header counts the shell's total, not the rows on screen", async () => {
    const { container } = await mount({ items: [item()], unread: 140 });
    expect(container.querySelector('[data-testid="inbox-unread-count"]')?.textContent).toBe(
      "140 unread",
    );
  });
});

describe("filters", () => {
  test("each URL filter reaches the server as its list argument", async () => {
    await mount(
      {},
      [],
      "/w/ws-outbound/notifications?status=unread&level=attention&app=acme&q=reply&within=7d",
    );
    const args = pageReads().at(-1)!;
    expect(args.unreadOnly).toBe(true);
    expect(args.level).toBe("attention");
    expect(args.source).toBe("acme");
    expect(args.query).toBe("reply");
    const since = Date.parse(String(args.since));
    expect(Math.abs(Date.now() - 7 * 24 * 60 * 60 * 1000 - since)).toBeLessThan(60_000);
  });

  test("no filters sends none", async () => {
    await mount();
    expect(pageReads().at(-1)).toEqual({ limit: 25 });
  });

  test("a filtered view with nothing in it says so, with a way out", async () => {
    const { container } = await mount({}, [], "/w/ws-outbound/notifications?status=unread");
    expect(container.textContent).toContain("Nothing matches these filters.");
    expect(container.textContent).not.toContain("Nothing yet.");
  });
});

describe("a row read under the Unread filter", () => {
  test("stays on screen, open, through the re-read that no longer returns it", async () => {
    const { container } = await mount(
      { items: [item({ body: "the body" })] },
      [],
      "/w/ws-outbound/notifications?status=unread",
      { live: true },
    );
    await click(rows(container)[0]!);
    // Let the re-read the mark caused land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(listArgs.length).toBeGreaterThan(1);
    expect(rows(container)).toHaveLength(1);
    expect(container.textContent).toContain("the body");
    expect(container.textContent).not.toContain("Nothing matches these filters.");
  });
});

describe("mark all read", () => {
  test("says it marks only what is shown when the inbox holds more unread", async () => {
    const { container } = await mount({ items: [item()], unread: 140 });
    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").startsWith("Mark"),
    );
    expect(button?.textContent).toBe("Mark shown read");
  });
});

describe("the app", () => {
  test("a row names its connector by display name, or by server name when not installed", async () => {
    const { container } = await mount(
      {
        items: [
          item({ id: "acme:1", seq: 1, source: "acme", title: "from-acme" }),
          item({ id: "beta:2", seq: 2, source: "beta", title: "from-beta" }),
        ],
      },
      [],
      undefined,
      { installed: [installedApp("acme", "Acme Outreach")] },
    );
    const byTitle = (title: string) => rows(container).find((r) => r.textContent?.includes(title));
    expect(byTitle("from-acme")?.textContent).toContain("Acme Outreach");
    expect(byTitle("from-beta")?.textContent).toContain("beta");
  });

  test("a source in the inbox is in the App filter even when not installed", async () => {
    const { container } = await mount({ items: [item({ source: "beta" })] }, [], undefined, {
      installed: [installedApp("acme", "Acme Outreach")],
    });
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="App"]');
    const values = Array.from(select?.options ?? []).map((o) => o.value);
    expect(values).toEqual(["", "acme", "beta"]);
  });
});

describe("paging", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      item({ id: `a:${i + 1}`, seq: i + 1, title: `item ${i + 1}`, body: `body ${i + 1}` }),
    );
  const loadOlderButton = (container: HTMLElement) =>
    container.querySelector('[data-testid="inbox-load-older"]') as HTMLButtonElement | null;

  test("shows a page of 25 and loads the next below the oldest row", async () => {
    const { container } = await mount({ items: many(30) });
    expect(rows(container)).toHaveLength(25);
    await act(async () => {
      loadOlderButton(container)?.click();
    });
    expect(pageReads().at(-1)?.before).toBe(6);
    expect(rows(container)).toHaveLength(30);
    expect(loadOlderButton(container)).toBeNull();
  });

  test("no Load older when the first page is all of it", async () => {
    const { container } = await mount({ items: many(25) });
    expect(rows(container)).toHaveLength(25);
    expect(loadOlderButton(container)).toBeNull();
  });

  test("a link to an item older than the first page pages down to it and opens it", async () => {
    const { container, markRead } = await mount(
      { items: many(60) },
      [],
      "/w/ws-outbound/notifications?item=a%3A3",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("body 3");
    expect(markRead.mock.calls.map((call) => call[0])).toEqual([["a:3"]]);
  });

  test("counts the unread items needing attention across the inbox and links to them", async () => {
    const items = [
      item({ id: "a:1", seq: 1, level: "urgent", title: "old and urgent" }),
      ...many(40)
        .slice(1)
        .map((n) => ({ ...n, id: `b:${n.seq}` })),
    ];
    const { container } = await mount({ items });
    const link = container.querySelector(
      '[data-testid="inbox-needs-attention"]',
    ) as HTMLButtonElement | null;
    expect(link?.textContent).toBe("1 need attention");
    await act(async () => {
      link?.click();
    });
    const args = pageReads().at(-1);
    expect(args?.unreadOnly).toBe(true);
    expect(args?.level).toBe("attention");
    expect(container.textContent).toContain("old and urgent");
  });
});
