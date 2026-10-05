import { describe, expect, test } from "bun:test";
import type { RunAssessment } from "../types.ts";
import { effectiveVerdict } from "./verdict.ts";

const base: RunAssessment = { verdict: "uncertain", assessedAt: "x" };

describe("effectiveVerdict", () => {
  test("a person's verdict wins, with the judge's state as a secondary line", () => {
    const human = { verdict: "fail" as const, by: "u", via: "ui" as const, at: "x" };
    expect(effectiveVerdict({ ...base, human })).toEqual({
      word: "Rejected by you",
      tone: "danger",
      judge: "The judge said uncertain",
      byPerson: true,
    });
    expect(
      effectiveVerdict({ ...base, verdict: "fail", human: { ...human, verdict: "pass" } }),
    ).toMatchObject({
      word: "Accepted by you",
      tone: "success",
      judge: "The judge said failed",
    });
  });
  test("otherwise the judge's verdict; nothing without an assessment", () => {
    expect(effectiveVerdict(base)).toEqual({ word: "Uncertain", tone: "warning", byPerson: false });
    expect(effectiveVerdict({ ...base, verdict: "pass" })?.word).toBe("Passed");
    expect(effectiveVerdict(undefined)).toBeUndefined();
  });
});
