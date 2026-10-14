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
  test("renders the icon and the label text, apart, in its tone", () => {
    const html = renderToStaticMarkup(createElement(RunBadge, { label: "Needs review" }));
    expect(html).toMatch(
      /^<span class="status-badge tone-warning"><svg[^>]*class="status-icon"[\s\S]*<\/svg><span>Needs review<\/span><\/span>$/,
    );
  });
  test("renders nothing without a label", () => {
    expect(renderToStaticMarkup(createElement(RunBadge, {}))).toBe("");
  });
});
