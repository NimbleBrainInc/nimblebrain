// ---------------------------------------------------------------------------
// UsageTotalsCards — the two numbers that must qualify themselves.
//
// Usage reporting was rebuilt because spend that existed was not being shown.
// Two of these cards can reintroduce that one layer up, in the rendering:
//
//   - the cost total omits calls whose model has no known price, so a large
//     token count beside a small dollar figure reads as cheap rather than as
//     partly unknown;
//   - the session count omitted automation runs entirely, which is the exact
//     spend that was invisible in the first place.
//
// Both signals are conditional, so the tests assert they appear when the data
// says they should AND stay absent when it does not — a card that always
// carries the caveat is as useless as one that never does.
//
// Rendering goes through react-dom/client directly, mirroring the other
// component tests here (happy-dom's selector parser chokes on some
// testing-library inputs).
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { UsageTotalsCards } = await import("../pages/settings/usage-shared");
const { OrgUsageBody } = await import("../pages/settings/OrgUsageTab");
interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}
let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const ZERO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** A totals payload with the shape the aggregator produces. */
function totals(over: Record<string, unknown> = {}) {
  return {
    tokens: { ...ZERO_TOKENS, input: 1_000_000, output: 500_000 },
    cost: { ...ZERO_COST, input: 3, output: 2, total: 5 },
    llmCalls: 40,
    llmMs: 0,
    conversations: 7,
    ...over,
  } as Parameters<typeof UsageTotalsCards>[0]["totals"];
}

function render(node: React.ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted = {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  return container;
}

describe("the cost card says when its figure is incomplete", () => {
  test("names the excluded calls when some have no known price", () => {
    const el = render(
      React.createElement(UsageTotalsCards, { totals: totals({ unpricedCalls: 14 }) }),
    );
    expect(el.textContent).toContain("14");
    expect(el.textContent?.toLowerCase()).toContain("no known price");
  });

  test("says nothing when every call is priced", () => {
    // The caveat has to be absent here, or it stops meaning anything where it
    // does appear.
    const el = render(React.createElement(UsageTotalsCards, { totals: totals() }));
    expect(el.textContent?.toLowerCase()).not.toContain("no known price");
  });

  test("reads as singular for one call", () => {
    const el = render(
      React.createElement(UsageTotalsCards, { totals: totals({ unpricedCalls: 1 }) }),
    );
    expect(el.textContent).toContain("1 call with no known price");
  });
});

describe("the session card counts automation runs", () => {
  test("sums chats and runs, and shows the split", () => {
    const el = render(
      React.createElement(UsageTotalsCards, { totals: totals({ conversations: 7, runs: 178 }) }),
    );
    // 185, not 7 — the undercount this whole change exists to remove.
    expect(el.textContent).toContain("185");
    expect(el.textContent).toContain("Automation runs");
    expect(el.textContent).toContain("178");
    expect(el.textContent).toContain("Sessions");
  });

  test("stays the Conversations card for a tenant with no automations", () => {
    const el = render(
      React.createElement(UsageTotalsCards, { totals: totals({ conversations: 7 }) }),
    );
    expect(el.textContent).toContain("Conversations");
    expect(el.textContent).not.toContain("Automation runs");
  });
});

describe("the per-user breakdown row carries the same two signals", () => {
  /** A report with one user row, shaped as the aggregator emits it. */
  function report(row: Record<string, unknown>) {
    return {
      scope: "org",
      period: { from: "2026-08-01", to: "2026-08-08" },
      totals: totals({ runs: 178 }),
      models: [],
      // The body reads `breakdowns.user`, not `breakdown` — the per-dimension
      // map is what the org view groups by.
      breakdowns: {
        user: [
          {
            key: "usr_a",
            tokens: { ...ZERO_TOKENS, input: 10 },
            cost: { ...ZERO_COST },
            llmCalls: 3,
            conversations: 2,
            ...row,
          },
        ],
      },
      breakdown: [],
    } as Parameters<typeof OrgUsageBody>[0]["report"];
  }

  test("the session cell sums chats and runs", () => {
    const el = render(
      React.createElement(OrgUsageBody, { report: report({ runs: 9 }), users: new Map() }),
    );
    // 11, not 2 — the row-level half of the same undercount.
    expect(el.textContent).toContain("11");
  });

  test("an all-unpriced user's cost is marked rather than left reading $0.00", () => {
    const el = render(
      React.createElement(OrgUsageBody, { report: report({ unpricedCalls: 3 }), users: new Map() }),
    );
    expect(el.textContent).toContain("unpriced");
    expect(el.textContent).toContain("3");
  });

  test("a fully priced row carries no marker", () => {
    const el = render(React.createElement(OrgUsageBody, { report: report({}), users: new Map() }));
    expect(el.textContent).not.toContain("unpriced");
  });
});
