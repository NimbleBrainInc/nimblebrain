// ---------------------------------------------------------------------------
// The org usage page: totals cards, their disclosure, and the filter bar.
//
// Usage reporting was rebuilt because spend that existed was not being shown.
// The cards can reintroduce that one layer up, in the rendering:
//
//   - the cost total omits calls whose model has no known price, so a large
//     token count beside a small dollar figure reads as cheap rather than as
//     partly unknown;
//   - automation spend and runs must be shown apart from chat, which is the
//     exact spend that was invisible in the first place.
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

// happy-dom's Window stub doesn't expose SyntaxError/TypeError; querySelector's
// selector parser constructs one and trips on the gap.
{
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { UsageTotalsCards, StatCard, resolveRangePreset } = await import(
  "../pages/settings/usage-shared"
);
const { OrgUsageBody, UsageFilterBar, reportArgs, rangeFor, labelFor } = await import(
  "../pages/settings/OrgUsageTab"
);
type UsageFilterState = Parameters<typeof UsageFilterBar>[0]["filters"];
const NO_LABELS = { users: new Map(), workspaces: new Map() };
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

/** An `origin` breakdown row. */
function originRow(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    tokens: { ...ZERO_TOKENS, input: 100 },
    cost: { ...ZERO_COST, total: 1 },
    llmCalls: 1,
    conversations: 0,
    ...over,
  } as NonNullable<Parameters<typeof UsageTotalsCards>[0]["byOrigin"]>[number];
}

describe("chat and automation spend are shown apart", () => {
  test("the automation card carries the task cost and counts runs", () => {
    const el = render(
      React.createElement(UsageTotalsCards, {
        totals: totals({ conversations: 7, runs: 178 }),
        byOrigin: [
          originRow("chat", { cost: { ...ZERO_COST, total: 1.25 }, conversations: 7 }),
          originRow("task", { cost: { ...ZERO_COST, total: 3.75 }, runs: 178 }),
        ],
      }),
    );
    expect(el.textContent).toContain("Chat cost");
    expect(el.textContent).toContain("$1.25");
    expect(el.textContent).toContain("7 conversations");
    expect(el.textContent).toContain("Automation cost");
    expect(el.textContent).toContain("$3.75");
    expect(el.textContent).toContain("178 automation runs");
  });

  test("system spend is named in the total's detail only when it exists", () => {
    const withSystem = render(
      React.createElement(UsageTotalsCards, {
        totals: totals(),
        byOrigin: [originRow("system", { cost: { ...ZERO_COST, total: 0.5 } })],
      }),
    );
    expect(withSystem.textContent).toContain("System");
    mounted?.unmount();
    mounted = null;
    const without = render(React.createElement(UsageTotalsCards, { totals: totals() }));
    expect(without.textContent).not.toContain("System");
  });
});

