import { describe, expect, it } from "bun:test";
import {
  formatDateLabel,
  formatDuration,
  formatShortDate,
  formatTokens,
  formatUsd,
  stripServerPrefix,
} from "../src/lib/format";

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

describe("formatUsd", () => {
  it("formats sub-penny values as cents with ¢ symbol", () => {
    expect(formatUsd(0.005)).toBe("0.50¢");
    expect(formatUsd(0.001)).toBe("0.10¢");
    expect(formatUsd(0.0099)).toBe("0.99¢");
  });

  it("formats dollar values with two decimal places", () => {
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.02)).toBe("$0.02");
    expect(formatUsd(42.08)).toBe("$42.08");
    expect(formatUsd(12.456)).toBe("$12.46");
  });

  it("formats zero as $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("formatTokens", () => {
  it("formats millions", () => {
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });

  it("formats thousands", () => {
    expect(formatTokens(512_000)).toBe("512K");
    expect(formatTokens(1_000)).toBe("1K");
  });

  it("formats small numbers as-is", () => {
    expect(formatTokens(453)).toBe("453");
    expect(formatTokens(0)).toBe("0");
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
