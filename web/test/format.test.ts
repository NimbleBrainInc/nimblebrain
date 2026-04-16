import { describe, expect, it } from "bun:test";
import { formatDuration, stripServerPrefix } from "../src/lib/format";

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
