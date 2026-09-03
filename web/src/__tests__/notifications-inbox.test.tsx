// ---------------------------------------------------------------------------
// The inbox panel — the four things it must never get wrong.
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
//
// Renders the page against a supplied context value rather than a mocked API:
// the provider's fetching is a separate contract (see
// notifications-provider.test.tsx), and what is under test here is what the
// page does with items it already has.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { NotificationView } from "../api/notifications";
import type { NotificationsValue } from "../context/NotificationsContext";

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

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");
const { NotificationsContext } = await import("../context/NotificationsContext");
const { NotificationsPage } = await import("../pages/NotificationsPage");

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

async function mount(over: Partial<NotificationsValue> = {}): Promise<{
  container: HTMLDivElement;
  markRead: ReturnType<typeof mock>;
}> {
  const markRead = mock(async () => {});
  const value: NotificationsValue = {
    items: [],
    unread: 0,
    loading: false,
    error: null,
    atPageLimit: false,
    refresh: () => {},
    markRead,
    markAllRead: async () => {},
    ...over,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/w/ws-outbound/notifications"] },
        React.createElement(
          NotificationsContext.Provider,
          { value },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, {
              path: "/w/:slug/notifications",
              element: React.createElement(NotificationsPage),
            }),
          ),
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
              attempts: 3,
              outcome: "failed",
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
});

describe("ordering and the empty state", () => {
  test("urgent and attention sort above info, newest first within a level", async () => {
    const { container } = await mount({
      items: [
        item({ id: "a:1", seq: 1, level: "info", title: "info-old" }),
        item({ id: "a:2", seq: 2, level: "urgent", title: "urgent-old" }),
        item({ id: "a:3", seq: 3, level: "info", title: "info-new" }),
        item({ id: "a:4", seq: 4, level: "attention", title: "attention-new" }),
        item({ id: "a:5", seq: 5, level: "urgent", title: "urgent-new" }),
      ],
    });
    const titles = rows(container).map((r) => r.textContent?.split("acme")[0]?.trim());
    expect(titles).toEqual(["urgent-new", "urgent-old", "attention-new", "info-new", "info-old"]);
  });

  test("an empty inbox says what fills it, not nothing", async () => {
    const { container } = await mount({ items: [] });
    expect(container.textContent).toContain("declares an outbox");
  });
});
