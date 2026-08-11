/**
 * The schedule picker must not silently rewrite a schedule it cannot display.
 *
 * `daily` and `weekly` render a single `HH:MM`, so they can only represent an
 * expression whose minute and hour name one moment. `detectMode` used to decide
 * purely on the day fields, which routed multi-value expressions into those
 * modes and let the round-trip through `parseTime` → `emit` mangle them.
 *
 * Two failure modes, and the quiet one is worse:
 *
 *   - `0 12,17 * * 1-5` → `0 NaN * * 1-5`, which the server rejects. Loud.
 *   - `* * * * *` → `0 8 * * *`. Every minute becomes once a day, valid cron
 *     the whole way, nothing to reject. Nobody finds out.
 *
 * The fix classifies on what a mode can hold, so anything else falls to `cron`
 * and its raw text field round-trips verbatim.
 */

import { describe, expect, test } from "bun:test";
import { detectMode, parseDow, parseTime, type ScheduleSpec } from "./SchedulePicker.tsx";

function cron(expression: string): ScheduleSpec {
  return { type: "cron", expression };
}

/**
 * The cron branches of the component's `emit`, which is inline in the render
 * body and cannot be imported. Kept literal so a change there shows up here as
 * a divergence rather than passing silently.
 */
function roundTrip(spec: ScheduleSpec): string {
  const mode = detectMode(spec);
  const t = parseTime(spec);
  if (mode === "daily") {
    const [h, min] = t.split(":").map(Number);
    return `${min} ${h} * * *`;
  }
  if (mode === "weekly") {
    const [h, min] = t.split(":").map(Number);
    return `${min} ${h} * * ${parseDow(spec)}`;
  }
  return spec.expression ?? "";
}

describe("detectMode", () => {
  test("routes an expression the time input can hold to daily or weekly", () => {
    expect(detectMode(cron("0 9 * * *"))).toBe("daily");
    expect(detectMode(cron("30 8 * * 1"))).toBe("weekly");
    expect(detectMode(cron("0 8 * * 1-5"))).toBe("weekly");
  });

  test.each([
    ["a list of hours", "0 12,17 * * 1-5"],
    ["a step", "*/15 * * * *"],
    ["every minute", "* * * * *"],
    ["a range of hours", "0 9-17 * * *"],
    ["two fixed hours", "0 0,12 * * *"],
    ["a list of minutes", "15,45 * * * *"],
  ])("keeps %s in cron mode", (_label, expression) => {
    expect(detectMode(cron(expression))).toBe("cron");
  });

  test("a day-field range is still weekly — only minute and hour are constrained", () => {
    // `1-5` is multi-value too, but the weekday control is a plain string the
    // expression carries through untouched, so it round-trips. Constraining it
    // would push working schedules into the raw editor for no reason.
    expect(detectMode(cron("0 8 * * 1-5"))).toBe("weekly");
    expect(roundTrip(cron("0 8 * * 1-5"))).toBe("0 8 * * 1-5");
  });
});

describe("round-trip through the picker", () => {
  test.each([
    "0 12,17 * * 1-5",
    "*/15 * * * *",
    "* * * * *",
    "0 9 * * *",
    "30 8 * * 1",
    "0 9-17 * * *",
    "0 0,12 * * *",
    "15,45 * * * *",
    "0 8 * * 1-5",
  ])("preserves %s", (expression) => {
    expect(roundTrip(cron(expression))).toBe(expression);
  });

  test("never emits NaN", () => {
    // The loud half of the bug. Pinned separately because a future change could
    // reintroduce it for a shape not in the list above.
    for (const expression of ["0 12,17 * * 1-5", "*/15 * * * *", "15,45 * * * *"]) {
      expect(roundTrip(cron(expression))).not.toContain("NaN");
    }
  });

  test("never turns a repeating schedule into a single daily one", () => {
    // The quiet half: valid cron in, valid cron out, different meaning. This is
    // the assertion that would have caught it, since nothing downstream errors.
    expect(roundTrip(cron("* * * * *"))).not.toBe("0 8 * * *");
  });
});
