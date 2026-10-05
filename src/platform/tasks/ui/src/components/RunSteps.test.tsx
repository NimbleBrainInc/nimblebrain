/** A run's tool calls as steps a person reads. */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunToolCall } from "../types.ts";
import { Elapsed, RunSteps, stepDuration, stepTitle } from "./RunSteps.tsx";

afterEach(() => setSystemTime());

describe("stepTitle", () => {
  test.each([
    ["hubspot__search_deals", { action: "Search deals", source: "hubspot" }],
    ["my_gmail__send-message", { action: "Send message", source: "my_gmail" }],
    ["web_fetch", { action: "Web fetch" }],
    ["files__read", { action: "Read", source: "files" }],
  ])("%s", (name, expected) => {
    expect(stepTitle(name)).toEqual(expected);
  });
});

describe("stepDuration", () => {
  test("ms, seconds, minutes", () => {
    expect(stepDuration(340)).toBe("340 ms");
    expect(stepDuration(2400)).toBe("2.4 s");
    expect(stepDuration(65_000)).toBe("1m 05s");
  });
});

const call = (i: number, ok = true): RunToolCall => ({
  id: `t${i}`,
  name: "crm__find_contact",
  input: { q: i },
  output: `out ${i}`,
  ok,
  ms: 100 * (i + 1),
});

describe("RunSteps", () => {
  test("each step reads in words with its time, its payload folded under Show details", () => {
    const html = renderToStaticMarkup(createElement(RunSteps, { log: [call(0), call(1, false)] }));
    expect(html).toContain("Find contact");
    expect(html).toContain(" in crm");
    expect(html).toContain("2 steps, 1 failed");
    expect(html).toContain("step tone-danger");
    expect(html).toContain('<details class="step-details"><summary>Show details</summary>');
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain("<code>crm__find_contact</code>");
  });
  test("a long run shows its first steps and offers the rest", () => {
    const html = renderToStaticMarkup(
      createElement(RunSteps, { log: Array.from({ length: 12 }, (_, i) => call(i)) }),
    );
    expect(html.match(/class="step tone-/g)).toHaveLength(8);
    expect(html).toContain("Show all 12 steps");
  });
  test("no tool calls, no section", () => {
    expect(renderToStaticMarkup(createElement(RunSteps, { log: [] }))).toBe("");
  });
});

describe("Elapsed", () => {
  test("the time since an open run started", () => {
    setSystemTime(new Date("2026-10-04T12:01:12Z"));
    expect(renderToStaticMarkup(createElement(Elapsed, { since: "2026-10-04T12:00:00Z" }))).toBe(
      '<span class="num">1m 12s</span>',
    );
  });
});
