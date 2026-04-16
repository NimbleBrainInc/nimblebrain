import { describe, expect, it } from "bun:test";
import { formatCost, formatTokenCount } from "../../src/engine/cost.ts";

describe("formatCost", () => {
  it("formats sub-penny values as cents", () => {
    expect(formatCost(0.005)).toBe("$0.50c");
  });

  it("formats zero as cents", () => {
    expect(formatCost(0)).toBe("$0.00c");
  });

  it("formats dollar values with two decimals", () => {
    expect(formatCost(12.45)).toBe("$12.45");
  });

  it("formats exactly one cent as dollars", () => {
    expect(formatCost(0.01)).toBe("$0.01");
  });
});

describe("formatTokenCount", () => {
  it("formats millions", () => {
    expect(formatTokenCount(2_450_000)).toBe("2.5M");
  });

  it("formats thousands", () => {
    expect(formatTokenCount(512_000)).toBe("512K");
  });

  it("formats small numbers as-is", () => {
    expect(formatTokenCount(999)).toBe("999");
  });

  it("formats exactly 1000 as K", () => {
    expect(formatTokenCount(1_000)).toBe("1K");
  });

  it("formats zero", () => {
    expect(formatTokenCount(0)).toBe("0");
  });
});
