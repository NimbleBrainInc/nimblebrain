// BriefingView — render contract for the restored workspace briefing surface.
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
    greeting: "Good morning",
    date: "Monday, May 25, 2026",
    lede: "Two things need a look; everything else is quiet.",
    state: "attention",
    generated_at: "2026-05-25T08:00:00.000Z",
    cached: false,
    sections: [
      {
        id: "s-recent",
        text: "Closed **3 deals** yesterday.",
        type: "positive",
        category: "recent",
      },
      {
        id: "s-attention",
        text: "2 follow-ups are overdue.",
        type: "warning",
        category: "attention",
        action: { type: "navigate", label: "View deals", route: "@acme/crm", prompt: null },
      },
      {
        id: "s-upcoming",
        text: "A renewal is due Friday.",
        type: "neutral",
        category: "upcoming",
        action: {
          type: "startChat",
          label: "Draft outreach",
          route: null,
          prompt: "Draft a renewal email",
        },
      },
    ],
    ...overrides,
  };
}

describe("BriefingView", () => {
  test("renders the lede and section texts, inline markdown as <strong>", async () => {
    mounted = await mount(
      <BriefingView briefing={makeBriefing()} loading={false} error={null} onRetry={() => {}} />,
    );
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Two things need a look");
    expect(text).toContain("follow-ups are overdue");
    expect(text).toContain("renewal is due Friday");
    // getElementsByTagName, not querySelector — happy-dom's querySelector
    // throws under bun in this setup (see the other web component tests).
    const strongs = Array.from(mounted.container.getElementsByTagName("strong"));
    expect(strongs.some((s) => s.textContent === "3 deals")).toBe(true);
  });

  test("orders categories attention → recent → upcoming", async () => {
    mounted = await mount(
      <BriefingView briefing={makeBriefing()} loading={false} error={null} onRetry={() => {}} />,
    );
    const text = mounted.container.textContent ?? "";
    const attention = text.indexOf("Needs attention");
    const recent = text.indexOf("Recent");
    const upcoming = text.indexOf("Coming up");
    expect(attention).toBeGreaterThanOrEqual(0);
    expect(attention).toBeLessThan(recent);
    expect(recent).toBeLessThan(upcoming);
  });

  test("renders a button for navigate actions and fires onAction", async () => {
    let calls = 0;
    mounted = await mount(
      <BriefingView
        briefing={makeBriefing()}
        loading={false}
        error={null}
        onRetry={() => {}}
        onAction={() => {
          calls++;
        }}
      />,
    );
    const btn = findButton(mounted.container, "View deals");
    expect(btn).not.toBeNull();
    await act(async () => {
      btn?.click();
    });
    expect(calls).toBe(1);
  });

  test("does NOT render a button for startChat actions (v1)", async () => {
    mounted = await mount(
      <BriefingView
        briefing={makeBriefing()}
        loading={false}
        error={null}
        onRetry={() => {}}
        onAction={() => {}}
      />,
    );
    expect(mounted.container.textContent ?? "").toContain("renewal is due Friday");
    expect(findButton(mounted.container, "Draft outreach")).toBeNull();
  });

  test("shows an empty state when there are no sections", async () => {
    mounted = await mount(
      <BriefingView
        briefing={makeBriefing({ sections: [], state: "all-clear", lede: "" })}
        loading={false}
        error={null}
        onRetry={() => {}}
      />,
    );
    expect(findByTestId(mounted.container, "workspace-briefing-empty")).not.toBeNull();
  });

  test("renders an error with a working Retry", async () => {
    let calls = 0;
    mounted = await mount(
      <BriefingView
        briefing={null}
        loading={false}
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
