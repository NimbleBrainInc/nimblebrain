import { describe, expect, it } from "bun:test";
import { formatDateLabel, formatDuration, formatShortDate, stripServerPrefix } from "../src/lib/format";

describe("formatDuration", () => {
  it("renders <1ms for sub-millisecond values that round to 0", () => {
    expect(formatDuration(0.1)).toBe("<1ms");
    expect(formatDuration(0.4)).toBe("<1ms");
    expect(formatDuration(0.499)).toBe("<1ms");
  });

  it("rounds normally for values >= 0.5ms", () => {
    expect(formatDuration(0.5)).toBe("1ms");
    expect(formatDuration(0.9)).toBe("1ms");
    expect(formatDuration(1)).toBe("1ms");
    expect(formatDuration(42.3)).toBe("42ms");
  });

  it("renders exactly 0ms (not <1ms) for a true zero", () => {
    // Engine uses ms: 0 as an explicit error/fallback sentinel. We must not
    // misrepresent that as <1ms.
    expect(formatDuration(0)).toBe("0ms");
  });

  it("renders milliseconds under 1 second", () => {
    expect(formatDuration(340)).toBe("340ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(999.4)).toBe("999ms");
  });

  it("switches to seconds at 1000ms with one decimal", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12345)).toBe("12.3s");
  });
});

describe("stripServerPrefix", () => {
  it("leaves tool names without a prefix untouched", () => {
    expect(stripServerPrefix("read")).toBe("read");
    expect(stripServerPrefix("manage_skill")).toBe("manage_skill");
  });

  it("strips the first __-separated prefix", () => {
    expect(stripServerPrefix("docs__read")).toBe("read");
    expect(stripServerPrefix("server__manage_skill")).toBe("manage_skill");
  });

  it("only strips the first __ boundary (preserves the rest)", () => {
    expect(stripServerPrefix("a__b__c")).toBe("b__c");
  });
});

describe("formatShortDate", () => {
  it("formats UTC date-only string as M/D using UTC day", () => {
    // "2026-04-30" is UTC midnight. In PDT (UTC-7), getDate() returns 29.
    // Correct behavior: always show 4/30.
    expect(formatShortDate("2026-04-30")).toBe("4/30");
  });

  it("formats first of month correctly", () => {
    expect(formatShortDate("2026-01-01")).toBe("1/1");
  });

  it("formats December 31 correctly", () => {
    expect(formatShortDate("2026-12-31")).toBe("12/31");
  });

  it("handles month boundary (UTC date differs from local in west-of-UTC TZ)", () => {
    // "2026-05-01" UTC midnight = April 30 in PDT
    expect(formatShortDate("2026-05-01")).toBe("5/1");
  });
});

describe("formatDateLabel", () => {
  it("preserves UTC date, not local interpretation", () => {
    // "2026-04-30" should always format as April 30, never April 29.
    const result = formatDateLabel("2026-04-30");
    expect(result).toContain("30");
    expect(result).not.toContain("29");
  });

  it("handles year boundary", () => {
    const result = formatDateLabel("2026-01-01");
    expect(result).toContain("1");
    // Should not roll back to December 31
    expect(result).not.toContain("31");
  });
});
