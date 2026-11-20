import { StatusIcon } from "../icons.tsx";
import { outcomeOf } from "../lib/outcome.ts";
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
export function StatusBadge({
  tone,
  label,
  title,
}: {
  tone: LabelTone;
  label: string;
  /** The precise word behind a plain one, shown on hover. */
  title?: string;
}) {
  return (
    <span className={`status-badge tone-${tone}`} title={title}>
      <StatusIcon tone={tone} />
      <span>{label}</span>
    </span>
  );
}

/**
 * A run's outcome as a badge: the plain word (Done, Needs you, Didn't work)
 * with the runtime's label on hover, or the label itself with `exact`, where
 * the distinction is the point (a batch's results). Nothing for a record that
 * carries no label.
 */
export function RunBadge({ label, exact = false }: { label?: RunLabel; exact?: boolean }) {
  if (!label) return null;
  if (exact) return <StatusBadge tone={labelTone(label)} label={label} />;
  const plain = outcomeOf(label);
  return (
    <StatusBadge
      tone={plain.tone}
      label={plain.word}
      title={plain.word === label ? undefined : label}
    />
  );
}
