/**
 * A run's outcome in the three words a person acts on: it worked, it needs
 * you, or it didn't work. The one mapping from a run's label to its word:
 * every list, badge, strip and board reads it, so a label reads the same
 * everywhere. The label itself (Succeeded, Poor result, Needs review, ...) is
 * more precise and stays on the run's own page.
 */
import type { RunLabel } from "../types.ts";

export type OutcomeTone = "success" | "warning" | "danger" | "muted" | "active";

export interface Outcome {
  word: string;
  tone: OutcomeTone;
  /** Why, when the label alone says it. */
  reason?: string;
}

const OUTCOME: Record<RunLabel, Outcome> = {
  Succeeded: { word: "Done", tone: "success" },
  "Needs review": { word: "Needs you", tone: "warning" },
  "Poor result": {
    word: "Didn't work",
    tone: "danger",
    reason: "The output didn't match the expected shape.",
  },
  Failed: { word: "Didn't work", tone: "danger" },
  Skipped: { word: "Didn't run", tone: "muted" },
  Cancelled: { word: "Stopped", tone: "muted" },
  Queued: { word: "Waiting", tone: "muted" },
  Running: { word: "Running", tone: "active" },
};

/** The plain outcome of a run label; a label this build does not know reads as itself, muted. */
export function outcomeOf(label: string): Outcome {
  return (OUTCOME as Record<string, Outcome>)[label] ?? { word: label, tone: "muted" };
}
