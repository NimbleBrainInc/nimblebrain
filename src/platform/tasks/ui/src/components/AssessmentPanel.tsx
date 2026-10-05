import { useId, useState } from "react";
import { assessmentReasonText } from "../lib/plain.ts";
import type { CriterionResult, RunAssessment, TaskCriterion } from "../types.ts";
import { type LabelTone, StatusBadge } from "./RunBadge.tsx";
import { Section } from "./Section.tsx";

const VERDICT_TEXT: Record<RunAssessment["verdict"], string> = {
  pass: "Passed",
  fail: "Failed",
  uncertain: "Uncertain",
  not_assessed: "Not assessed",
};

const VERDICT_TONE: Record<RunAssessment["verdict"], LabelTone> = {
  pass: "success",
  fail: "danger",
  uncertain: "warning",
  not_assessed: "muted",
};

/** How a criterion's answer reads for its type: yes/no, the level, or the option. */
export function answerText(answer: boolean | number | string, criterion?: TaskCriterion): string {
  if (typeof answer === "boolean") return answer ? "Yes" : "No";
  if (typeof answer === "number" && criterion?.type === "score" && criterion.levels) {
    return criterion.levels[answer] ?? String(answer);
  }
  return String(answer);
}

/** The judged criteria as rows: rule, answer, confidence, pass or fail, and why. */
function CriteriaTable({
  results,
  criteria,
}: {
  results: CriterionResult[];
  criteria?: TaskCriterion[];
}) {
  const byId = new Map((criteria ?? []).map((c) => [c.id, c]));
  return (
    <table className="data-table criteria-table">
      <thead>
        <tr>
          <th scope="col">Rule</th>
          <th scope="col">Answer</th>
          <th scope="col" className="num">
            Confidence
          </th>
          <th scope="col">Result</th>
        </tr>
      </thead>
      <tbody>
        {results.map((c) => {
          const def = byId.get(c.id);
          return (
            <tr key={c.id}>
              <td>
                {def?.rule ?? c.id}
                {c.rationale && <div className="cell-sub">{c.rationale}</div>}
              </td>
              <td>{answerText(c.answer, def)}</td>
              <td className="num">{Math.round(c.confidence * 100)}%</td>
              <td>
                <StatusBadge
                  tone={c.passed ? "success" : "danger"}
                  label={c.passed ? "Pass" : "Fail"}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Who judged it, and whether the judge saw all of it. */
function judgeLine(a: RunAssessment): string | null {
  if (!a.judge) return null;
  const version = a.judge.version ? ` ${a.judge.version}` : "";
  const calibrated = a.judge.calibrated ? "" : " (uncalibrated)";
  const truncated = a.stateTruncated ? " · the judge saw a shortened result" : "";
  return `Judged by ${a.judge.server} · ${a.judge.id}${version}${calibrated}${truncated}`;
}

/** Accept or Reject with a note, the full width of the section. */
function VerdictForm({
  busy,
  error,
  onVerdict,
}: {
  busy: boolean;
  error: string | null;
  onVerdict: (verdict: "pass" | "fail", note: string) => void;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  return (
    <div className="verdict-form">
      <label className="field-label" htmlFor={noteId}>
        Your verdict, and why (optional)
      </label>
      <textarea
        id={noteId}
        className="inline-edit-textarea"
        rows={2}
        maxLength={2000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Cites a source for every claim"
      />
      <div className="verdict-actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => onVerdict("pass", note)}
        >
          Accept
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={() => onVerdict("fail", note)}
        >
          Reject
        </button>
        {error && (
          <span className="field-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Whether the run's result is good, as a section: the verdict in its header
 * with Re-judge, the reason in plain words with the next step, each criterion
 * as a row, a person's verdict, and Accept or Reject with a note.
 */
export function AssessmentPanel({
  assessment: a,
  criteria,
  canAct,
  busy,
  error,
  onVerdict,
  onRejudge,
}: {
  assessment?: RunAssessment;
  /** The task's criteria, for each rule's text. */
  criteria?: TaskCriterion[];
  /** False when the run's task is gone: nothing can be set. */
  canAct: boolean;
  busy: boolean;
  error: string | null;
  onVerdict: (verdict: "pass" | "fail", note: string) => void;
  onRejudge: () => void;
}) {
  const judged = a ? judgeLine(a) : null;
  return (
    <Section
      title="Assessment"
      aside={
        <>
          {a && <StatusBadge tone={VERDICT_TONE[a.verdict]} label={VERDICT_TEXT[a.verdict]} />}
          {canAct && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={onRejudge}>
              Re-judge
            </button>
          )}
        </>
      }
    >
      {!a && (
        <p className="muted">
          Not assessed yet. A run is assessed after it ends when its task has criteria or an output
          schema.
        </p>
      )}
      {a?.reason && <p className="assess-reason">{assessmentReasonText(a.reason.code)}</p>}
      {a?.schema && (
        <p className="muted">
          Output schema:{" "}
          {a.schema.valid ? "matches" : `does not match: ${(a.schema.errors ?? []).join("; ")}`}
        </p>
      )}
      {a?.criteria && a.criteria.length > 0 && (
        <CriteriaTable results={a.criteria} criteria={criteria} />
      )}
      {judged && <p className="muted">{judged}</p>}
      {a?.human && (
        <p className="human-verdict">
          {a.human.verdict === "pass" ? "Accepted" : "Rejected"} by a person
          {a.human.note ? `: “${a.human.note}”` : ""}
        </p>
      )}
      {canAct && <VerdictForm busy={busy} error={error} onVerdict={onVerdict} />}
    </Section>
  );
}
