// BriefingView — render contract for the workspace overview's list: facet
// counts from the server, a row per connector needing attention, and the
// empty line.
// Uses the container/createRoot harness (happy-dom + testing-library's
// `screen.getByText` don't mix); query via container.textContent + testids.

import { afterEach, describe, expect, test } from "bun:test";
import type { BriefingOutput } from "../src/_generated/platform-schemas/home";
import type { InstalledConnector } from "../src/api/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { BriefingView } = await import("../src/components/briefing/BriefingView");

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function mount(element: React.ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

function findByTestId(c: HTMLElement, id: string): HTMLElement | null {
  for (const el of Array.from(c.getElementsByTagName("*"))) {
    if (el.getAttribute("data-testid") === id) return el as HTMLElement;
  }
  return null;
}

function findButton(c: HTMLElement, text: string): HTMLButtonElement | null {
  for (const el of Array.from(c.getElementsByTagName("button"))) {
    if ((el.textContent ?? "").includes(text)) return el as HTMLButtonElement;
  }
  return null;
}

function findAllByTestId(c: HTMLElement, id: string): HTMLElement[] {
  return Array.from(c.getElementsByTagName("*")).filter(
    (el) => el.getAttribute("data-testid") === id,
  ) as HTMLElement[];
}

function makeBriefing(overrides: Partial<BriefingOutput> = {}): BriefingOutput {
  return {
    generated_at: "2026-05-25T08:00:00.000Z",
    items: [
      {
        app: "CRM",
        facet: "overdue",
        label: "Follow-ups overdue",
        count: 2,
        level: "warning",
        route: "@acme/crm",
        state: "ok",
      },
      {
        app: "Tasks",
        facet: "blocked",
        label: "Tasks blocked",
        count: 0,
        level: "critical",
        route: "@acme/tasks",
        state: "unavailable",
      },
    ],
    ...overrides,
  };
}

function connector(
  serverName: string,
  status: InstalledConnector["status"],
  name?: string,
): InstalledConnector {
  return {
    serverName,
    connectorName: serverName,
    // What the server resolves: the catalog name when there is one, else the server name.
    displayName: name ?? serverName,
    disconnectable: false,
    version: "1.0.0",
    state: "running",
    scope: "workspace",
    interactive: false,
    toolCount: 1,
    status,
    ...(name ? { catalog: { name } as InstalledConnector["catalog"] } : {}),
  };
}

interface Props {
  briefing?: BriefingOutput | null;
  connectors?: InstalledConnector[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onOpen?: (route: string) => void;
  onOpenConnector?: (serverName: string) => void;
}

function view(p: Props = {}) {
  return (
    <BriefingView
      briefing={p.briefing === undefined ? makeBriefing() : p.briefing}
      connectors={p.connectors ?? []}
      loading={p.loading ?? false}
      error={p.error ?? null}
      onRetry={p.onRetry ?? (() => {})}
      onOpen={p.onOpen ?? (() => {})}
      onOpenConnector={p.onOpenConnector ?? (() => {})}
    />
  );
}

describe("BriefingView", () => {
  test("renders each item as its count and label, with the app", async () => {
    mounted = await mount(view());
    const rows = findAllByTestId(mounted.container, "briefing-item");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe("Warning: 2 Follow-ups overdue · CRM");
  });

  test("hides nothing the server sent, in the order it sent it", async () => {
    const briefing = makeBriefing({
      items: [
        { app: "B", facet: "b", label: "Second app", count: 1, level: "warning", route: null, state: "ok" },
        { app: "A", facet: "a", label: "Down", count: 0, level: "warning", route: null, state: "unavailable" },
        { app: "A", facet: "c", label: "Third", count: 7, level: "warning", route: null, state: "ok" },
      ],
    });
    mounted = await mount(view({ briefing }));
    const rows = Array.from(mounted.container.getElementsByTagName("li")).map((li) => li.textContent);
    expect(rows).toEqual([
      "Warning: 1 Second app · B",
      "Warning: Down — unavailable · A",
      "Warning: 7 Third · A",
    ]);
  });

  test("an unavailable item renders muted and keeps its action", async () => {
    const opened: string[] = [];
    mounted = await mount(view({ onOpen: (r) => opened.push(r) }));
    const row = findByTestId(mounted.container, "briefing-item-unavailable");
    expect(row?.textContent).toBe("Critical: Tasks blocked — unavailable · Tasks");
    const button = row?.getElementsByTagName("button")[0];
    expect(button?.className).toContain("text-muted-foreground");
    await act(async () => {
      button?.click();
    });
    expect(opened).toEqual(["@acme/tasks"]);
  });

  test("an item with no route has no action", async () => {
    const briefing = makeBriefing({
      items: [{ app: "A", facet: "a", label: "Things", count: 3, level: "warning", route: null, state: "ok" }],
    });
    mounted = await mount(view({ briefing }));
    expect(mounted.container.getElementsByTagName("button")).toHaveLength(0);
  });

  test("renders a label as text, never as markup", async () => {
    const briefing = makeBriefing({
      items: [{ app: "CRM", facet: "x", label: "<b>bold</b>", count: 1, level: "warning", route: null, state: "ok" }],
    });
    mounted = await mount(view({ briefing }));
    expect(mounted.container.getElementsByTagName("b")).toHaveLength(0);
    expect(mounted.container.textContent ?? "").toContain("<b>bold</b>");
  });

  test("a connector needing sign-in gets a row that opens its page", async () => {
    const opened: string[] = [];
    mounted = await mount(
      view({
        briefing: makeBriefing({ items: [] }),
        connectors: [connector("gmail", "needs_auth", "Gmail"), connector("crm", "ready", "CRM")],
        onOpenConnector: (s) => opened.push(s),
      }),
    );
    const rows = findAllByTestId(mounted.container, "briefing-connector-status");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe("Critical: Sign-in required · Gmail");
    await act(async () => {
      rows[0]?.getElementsByTagName("button")[0]?.click();
    });
    expect(opened).toEqual(["gmail"]);
  });

  test("every status but ready gets a row, with the connector page's label", async () => {
    mounted = await mount(
      view({
        briefing: makeBriefing({ items: [] }),
        connectors: [
          connector("a", "needs_setup"),
          connector("b", "failed"),
          connector("c", "connecting"),
          connector("d", "starting"),
        ],
      }),
    );
    const text = findAllByTestId(mounted.container, "briefing-connector-status").map(
      (r) => r.textContent,
    );
    expect(text).toEqual([
      "Critical: Configuration required · a",
      "Critical: Failed · b",
      "Info: Connecting… · c",
      "Info: Starting… · d",
    ]);
    expect(findByTestId(mounted.container, "workspace-briefing-empty")).toBeNull();
  });

  test("orders every row by level, most urgent first, and shows the level", async () => {
    mounted = await mount(
      view({
        briefing: makeBriefing({
          items: [
            { app: "Out", facet: "d", label: "Drafts", count: 4, level: "warning", route: null, state: "ok" },
            { app: "Out", facet: "r", label: "Replies", count: 2, level: "info", route: null, state: "ok" },
            { app: "Tasks", facet: "b", label: "Tasks blocked", count: 1, level: "critical", route: null, state: "ok" },
          ],
        }),
        connectors: [connector("c", "connecting", "Slack"), connector("n", "needs_auth", "Notion")],
      }),
    );
    const rows = Array.from(mounted.container.getElementsByTagName("li"));
    expect(rows.map((li) => [li.getAttribute("data-level"), li.textContent])).toEqual([
      ["critical", "Critical: Sign-in required · Notion"],
      ["critical", "Critical: 1 Tasks blocked · Tasks"],
      ["warning", "Warning: 4 Drafts · Out"],
      ["info", "Info: Connecting… · Slack"],
      ["info", "Info: 2 Replies · Out"],
    ]);
    const tone = (li: Element) => li.getElementsByTagName("svg")[0]?.getAttribute("class") ?? "";
    expect(tone(rows[0]!)).toContain("text-destructive");
    expect(tone(rows[2]!)).toContain("text-warning");
    expect(tone(rows[3]!)).toContain("text-muted-foreground");
  });

  test("reads a level it does not know as warning, including an inherited key", async () => {
    const odd = { app: "X", facet: "x", label: "Odd", count: 1, route: null, state: "ok" as const };
    mounted = await mount(
      view({
        briefing: makeBriefing({
          items: [
            { ...odd, level: "urgent" as unknown as "warning" },
            { ...odd, facet: "y", level: "constructor" as unknown as "warning" },
          ],
        }),
      }),
    );
    const levels = Array.from(mounted.container.getElementsByTagName("li")).map((li) =>
      li.getAttribute("data-level"),
    );
    expect(levels).toEqual(["warning", "warning"]);
  });

  describe("empty state", () => {
    const EMPTY = "Nothing needs you in this workspace.";

    test("renders when there are no items and every connector is ready", async () => {
      mounted = await mount(
        view({ briefing: makeBriefing({ items: [] }), connectors: [connector("crm", "ready")] }),
      );
      expect(findByTestId(mounted.container, "workspace-briefing-empty")?.textContent).toBe(EMPTY);
      expect(mounted.container.getElementsByTagName("li")).toHaveLength(0);
    });

    test("does not render while a connector needs attention", async () => {
      mounted = await mount(
        view({ briefing: makeBriefing({ items: [] }), connectors: [connector("g", "needs_auth")] }),
      );
      expect(findByTestId(mounted.container, "workspace-briefing-empty")).toBeNull();
    });

    test("does not render while an item is waiting", async () => {
      mounted = await mount(view({ connectors: [connector("crm", "ready")] }));
      expect(findByTestId(mounted.container, "workspace-briefing-empty")).toBeNull();
    });

    test("does not render while loading; a skeleton holds the space", async () => {
      mounted = await mount(view({ briefing: null, loading: true }));
      expect(findByTestId(mounted.container, "workspace-briefing-empty")).toBeNull();
      expect(findByTestId(mounted.container, "workspace-briefing-loading")).not.toBeNull();
    });

    test("does not render on an error", async () => {
      mounted = await mount(view({ briefing: null, error: "boom" }));
      expect(findByTestId(mounted.container, "workspace-briefing-empty")).toBeNull();
    });
  });

  test("renders an error with a working Retry", async () => {
    let calls = 0;
    mounted = await mount(
      view({
        briefing: null,
        error: "boom",
        onRetry: () => {
          calls++;
        },
      }),
    );
    expect(mounted.container.textContent ?? "").toContain("boom");
    const retry = findButton(mounted.container, "Retry");
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
    });
    expect(calls).toBe(1);
  });
});