describe("a card reveals its detail in place", () => {
  function card() {
    return render(
      React.createElement(StatCard, {
        title: "Total cost",
        value: "$5.00",
        summary: "40 LLM calls",
        details: [
          ["Input", "$3.00"],
          ["Output", "$2.00"],
        ],
      }),
    );
  }

  test("the toggle is a button that reports its state", () => {
    const el = card();
    const button = el.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    // It names the region it controls, and that region exists.
    const controls = button?.getAttribute("aria-controls") ?? "";
    expect(controls).not.toBe("");
    // By id lookup, not a selector: React's generated ids are not valid CSS
    // identifiers, and happy-dom's selector parser rejects them.
    expect(document.getElementById(controls)).not.toBeNull();

    act(() => button?.click());
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    act(() => button?.click());
    expect(button?.getAttribute("aria-expanded")).toBe("false");
  });

  test("opening swaps which face is visible without changing the card's structure", () => {
    // Size stability comes from both faces sharing one grid cell, with the
    // hidden one `invisible` rather than unmounted: the card is always as big
    // as the bigger face. So what has to hold is that both faces stay mounted
    // and the card's own classes do not change — a face that mounted on open,
    // or a card that took a different size class, would resize the row.
    const el = card();
    const cardEl = el.querySelector('[data-slot="card"]') as HTMLElement;
    const button = el.querySelector("button") as HTMLButtonElement;
    const detail = document.getElementById(
      button.getAttribute("aria-controls") ?? "",
    ) as HTMLElement;
    const front = detail.previousElementSibling as HTMLElement;
    const before = { className: cardEl.className, faces: cardEl.querySelectorAll("dl").length };

    expect(front.className).not.toContain("invisible");
    expect(detail.className).toContain("invisible");

    act(() => button.click());
    expect(cardEl.className).toBe(before.className);
    expect(cardEl.querySelectorAll("dl").length).toBe(before.faces);
    expect(front.className).toContain("invisible");
    expect(detail.className).not.toContain("invisible");
    expect(detail.textContent).toContain("Input");
    expect(detail.textContent).toContain("$3.00");
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
      React.createElement(OrgUsageBody, {
        report: report({ runs: 9 }),
        labels: NO_LABELS,
        groupBy: "user",
      }),
    );
    // 11, not 2 — the row-level half of the same undercount.
    expect(el.textContent).toContain("11");
  });

  test("an all-unpriced user's cost is marked rather than left reading $0.00", () => {
    const el = render(
      React.createElement(OrgUsageBody, {
        report: report({ unpricedCalls: 3 }),
        labels: NO_LABELS,
        groupBy: "user",
      }),
    );
    // The count and the word together — `toContain("3")` alone passes off the
    // LLM Calls cell, which the same fixture sets to 3, so it could not fail.
    expect(el.textContent).toContain("+3 unpriced");
  });

  test("a fully priced row carries no marker", () => {
    const el = render(
      React.createElement(OrgUsageBody, { report: report({}), labels: NO_LABELS, groupBy: "user" }),
    );
    expect(el.textContent).not.toContain("unpriced");
  });
});

describe("the table follows the group-by dimension", () => {
  test("workspace rows resolve names from the roster, and unknown ids read as deleted", () => {
    const labels = {
      users: new Map(),
      workspaces: new Map([["ws_example", { id: "ws_example", name: "Acme Ops" }]]),
    };
    expect(labelFor("workspace", "ws_example", labels).name).toBe("Acme Ops");
    expect(labelFor("workspace", "ws_gone", labels)).toEqual({
      name: "ws_gone",
      detail: "Deleted workspace",
    });
    expect(labelFor("workspace", "none", labels).name).toBe("No workspace");
    expect(labelFor("origin", "task", labels).name).toBe("Automation");
  });
});

// ---------------------------------------------------------------------------
// Date ranges and the filter bar
// ---------------------------------------------------------------------------

