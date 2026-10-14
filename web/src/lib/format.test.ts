import { describe, expect, test } from "bun:test";
import { formatInstant } from "./format";

describe("formatInstant", () => {
  const now = new Date(2026, 9, 3, 15, 0);
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  test("today and yesterday name the day", () => {
    const today = new Date(2026, 9, 3, 7, 53, 51);
    const yesterday = new Date(2026, 9, 2, 22, 46);
    expect(formatInstant(today.toISOString(), now)).toBe(`Today ${time(today)}`);
    expect(formatInstant(yesterday.toISOString(), now)).toBe(`Yesterday ${time(yesterday)}`);
  });

  test("drops seconds", () => {
    expect(formatInstant(new Date(2026, 9, 3, 7, 53, 51).toISOString(), now)).not.toContain(":51");
  });

  test("the year only outside the current one", () => {
    const thisYear = formatInstant(new Date(2026, 8, 30, 22, 46).toISOString(), now);
    const lastYear = formatInstant(new Date(2025, 8, 30, 22, 46).toISOString(), now);
    expect(thisYear).not.toContain("2026");
    expect(lastYear).toContain("2025");
  });

  test("an unparseable value comes back as given", () => {
    expect(formatInstant("not a date", now)).toBe("not a date");
  });
});
