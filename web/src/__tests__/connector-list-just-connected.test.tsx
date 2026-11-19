// ---------------------------------------------------------------------------
// ConnectorList marks the connector an OAuth sign-in just connected.
//
// After `?connected=<server name>` resolves to a ready connector, that row (and
// only that row) reads "Connected just now" and scrolls into view. The mark
// holds only while the connector is ready: when a later re-read reports another
// status, the row shows its normal status summary instead.
// ---------------------------------------------------------------------------

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type { InstalledConnector } from "../api/client";
import type { UseEventsOptions } from "../hooks/useEvents";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let installed: InstalledConnector[] = [];
const getInstalledConnectors = mock(async () => ({ installed }));

mock.module("../api/client", () => ({
  ...realClient,
  getInstalledConnectors,
}));

// The list re-reads on a connection-state event; the test fires one by hand.
let events: UseEventsOptions = {};
mock.module("../hooks/useEvents", () => ({
  useEvents: (opts: UseEventsOptions) => {
    events = opts;
  },
}));

// happy-dom has no layout, so record which row asked to scroll, by its link.
const scrolled: string[] = [];
const realScrollIntoView = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = function (this: Element) {
  scrolled.push(this.getAttribute("href") ?? this.tagName);
};
afterAll(() => {
  Element.prototype.scrollIntoView = realScrollIntoView;
});

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { NoticeProvider } = await import("../components/notices");
const { ConnectorList } = await import("../components/connectors/ConnectorList");

function connector(
  serverName: string,
  displayName: string,
  status: InstalledConnector["status"],
): InstalledConnector {
  return {
    serverName,
    connectorName: serverName,
    displayName,
    disconnectable: true,
    version: "1.0.0",
    state: "running",
    scope: "workspace",
    interactive: false,
    toolCount: 1,
    allowedTools: [],
    status,
  } as InstalledConnector;
}

const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

let unmount: (() => void) | null = null;

async function mount(url: string): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [url] },
        React.createElement(
          NoticeProvider,
          null,
          React.createElement(ConnectorList, { configureBasePath: "/connectors" }),
        ),
      ),
    );
  });
  await settle();
  unmount = () => {
    root.unmount();
    container.remove();
  };
  return container;
}

const rowFor = (container: HTMLElement, serverName: string) =>
  container.querySelector(`a[href="/connectors/${serverName}"]`);

beforeEach(() => {
  unmount?.();
  unmount = null;
  scrolled.length = 0;
  events = {};
  getInstalledConnectors.mockClear();
});

describe("ConnectorList: Connected just now", () => {
  test("marks and scrolls to only the connector the sign-in connected", async () => {
    installed = [connector("granola", "Granola", "ready"), connector("gmail", "Gmail", "ready")];
    const container = await mount("/connectors?connected=granola");

    const granola = rowFor(container, "granola");
    expect(granola?.textContent).toContain("Connected just now");
    expect(rowFor(container, "gmail")?.textContent).not.toContain("Connected just now");
    expect(scrolled).toEqual(["/connectors/granola"]);
  });

  test("shows the status summary instead once the connector is no longer ready", async () => {
    installed = [connector("granola", "Granola", "ready")];
    const container = await mount("/connectors?connected=granola");
    expect(rowFor(container, "granola")?.textContent).toContain("Connected just now");

    installed = [connector("granola", "Granola", "needs_auth")];
    await act(async () => {
      events.onConnectionStateChanged?.({
        wsId: "ws_a",
        serverName: "granola",
        connectorName: "granola",
        principalId: "usr_a",
        state: "reauth_required",
      });
    });
    await settle();

    const text = rowFor(container, "granola")?.textContent ?? "";
    expect(text).not.toContain("Connected just now");
    expect(text).toContain("Reconnect");
  });

  test("marks nothing without a sign-in to confirm", async () => {
    installed = [connector("granola", "Granola", "ready")];
    const container = await mount("/connectors");

    expect(container.textContent).not.toContain("Connected just now");
    expect(scrolled).toEqual([]);
  });
});