describe("range presets are whole UTC days", () => {
  // 23:30 at UTC-10 is already the next UTC day; the presets read UTC.
  const NOW = new Date("2026-03-15T09:30:00Z");

  test("last 7 days is seven days counting today", () => {
    expect(resolveRangePreset("last7", NOW)).toEqual({ from: "2026-03-09", to: "2026-03-15" });
  });

  test("last 30 days is thirty days counting today", () => {
    expect(resolveRangePreset("last30", NOW)).toEqual({ from: "2026-02-14", to: "2026-03-15" });
  });

  test("month to date starts on the 1st", () => {
    expect(resolveRangePreset("mtd", NOW)).toEqual({ from: "2026-03-01", to: "2026-03-15" });
  });

  test("last month is the whole previous calendar month, across a year boundary", () => {
    expect(resolveRangePreset("lastMonth", NOW)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(resolveRangePreset("lastMonth", new Date("2026-01-05T00:00:00Z"))).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });

  test("uses the UTC date, not the local one", () => {
    // 2026-03-16T02:00Z is still the 15th in Hawaii; the range must say the 16th.
    expect(resolveRangePreset("last7", new Date("2026-03-16T02:00:00Z")).to).toBe("2026-03-16");
  });
});

function filterState(over: Partial<UsageFilterState> = {}): UsageFilterState {
  return {
    workspaceId: "all",
    userId: "all",
    model: "all",
    range: "last7",
    custom: { from: "2026-03-01", to: "2026-03-10" },
    groupBy: "model",
    ...over,
  };
}

describe("filters become report arguments", () => {
  test("unset filters are omitted; set ones are passed through", () => {
    const range = { from: "2026-03-01", to: "2026-03-10" };
    expect(reportArgs(filterState(), range)).toEqual({
      scope: "org",
      from: "2026-03-01",
      to: "2026-03-10",
      groupBy: ["model", "day", "origin"],
      stackBy: "model",
    });
    const args = reportArgs(
      filterState({ workspaceId: "ws_example", userId: "usr_a", model: "m", groupBy: "origin" }),
      range,
    );
    expect(args).toMatchObject({ workspaceId: "ws_example", userId: "usr_a", model: "m" });
    // `origin` is asked for once, not twice.
    expect(args.groupBy).toEqual(["origin", "day"]);
  });

  test("a custom range with the start after the end yields no window", () => {
    expect(
      rangeFor(filterState({ range: "custom", custom: { from: "2026-03-10", to: "2026-03-01" } })),
    ).toBeNull();
    expect(rangeFor(filterState({ range: "custom" }))).toEqual({
      from: "2026-03-01",
      to: "2026-03-10",
    });
  });
});

describe("the filter bar", () => {
  const labels = {
    users: new Map([["usr_a", { id: "usr_a", email: "a@example.com", displayName: "Ada" }]]),
    workspaces: new Map([["ws_example", { id: "ws_example", name: "Acme Ops" }]]),
  };

  function bar(filters: UsageFilterState, onChange: (f: UsageFilterState) => void = () => {}) {
    return render(
      React.createElement(UsageFilterBar, {
        filters,
        onChange,
        labels,
        models: ["claude-sonnet-4-5"],
      }),
    );
  }

  test("offers every filter, each with an All option and a label", () => {
    const el = bar(filterState());
    for (const [id, text] of [
      ["usage-filter-workspace", "All workspaces"],
      ["usage-filter-user", "All users"],
      ["usage-filter-model", "All models"],
    ] as const) {
      const select = el.querySelector(`#${id}`) as HTMLSelectElement;
      expect(select).not.toBeNull();
      expect(el.querySelector(`label[for="${id}"]`)).not.toBeNull();
      expect(select.options[0]?.textContent).toBe(text);
    }
    expect(el.textContent).toContain("Acme Ops");
    expect(el.textContent).toContain("Ada");
    const range = el.querySelector("#usage-filter-range") as HTMLSelectElement;
    expect([...range.options].map((o) => o.textContent)).toEqual([
      "Month to date",
      "Last 7 days",
      "Last 30 days",
      "Last month",
      "Custom range",
    ]);
    const group = el.querySelector("#usage-filter-group") as HTMLSelectElement;
    expect([...group.options].map((o) => o.textContent)).toEqual([
      "Model",
      "Workspace",
      "User",
      "Origin",
    ]);
  });

  test("date inputs appear only for a custom range", () => {
    expect(bar(filterState()).querySelector('input[type="date"]')).toBeNull();
    mounted?.unmount();
    mounted = null;
    const el = bar(filterState({ range: "custom" }));
    expect(el.querySelectorAll('input[type="date"]')).toHaveLength(2);
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  test("an inverted custom range says so", () => {
    const el = bar(
      filterState({ range: "custom", custom: { from: "2026-03-10", to: "2026-03-01" } }),
    );
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("on or before");
  });

  test("a selected model missing from the list stays selectable", () => {
    const el = bar(filterState({ model: "claude-haiku-4-5" }));
    const select = el.querySelector("#usage-filter-model") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toContain("claude-haiku-4-5");
  });

  test("changing a select reports the new state", () => {
    let next: UsageFilterState | null = null;
    const el = bar(filterState(), (f) => {
      next = f;
    });
    const select = el.querySelector("#usage-filter-workspace") as HTMLSelectElement;
    // The prototype setter, not `select.value =`: React tracks the value it
    // last wrote, and only the native setter updates that tracker.
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    const WindowEvent = (window as unknown as { Event: typeof Event }).Event;
    act(() => {
      setValue?.call(select, "ws_example");
      select.dispatchEvent(new WindowEvent("change", { bubbles: true }));
    });
    expect((next as UsageFilterState | null)?.workspaceId).toBe("ws_example");
  });
});
