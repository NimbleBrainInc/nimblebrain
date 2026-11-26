/** Each label is drawn in its tone, and its text is always shown. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunLabel } from "../types.ts";
import { type LabelTone, labelTone, RunBadge } from "./RunBadge.tsx";

describe("labelTone", () => {
  test.each([
    ["Succeeded", "success"],
    ["Poor result", "danger"],
    ["Needs review", "warning"],
    ["Failed", "danger"],
    ["Skipped", "muted"],
    ["Cancelled", "muted"],
    ["Queued", "muted"],
    ["Running", "active"],
  ] as Array<[RunLabel, LabelTone]>)("%s reads as %s", (label, tone) => {
    expect(labelTone(label)).toBe(tone);
  });
  test("an unknown label is muted", () => {
    expect(labelTone("Something new")).toBe("muted");
  });
});

describe("RunBadge", () => {
  test("renders the plain outcome and its icon, apart, in its tone, with the label on hover", () => {
    const html = renderToStaticMarkup(createElement(RunBadge, { label: "Needs review" }));
    expect(html).toMatch(
      /^<span class="status-badge tone-warning" title="Needs review"><svg[^>]*class="status-icon"[\s\S]*<\/svg><span>Needs you<\/span><\/span>$/,
    );
  });
  test("a poor result and a failure both read as didn't work", () => {
    for (const label of ["Poor result", "Failed"] as const) {
      const html = renderToStaticMarkup(createElement(RunBadge, { label }));
      expect(html).toContain("tone-danger");
      expect(html).toContain("Didn&#x27;t work");
    }
  });
  test("exact shows the label itself", () => {
    const html = renderToStaticMarkup(
      createElement(RunBadge, { label: "Poor result", exact: true }),
    );
    expect(html).toContain("<span>Poor result</span>");
    expect(html).not.toContain("title=");
  });
  test("renders nothing without a label", () => {
    expect(renderToStaticMarkup(createElement(RunBadge, {}))).toBe("");
  });
});
