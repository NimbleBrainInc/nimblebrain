import { StatusIcon } from "../icons.tsx";
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

/**
 * A status as one badge everywhere: its icon and its word, side by side with
 * a gap, in its tone. The same size in rows, on pages, and in headers.
 */
export function StatusBadge({ tone, label }: { tone: LabelTone; label: string }) {
  return (
    <span className={`status-badge tone-${tone}`}>
      <StatusIcon tone={tone} />
      <span>{label}</span>
    </span>
  );
}

/** The run's derived label as a badge; nothing for a record that carries none. */
export function RunBadge({ label }: { label?: RunLabel }) {
  if (!label) return null;
  return <StatusBadge tone={labelTone(label)} label={label} />;
}
