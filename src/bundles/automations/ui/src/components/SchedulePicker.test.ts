/**
 * The picker must never emit a schedule that differs from the one it was given
 * unless the user changed it.
 *
 * `daily` and `weekly` render a single `HH:MM`, so they can represent only an
 * expression whose minute and hour name one moment. Two things have to hold for
 * that to be safe: `detectMode` must not route anything else into those modes,
 * and `parseTime` must not seed the time input with a value they cannot hold —
 * the seed runs for every spec, including one displayed in `cron` mode, and
 * `emit` reads it the moment the user touches a Daily/Weekly control.
 *
 * Both failure shapes are covered below. The quiet one matters most: a cron
 * that becomes a different valid cron passes every downstream check.
 */

import { describe, expect, test } from "bun:test";
import { cronFor, detectMode, parseDow, parseTime, type ScheduleSpec } from "./SchedulePicker.tsx";

function cron(expression: string): ScheduleSpec {
  return { type: "cron", expression };
}

/** What the picker shows for a spec, then emits back if the user changes nothing. */
function roundTrip(spec: ScheduleSpec): string {
  const mode = detectMode(spec);
  if (mode === "daily" || mode === "weekly") {
    return cronFor(mode, parseTime(spec), parseDow(spec));
  }
  return spec.expression ?? "";
}

/**
 * What the picker emits when the user switches a cron-mode spec to Daily or
 * Weekly. The seeded `time` is what `emit` reads, so this is the second exit
 * from the same input and it is reachable by focusing the control.
 */
function switchTo(mode: "daily" | "weekly", spec: ScheduleSpec): string {
  return cronFor(mode, parseTime(spec), parseDow(spec));
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
    // The quiet half: valid cron in, valid cron out, different meaning. Nothing
    // downstream errors on this, so only an explicit assertion catches it.
    expect(roundTrip(cron("* * * * *"))).not.toBe("0 8 * * *");
  });
});

describe("switching a cron-mode schedule to a structured mode", () => {
  // Classification alone is not enough: `parseTime` seeds the time input for
  // every spec, so an unrepresentable field reaches `emit` through state even
  // when the expression is displayed in `cron` mode.
  test.each([
    "0 12,17 * * 1-5",
    "*/15 * * * *",
    "0 9-17 * * *",
    "15,45 * * * *",
    "* * * * *",
  ])("produces a valid expression from %s", (expression) => {
    for (const mode of ["daily", "weekly"] as const) {
      const out = switchTo(mode, cron(expression));
      expect(out, `${mode} from ${expression}`).not.toContain("NaN");
      expect(out, `${mode} from ${expression}`).toMatch(/^\d+ \d+ \* \* \S+$/);
    }
  });

  test("an out-of-range field is not a moment either", () => {
    // `namesOneMoment` bounds the value, so `25` cannot seed an hour the input
    // would reject; the seed falls back to the default instead.
    expect(parseTime(cron("0 25 * * *"))).toBe("08:00");
    expect(detectMode(cron("0 25 * * *"))).toBe("cron");
  });
});
