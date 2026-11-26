import { assessmentReasonText } from "../lib/plain.ts";
import { effectiveVerdict } from "../lib/verdict.ts";
import type { RunAssessment } from "../types.ts";
import { StatusBadge } from "./RunBadge.tsx";
import { Section } from "./Section.tsx";

/**
 * Whether the run's result is good, as a section, read-only: the verdict in
 * its header, the reason in plain words, and the output schema check. The
 * output schema alone assesses a deliverable (pass, fail, not_assessed).
 */
export function AssessmentPanel({ assessment: a }: { assessment?: RunAssessment }) {
  const verdict = effectiveVerdict(a);
  return (
    <Section
      title="Assessment"
      aside={verdict && <StatusBadge tone={verdict.tone} label={verdict.word} />}
    >
      {!a && (
        <p className="muted">
          Not assessed. A run that leaves a result is checked against its task's output schema.
        </p>
      )}
      {a?.reason && <p className="assess-reason">{assessmentReasonText(a.reason.code)}</p>}
      {a?.schema && (
        <p className="muted">
          Output schema:{" "}
          {a.schema.valid ? "matches" : `does not match: ${(a.schema.errors ?? []).join("; ")}`}
        </p>
      )}
    </Section>
  );
}
