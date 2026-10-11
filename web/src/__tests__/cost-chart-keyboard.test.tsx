// ---------------------------------------------------------------------------
// CostChart — a day's figures reach the keyboard and a screen reader.
//
// The per-day breakdown lives only in the chart, so each bar is focusable,
// shows the tooltip on focus as on hover, and is labelled with the same
// figures.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import type { DayData } from "../components/charts/CostChart";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { CostChart } = await import("../components/charts/CostChart");

function day(key: string, total: number, llmCalls: number): DayData {
  return {
    key,
    llmCalls,
    cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
  };
}

describe("CostChart — bars", () => {
  test("a focused bar is labelled with its figures and opens the tooltip", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(CostChart, {
          data: [day("2026-03-01", 2, 10), day("2026-03-02", 4, 7)],
        }),
      );
    });

    const bars = Array.from(container.getElementsByTagName("g")).filter(
      (g) => g.getAttribute("role") === "img",
    );
    expect(bars.length).toBe(2);
    expect(bars[1]?.getAttribute("tabindex")).toBe("0");
    expect(bars[1]?.getAttribute("aria-label")).toContain("7 calls");
    expect(container.textContent).not.toContain("7 calls");

    await act(async () => {
      bars[1]?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(container.textContent).toContain("7 calls");

    await act(async () => {
      bars[1]?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("7 calls");

    await act(async () => root.unmount());
    container.remove();
  });
});
