/**
 * The verdict a run's assessment reads as. In 1.0 of the tasks contract the
 * output schema alone assesses a deliverable (pass, fail, not_assessed);
 * `uncertain` is reserved for judging. A verdict this screen does not know is
 * shown verbatim and decides nothing. One helper for the Verdict tile, the
 * Assessment header, rows and labels, so none of them disagrees with another.
 */
import type { RunAssessment } from "../types.ts";

export type VerdictTone = "success" | "danger" | "warning" | "muted";

const KNOWN: Record<string, { word: string; tone: VerdictTone }> = {
  pass: { word: "Passed", tone: "success" },
  fail: { word: "Failed", tone: "danger" },
  uncertain: { word: "Uncertain", tone: "warning" },
  not_assessed: { word: "Not assessed", tone: "muted" },
};

export interface EffectiveVerdict {
  word: string;
  tone: VerdictTone;
}

/** The verdict to show for an assessment; undefined when the run has none. */
export function effectiveVerdict(a: RunAssessment | undefined): EffectiveVerdict | undefined {
  if (!a) return undefined;
  return KNOWN[a.verdict] ?? { word: a.verdict, tone: "muted" };
}
