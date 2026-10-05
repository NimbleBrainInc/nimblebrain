import { useId, useState } from "react";
import type { CriterionResult, RunAssessment, TaskCriterion } from "../types.ts";

const VERDICT_TEXT: Record<RunAssessment["verdict"], string> = {
  pass: "Passed",
  fail: "Failed",
  uncertain: "Uncertain",
  not_assessed: "Not assessed",
};

/** How a criterion's answer reads for its type: yes/no, the level, or the option. */
export function answerText(answer: boolean | number | string, criterion?: TaskCriterion): string {
  if (typeof answer === "boolean") return answer ? "Yes" : "No";
  if (typeof answer === "number" && criterion?.type === "score" && criterion.levels) {
    return criterion.levels[answer] ?? String(answer);
  }
  return String(answer);
}

/** One judged criterion: its rule, the answer, pass or fail, confidence, and why. */
function CriterionLine({ c, def }: { c: CriterionResult; def?: TaskCriterion }) {
  return (
    <li className="criterion-result">
      <span
        className={`mark ${c.passed ? "pass" : "fail"}`}
        role="img"
        aria-label={c.passed ? "Pass" : "Fail"}
      >
        {c.passed ? "✓" : "✗"}
      </span>
      <div className="criterion-body">
        <div className="criterion-rule">{def?.rule ?? c.id}</div>
        <div className="criterion-meta">
          <span>Answer: {answerText(c.answer, def)}</span>
          <span>Confidence {Math.round(c.confidence * 100)}%</span>
          {def && <span className="muted-text">{c.id}</span>}
        </div>
        {c.rationale && <div className="criterion-why">{c.rationale}</div>}
      </div>
    </li>
  );
}

/** Who judged it, and whether the judge saw all of it. */
function judgeLine(a: RunAssessment): string | null {
  if (!a.judge) return null;
  const version = a.judge.version ? ` ${a.judge.version}` : "";
  const calibrated = a.judge.calibrated ? "" : " (uncalibrated)";
  const truncated = a.stateTruncated ? " · the judge saw a shortened deliverable" : "";
  return `Judged by ${a.judge.server} · ${a.judge.id}${version}${calibrated}${truncated}`;
}

/** Accept or Reject with a note, and Re-judge. */
function VerdictForm({
  busy,
  error,
  onVerdict,
  onRejudge,
}: {
  busy: boolean;
  error: string | null;
  onVerdict: (verdict: "pass" | "fail", note: string) => void;
  onRejudge: () => void;
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
        <button type="button" className="btn" disabled={busy} onClick={onRejudge}>
          Re-judge
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

/** The schema check's line. */
function SchemaLine({ schema }: { schema: NonNullable<RunAssessment["schema"]> }) {
  return (
    <p className={schema.valid ? "muted-text" : "assess-reason"}>
      Output schema:{" "}
      {schema.valid ? "matches" : `does not match: ${(schema.errors ?? []).join("; ")}`}
    </p>
  );
}

/** What was judged: the reason, the schema check, each criterion, the judge, a person's verdict. */
function AssessmentDetail({ a, criteria }: { a: RunAssessment; criteria?: TaskCriterion[] }) {
  const byId = new Map((criteria ?? []).map((c) => [c.id, c]));
  const judged = judgeLine(a);
  return (
    <>
      {a.reason && (
        <p className="assess-reason">
          {a.reason.message} <span className="muted-text">({a.reason.code})</span>
        </p>
      )}
      {a.schema && <SchemaLine schema={a.schema} />}
      {a.criteria && a.criteria.length > 0 && (
        <ul className="criteria-results">
          {a.criteria.map((c) => (
            <CriterionLine key={c.id} c={c} def={byId.get(c.id)} />
          ))}
        </ul>
      )}
      {judged && <p className="muted-text">{judged}</p>}
      {a.human && (
        <p className="human-verdict">
          {a.human.verdict === "pass" ? "Accepted" : "Rejected"} by a person
          {a.human.note ? `: “${a.human.note}”` : ""}
        </p>
      )}
    </>
  );
}

/**
 * Whether the run's deliverable is good: each criterion with its rule, the
 * judge's answer, pass or fail, confidence and rationale; the schema check;
 * why it is uncertain or not assessed; and a person's verdict with a note.
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
  const headId = useId();
  return (
    <section className="result-section" aria-labelledby={headId}>
      <h3 className="result-h" id={headId}>
        Assessment
        {a && <span className={`verdict verdict-${a.verdict}`}>{VERDICT_TEXT[a.verdict]}</span>}
      </h3>
      {a ? (
        <AssessmentDetail a={a} criteria={criteria} />
      ) : (
        <p className="muted-text">
          Not assessed yet. A run is assessed after it ends when its task has criteria or an output
          schema.
        </p>
      )}
      {canAct && (
        <VerdictForm busy={busy} error={error} onVerdict={onVerdict} onRejudge={onRejudge} />
      )}
    </section>
  );
}
