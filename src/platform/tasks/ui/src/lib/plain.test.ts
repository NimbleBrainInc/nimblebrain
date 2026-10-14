/** Plain words for reason codes, the one run-time format, and a run's input in a few words. */
import { describe, expect, test } from "bun:test";
import { assessmentReasonText, inputSummary, runTime } from "./plain.ts";

describe("assessmentReasonText", () => {
  test("each known code reads as a sentence with a next step, never the code", () => {
    for (const code of [
      "no_judge",
      "judge_ambiguous",
      "judge_not_found",
      "upstream_timeout",
      "judge_unavailable",
      "judge_error",
      "schema_invalid",
      "nothing_to_check",
      "no_result",
      "owner_not_member",
    ]) {
      const text = assessmentReasonText(code);
      expect(text).not.toContain(code);
      expect(text).toMatch(/[.]$/);
    }
    expect(assessmentReasonText("no_judge")).toContain("Connect a judge in Connectors");
    expect(assessmentReasonText("judge_ambiguous")).toContain("Name the one");
    expect(assessmentReasonText("something_new")).toBe(
      "The judge couldn't answer. Re-judge to try again.",
    );
  });
});

describe("runTime", () => {
  const now = new Date("2026-10-04T18:00:00").getTime();
  test("today and yesterday in words, else a date", () => {
    expect(runTime(new Date("2026-10-04T16:08:00").toISOString(), now)).toMatch(/^Today 4:08\sPM$/);
    expect(runTime(new Date("2026-10-03T09:15:00").toISOString(), now)).toMatch(
      /^Yesterday 9:15\sAM$/,
    );
    expect(runTime(new Date("2026-09-28T16:08:00").toISOString(), now)).toMatch(/Sep 28.*4:08\sPM/);
  });
});

describe("inputSummary", () => {
  const schema = { type: "object", required: ["company"], properties: {} };
  test("the first required field's value, else the first text value", () => {
    expect(inputSummary({ notes: "x", company: "Acme Logistics" }, schema)).toBe("Acme Logistics");
    expect(inputSummary({ seats: 3, city: "Hilo" })).toBe("Hilo");
  });
  test("cut to a short line; nothing for no input", () => {
    expect(inputSummary({ q: "a".repeat(80) })?.length).toBe(48);
    expect(inputSummary(undefined)).toBeUndefined();
    expect(inputSummary({ n: 1 })).toBeUndefined();
    expect(inputSummary([1, 2])).toBe("2 items");
  });
});
