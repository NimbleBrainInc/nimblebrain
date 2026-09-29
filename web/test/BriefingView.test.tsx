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
  localStorage.clear();
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
  workspaceId?: string;
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
      workspaceId={p.workspaceId ?? "ws_test"}
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
    expect(button?.getElementsByTagName("span")[2]?.className).toContain("text-muted-foreground");
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
    const row = findByTestId(mounted.container, "briefing-item");
    // Only the row's hide control is a button; the row itself opens nothing.
    expect(Array.from(row?.getElementsByTagName("button") ?? []).map((b) => b.getAttribute("data-testid"))).toEqual(["briefing-hide"]);
  });

  test("renders a label as text, never as markup", async () => {
    const briefing = makeBriefing({
      items: [{ app: "CRM", facet: "x", label: "<b>bold</b>", count: 1, level: "warning", route: null, state: "ok" }],
    });
    mounted = await mount(view({ briefing }));
    expect(mounted.container.getElementsByTagName("b")).toHaveLength(0);
    expect(mounted.container.textContent ?? "").toContain("<b>bold</b>");
  });

  test("a connector needing reconnection gets a row that opens its page", async () => {
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
    expect(rows[0]?.textContent).toBe("Critical: Reconnection needed · Gmail");
    await act(async () => {
      rows[0]?.getElementsByTagName("button")[0]?.click();
    });
    expect(opened).toEqual(["gmail"]);
  });

  test("a connector at rest (never connected, or disconnected) gets no row", async () => {
    mounted = await mount(
      view({
        briefing: makeBriefing({ items: [] }),
        connectors: [connector("gmail", "not_connected", "Gmail"), connector("crm", "ready")],
      }),
    );
    // Nothing else needs anyone either, so there is no panel at all.
    expect(findByTestId(mounted.container, "workspace-briefing")).toBeNull();
    expect(mounted.container.innerHTML).toBe("");
  });

  test("every status but ready and not_connected gets a row, with the connector page's label", async () => {
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
      ["critical", "Critical: Reconnection needed · Notion"],
      ["critical", "Critical: 1 Tasks blocked · Tasks"],
      ["warning", "Warning: 4 Drafts · Out"],
      ["info", "Info: Connecting… · Slack"],
      ["info", "Info: 2 Replies · Out"],
    ]);
    // The level's tone is on the icon badge, the row's first span.
    const tone = (li: Element) => li.getElementsByTagName("span")[0]?.getAttribute("class") ?? "";
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

  describe("no element", () => {
    test("when there are no items and every connector is ready", async () => {
      mounted = await mount(
        view({ briefing: makeBriefing({ items: [] }), connectors: [connector("crm", "ready")] }),
      );
      expect(findByTestId(mounted.container, "workspace-briefing")).toBeNull();
      expect(mounted.container.innerHTML).toBe("");
    });

    test("while loading", async () => {
      mounted = await mount(view({ briefing: null, loading: true }));
      expect(mounted.container.innerHTML).toBe("");
    });

    test("but a connector needing attention is enough to show it", async () => {
      mounted = await mount(
        view({ briefing: makeBriefing({ items: [] }), connectors: [connector("g", "needs_auth")] }),
      );
      expect(findByTestId(mounted.container, "workspace-briefing")).not.toBeNull();
    });
  });

  describe("hiding a row until it changes", () => {
    const one = (count: number) =>
      makeBriefing({
        items: [{ app: "Tasks", facet: "blocked", label: "Tasks blocked", count, level: "critical", route: null, state: "ok" }],
      });
    const rows = () => findAllByTestId(mounted!.container, "briefing-item");
    const hideFirst = async () => {
      await act(async () => {
        findByTestId(mounted!.container, "briefing-hide")?.click();
      });
    };
    const rerender = async (element: React.ReactElement) => {
      mounted?.unmount();
      mounted = await mount(element);
    };

    test("hides it, counts it in the header, and Show brings it back", async () => {
      mounted = await mount(view({ briefing: one(2) }));
      await hideFirst();
      expect(rows()).toHaveLength(0);
      expect(findByTestId(mounted.container, "briefing-show-hidden")?.textContent).toBe("1 hidden · Show");
      await act(async () => {
        findByTestId(mounted!.container, "briefing-show-hidden")?.click();
      });
      expect(rows()).toHaveLength(1);
    });

    test("stays hidden across a reload while the count holds or falls", async () => {
      mounted = await mount(view({ briefing: one(2) }));
      await hideFirst();
      await rerender(view({ briefing: one(2) }));
      expect(rows()).toHaveLength(0);
      await rerender(view({ briefing: one(1) }));
      expect(rows()).toHaveLength(0);
    });

    test("comes back when new work follows progress", async () => {
      mounted = await mount(view({ briefing: one(2) }));
      await hideFirst();
      await rerender(view({ briefing: one(1) }));
      expect(rows()).toHaveLength(0);
      await rerender(view({ briefing: one(2) }));
      expect(rows().map((r) => r.textContent)).toEqual(["Critical: 2 Tasks blocked · Tasks"]);
    });

    test("once back, a later fall does not hide it again", async () => {
      mounted = await mount(view({ briefing: one(2) }));
      await hideFirst();
      await rerender(view({ briefing: one(3) }));
      await rerender(view({ briefing: one(2) }));
      expect(rows()).toHaveLength(1);
    });

    test("comes back when the count rises", async () => {
      mounted = await mount(view({ briefing: one(2) }));
      await hideFirst();
      await rerender(view({ briefing: one(3) }));
      expect(rows().map((r) => r.textContent)).toEqual(["Critical: 3 Tasks blocked · Tasks"]);
    });

    test("a hidden connector comes back when its status changes", async () => {
      const empty = makeBriefing({ items: [] });
      mounted = await mount(view({ briefing: empty, connectors: [connector("n", "needs_auth", "Notion")] }));
      await hideFirst();
      await rerender(view({ briefing: empty, connectors: [connector("n", "needs_auth", "Notion")] }));
      expect(findAllByTestId(mounted.container, "briefing-connector-status")).toHaveLength(0);
      await rerender(view({ briefing: empty, connectors: [connector("n", "failed", "Notion")] }));
      expect(findAllByTestId(mounted.container, "briefing-connector-status")).toHaveLength(1);
    });

    test("forgets a hidden row that went away, so its return shows", async () => {
      mounted = await mount(view({ briefing: one(2), connectors: [connector("n", "needs_auth")] }));
      await hideFirst();
      // The facet goes to zero (the server omits it), then returns at the same count.
      await rerender(view({ briefing: makeBriefing({ items: [] }), connectors: [connector("n", "needs_auth")] }));
      await rerender(view({ briefing: one(2), connectors: [connector("n", "needs_auth")] }));
      expect(rows()).toHaveLength(1);
    });

    test("is scoped to the workspace", async () => {
      mounted = await mount(view({ briefing: one(2), workspaceId: "ws_a" }));
      await hideFirst();
      await rerender(view({ briefing: one(2), workspaceId: "ws_b" }));
      expect(rows()).toHaveLength(1);
    });

    test("keeps the panel, with Show, when every row is hidden", async () => {
      mounted = await mount(view({ briefing: one(2) }));
      await hideFirst();
      expect(findByTestId(mounted.container, "workspace-briefing")).not.toBeNull();
      expect(findByTestId(mounted.container, "briefing-show-hidden")).not.toBeNull();
    });
  });

  test("an error shows while the panel is collapsed", async () => {
    mounted = await mount(view());
    await act(async () => {
      findByTestId(mounted!.container, "briefing-toggle")?.click();
    });
    mounted.unmount();
    mounted = await mount(view({ error: "boom" }));
    expect(findByTestId(mounted.container, "briefing-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(findByTestId(mounted.container, "workspace-briefing-error")?.textContent).toContain("boom");
  });

  test("collapses and expands, and remembers it", async () => {
    mounted = await mount(view());
    const toggle = () => findByTestId(mounted!.container, "briefing-toggle");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      toggle()?.click();
    });
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(mounted.container.getElementsByTagName("li")).toHaveLength(0);
    expect(findByTestId(mounted.container, "briefing-critical-count")?.textContent).toBe("1 critical");
    mounted.unmount();
    mounted = await mount(view());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
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
