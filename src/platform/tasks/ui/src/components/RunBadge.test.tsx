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
  test("renders the label text in its tone", () => {
    expect(renderToStaticMarkup(createElement(RunBadge, { label: "Needs review" }))).toBe(
      '<span class="run-badge run-badge-warning">Needs review</span>',
    );
  });
  test("renders nothing without a label", () => {
    expect(renderToStaticMarkup(createElement(RunBadge, {}))).toBe("");
  });
});
