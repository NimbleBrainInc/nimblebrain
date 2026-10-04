import type { RunLabel } from "../types.ts";

/** The class suffix for each label's tone. */
const TONE: Record<RunLabel, string> = {
  Succeeded: "success",
  "Poor result": "danger",
  "Needs review": "warning",
  Failed: "danger",
  Skipped: "muted",
  Cancelled: "muted",
  Queued: "muted",
  Running: "muted",
};

/** The run's derived label as a small badge; nothing for a record that carries none. */
export function RunBadge({ label }: { label?: RunLabel }) {
  if (!label) return null;
  return <span className={`run-badge run-badge-${TONE[label]}`}>{label}</span>;
}
