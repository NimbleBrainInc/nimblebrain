// BriefingView — render contract for the workspace overview's facet counts.
// Uses the container/createRoot harness (happy-dom + testing-library's
// `screen.getByText` don't mix); query via container.textContent + testids.

import { afterEach, describe, expect, test } from "bun:test";
import type { BriefingOutput } from "../src/_generated/platform-schemas/home";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
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

function makeBriefing(overrides: Partial<BriefingOutput> = {}): BriefingOutput {
  return {
    generated_at: "2026-05-25T08:00:00.000Z",
    items: [
      {
        app: "CRM",
        facet: "overdue",
        label: "Follow-ups overdue",
        count: 2,
        route: "@acme/crm",
        state: "ok",
      },
      {
        app: "Tasks",
        facet: "blocked",
        label: "Tasks blocked",
        count: 0,
        route: null,
        state: "unavailable",
      },
    ],
    ...overrides,
  };
}

describe("BriefingView", () => {
  test("renders each item as its count and label, with the app", async () => {
    mounted = await mount(
      <BriefingView briefing={makeBriefing()} error={null} onRetry={() => {}} />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("2 Follow-ups overdue");
    expect(text).toContain("CRM");
    expect(text).toContain("Tasks blocked — unavailable");
  });

  test("renders a label as text, never as markup", async () => {
    const briefing = makeBriefing({
      items: [
        {
          app: "CRM",
          facet: "x",
          label: "<b>bold</b>",
          count: 1,
          route: null,
          state: "ok",
        },
      ],
    });
    mounted = await mount(<BriefingView briefing={briefing} error={null} onRetry={() => {}} />);
    expect(mounted.container.getElementsByTagName("b")).toHaveLength(0);
    expect(mounted.container.textContent ?? "").toContain("<b>bold</b>");
  });

  test("opens an item's app route, and offers no action without one", async () => {
    const opened: string[] = [];
    mounted = await mount(
      <BriefingView
        briefing={makeBriefing()}
        error={null}
        onRetry={() => {}}
        onOpen={(route) => opened.push(route)}
      />,
    );
    const buttons = Array.from(mounted.container.getElementsByTagName("button"));
    expect(buttons).toHaveLength(1);
    await act(async () => {
      findButton(mounted!.container, "Open")?.click();
    });
    expect(opened).toEqual(["@acme/crm"]);
  });

  test("renders nothing when no item is waiting", async () => {
    mounted = await mount(
      <BriefingView briefing={makeBriefing({ items: [] })} error={null} onRetry={() => {}} />,
    );
    expect(findByTestId(mounted.container, "workspace-briefing")).toBeNull();
  });

  test("renders an error with a working Retry", async () => {
    let calls = 0;
    mounted = await mount(
      <BriefingView
        briefing={null}
        error="boom"
        onRetry={() => {
          calls++;
        }}
      />,
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
