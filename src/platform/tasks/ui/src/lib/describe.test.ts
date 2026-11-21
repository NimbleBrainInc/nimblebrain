import { describe, expect, test } from "bun:test";
import { describeMessage, stripLabel } from "./describe.ts";

describe("the describe box's message", () => {
  test("carries the viewer's timezone, so the agent need not ask", () => {
    expect(describeMessage("Every weekday at 9am, plan my day", "Pacific/Honolulu")).toBe(
      "Set up a scheduled task: Every weekday at 9am, plan my day\n\nMy timezone is Pacific/Honolulu. Ask me anything you need to know, then show me what you set up.",
    );
  });
  test("says nothing of a timezone the browser cannot report", () => {
    const message = describeMessage("Every Friday at 4pm, recap the week", undefined);
    expect(message).not.toContain("timezone");
    expect(message).toEndWith(
      "\n\nAsk me anything you need to know, then show me what you set up.",
    );
  });
});

describe("the strip's label", () => {
  test("one run reads in the singular", () => {
    expect(stripLabel(["Done"])).toBe("Last run: Done");
  });
  test("several runs are counted", () => {
    expect(stripLabel(["Done", "Didn't work"])).toBe("Last 2 runs: Done, Didn't work");
  });
  test("no runs says so", () => {
    expect(stripLabel([])).toBe("No runs yet");
  });
});
