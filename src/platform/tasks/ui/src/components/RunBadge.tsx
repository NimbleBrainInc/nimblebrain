import type { RunLabel } from "../types.ts";

export type LabelTone = "success" | "danger" | "warning" | "muted" | "active";

/** The tone each label is drawn in. Colour is never the only signal: the label's text is shown. */
const TONE: Record<RunLabel, LabelTone> = {
  Succeeded: "success",
  "Poor result": "danger",
  "Needs review": "warning",
  Failed: "danger",
  Skipped: "muted",
  Cancelled: "muted",
  Queued: "muted",
  Running: "active",
};

/** The tone a label is drawn in; muted for a label this build does not know. */
export function labelTone(label: string): LabelTone {
  return (TONE as Record<string, LabelTone>)[label] ?? "muted";
}

/** The run's derived label as a small badge; nothing for a record that carries none. */
export function RunBadge({ label }: { label?: RunLabel }) {
  if (!label) return null;
  return <span className={`run-badge run-badge-${labelTone(label)}`}>{label}</span>;
}
