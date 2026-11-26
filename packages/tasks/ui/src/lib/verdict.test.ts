import { describe, expect, test } from "bun:test";
import type { RunAssessment } from "../types.ts";
import { effectiveVerdict } from "./verdict.ts";

describe("effectiveVerdict", () => {
  test("a known verdict reads as words; nothing without an assessment", () => {
    const base: RunAssessment = { verdict: "pass" };
    expect(effectiveVerdict(base)).toEqual({ word: "Passed", tone: "success" });
    expect(effectiveVerdict({ verdict: "fail" })?.word).toBe("Failed");
    expect(effectiveVerdict({ verdict: "not_assessed" })?.tone).toBe("muted");
    expect(effectiveVerdict(undefined)).toBeUndefined();
  });
  test("an unknown verdict is shown verbatim and decides nothing", () => {
    expect(effectiveVerdict({ verdict: "graded" })).toEqual({ word: "graded", tone: "muted" });
  });
});
