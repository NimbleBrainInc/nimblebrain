/**
 * The verdict a run reads as: a person's when one was set, else the judge's.
 * One helper for the Verdict tile, the Assessment header, rows and labels, so
 * none of them disagrees with another.
 */
import type { RunAssessment } from "../types.ts";

export type VerdictTone = "success" | "danger" | "warning" | "muted";

const JUDGE: Record<RunAssessment["verdict"], { word: string; tone: VerdictTone }> = {
  pass: { word: "Passed", tone: "success" },
  fail: { word: "Failed", tone: "danger" },
  uncertain: { word: "Uncertain", tone: "warning" },
  not_assessed: { word: "Not assessed", tone: "muted" },
};

export interface EffectiveVerdict {
  word: string;
  tone: VerdictTone;
  /** Set when a person decided: what the judge said, as a secondary line. */
  judge?: string;
  /** Whether a person set it. */
  byPerson: boolean;
}

/** The verdict to show for an assessment; undefined when the run has none. */
export function effectiveVerdict(a: RunAssessment | undefined): EffectiveVerdict | undefined {
  if (!a) return undefined;
  const judge = JUDGE[a.verdict];
  if (a.human) {
    const accepted = a.human.verdict === "pass";
    return {
      word: accepted ? "Accepted by you" : "Rejected by you",
      tone: accepted ? "success" : "danger",
      judge: `The judge said ${judge.word.toLowerCase()}`,
      byPerson: true,
    };
  }
  return { word: judge.word, tone: judge.tone, byPerson: false };
}
