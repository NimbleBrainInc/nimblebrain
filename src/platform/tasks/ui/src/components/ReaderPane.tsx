import { useEffect, useState } from "react";
import { BackArrowIcon } from "../icons.tsx";
import { renderMarkdown } from "../markdown.ts";
import type {
  RunAssessment,
  RunFileRef,
  RunToolCall,
  TaskRun,
  TaskRunResult,
  TaskSummary,
} from "../types.ts";
import { useTool } from "../useTool.ts";
import { formatDuration, formatTokens, relativeTime, statusDotClass } from "../utils.ts";
import { RunBadge } from "./RunBadge.tsx";

const STATUS_LABEL: Record<string, string> = {
  success: "Run succeeded",
  degraded: "Run finished with errors",
  failure: "Run failed",
  timeout: "Run timed out",
  running: "Running…",
  cancelled: "Run cancelled",
  skipped: "Run skipped",
};

// Statuses for which no result sidecar exists yet, so we never try to fetch one.
const NON_TERMINAL_STATUSES = new Set(["running", "skipped"]);

export function ReaderPane({
  run: listedRun,
  task,
  onRerun,
  onOpenConfig,
  onBack,
}: {
  run: TaskRun | null;
  /** The parent task for this run, if it still exists. */
  task: TaskSummary | undefined;
  /** Trigger a fresh run of the parent task. */
  onRerun: (name: string) => void;
  /** Open the task's config view. */
  onOpenConfig: (name: string) => void;
  /** Return to the rail (used at narrow widths where rail and reader stack). */
  onBack?: () => void;
}) {
  const runResultTool = useTool<TaskRunResult>("run_result");
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<TaskRunResult | null>(null);
  // The run as `assess` last returned it, while the same run stays selected.
  const [assessed, setAssessed] = useState<TaskRun | null>(null);
  const run = assessed && assessed.id === listedRun?.id ? assessed : listedRun;

  const taskName = task?.name || run?.taskId || "unknown";

  // Fetch the full run result (deliverable + activity log + output files) for a
  // terminal run. The run-list summary only carries a truncated preview; the
  // sidecar holds the whole thing. Best-effort: a missing sidecar (legacy run,
  // deleted task) just leaves us with the preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runResultTool.call is stable; re-fetch only when the selected run or its task changes
  useEffect(() => {
    setResult(null);
    if (!listedRun || NON_TERMINAL_STATUSES.has(listedRun.status)) return;
    if (!task) return; // orphaned run — no task to resolve by name
    const runId = listedRun.id;
    let cancelled = false;
    runResultTool
      .call({ name: taskName, runId })
      .then((res) => {
        if (!cancelled) setResult((res.data as TaskRunResult) ?? null);
      })
      .catch(() => {
        // No sidecar (legacy/partial run) — fall back to the summary preview.
      });
    return () => {
      cancelled = true;
    };
  }, [listedRun, task, taskName]);

  if (!run) {
    return <ReaderEmpty />;
  }

  const orphan = !task;
  // Prefer the full deliverable from the result sidecar; fall back to the
  // truncated summary preview while it loads or when no sidecar exists.
  const output = result?.output ?? run.resultPreview ?? "";
  const activityLog = result?.activityLog ?? [];
  const outputFiles = result?.outputFiles ?? [];

  async function handleCopy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable in some contexts; silent
    }
  }

  return (
    <div className="reader">
      <ReaderHead
        run={run}
        taskName={taskName}
        orphan={orphan}
        output={output}
        copied={copied}
        onBack={onBack}
        onOpenConfig={onOpenConfig}
        onRerun={onRerun}
        onCopy={handleCopy}
      />

      <div className="reader-body">
        <ReaderContent run={run} output={output} />
        <ReaderAssessment
          run={run}
          taskName={orphan ? undefined : taskName}
          onAssessed={setAssessed}
        />
        <ReaderFiles files={outputFiles} />
        <ReaderActivity log={activityLog} />
        <ReaderFooter run={run} />
      </div>
    </div>
  );
}

/** Placeholder shown in the reader when no run is selected. */
function ReaderEmpty() {
  return (
    <div className="reader">
      <div className="reader-empty">
        <div className="reader-empty-title">No run selected</div>
        <div className="reader-empty-desc">
          Pick a run from the list to read its output, or create a task to get one going.
        </div>
      </div>
    </div>
  );
}

/** Header row: status dot, task name, run metadata, and copy/re-run actions. */
function ReaderHead({
  run,
  taskName,
  orphan,
  output,
  copied,
  onBack,
  onOpenConfig,
  onRerun,
  onCopy,
}: {
  run: TaskRun;
  taskName: string;
  orphan: boolean;
  output: string;
  copied: boolean;
  onBack?: () => void;
  onOpenConfig: (name: string) => void;
  onRerun: (name: string) => void;
  onCopy: () => void;
}) {
  const dotClass = statusDotClass(run.status, true);
  const statusLabel = STATUS_LABEL[run.status] || run.status;
  return (
    <div className="reader-head">
      {onBack && (
        <button type="button" className="reader-back" onClick={onBack} aria-label="Back to list">
          <BackArrowIcon />
        </button>
      )}
      <div className="reader-head-meta">
        <div className="reader-head-title">
          <span className={`dot ${dotClass}`} />
          <button
            type="button"
            className="reader-head-name"
            onClick={() => !orphan && onOpenConfig(taskName)}
            disabled={orphan}
            title={orphan ? "Task has been deleted" : "Open config"}
          >
            {taskName}
          </button>
          <span className="reader-head-sep">·</span>
          <span className="reader-head-status">{statusLabel}</span>
          <RunBadge label={run.label} />
          {orphan && <span className="reader-head-tag">deleted</span>}
        </div>
        <ReaderHeadSub run={run} />
      </div>
      <div className="reader-actions">
        {output && (
          <button type="button" className="btn" onClick={onCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        {!orphan && (
          <button type="button" className="btn btn-accent" onClick={() => onRerun(taskName)}>
            Re-run
          </button>
        )}
      </div>
    </div>
  );
}

/** Sub-line of run facts: start time, duration, token counts, tool calls, relative age. */
function ReaderHeadSub({ run }: { run: TaskRun }) {
  return (
    <div className="reader-head-sub">
      {new Date(run.startedAt).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}
      <span className="reader-head-dot">·</span>
      {formatDuration(run.startedAt, run.completedAt)}
      <span className="reader-head-dot">·</span>
      {formatTokens(run.inputTokens)} in / {formatTokens(run.outputTokens)} out
      {(run.toolCalls ?? 0) > 0 && (
        <>
          <span className="reader-head-dot">·</span>
          {run.toolCalls} tool {run.toolCalls === 1 ? "call" : "calls"}
        </>
      )}
      <span className="reader-head-dot">·</span>
      {relativeTime(run.startedAt)}
    </div>
  );
}

/** Sanitized markdown deliverable rendered into the reader body. */
function OutputMarkdown({ markdown }: { markdown: string }) {
  return (
    <div
      className="out-md"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify in renderMarkdown
      dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }}
    />
  );
}

/** Main body content: error block, rendered output, or an in-progress/empty note. */
function ReaderContent({ run, output }: { run: TaskRun; output: string }) {
  if (run.error) {
    return (
      <div className="reader-error">
        <div className="reader-error-label">Error</div>
        <pre className="reader-error-body">{run.error}</pre>
        {output && (
          <>
            <div className="reader-error-label" style={{ marginTop: 14 }}>
              {run.status === "degraded" ? "Output" : "Output before failure"}
            </div>
            <OutputMarkdown markdown={output} />
          </>
        )}
      </div>
    );
  }
  if (output) {
    return <OutputMarkdown markdown={output} />;
  }
  if (run.status === "running") {
    return <div className="reader-empty-desc">This run is still in progress.</div>;
  }
  return <div className="reader-empty-desc">No output captured for this run.</div>;
}

/** How one criterion reads: its decided pass/fail, and the judge's answer and confidence. */
function CriterionLine({ c }: { c: NonNullable<RunAssessment["criteria"]>[number] }) {
  return (
    <li className="reader-assessment-item">
      <span className={`reader-assessment-mark ${c.passed ? "pass" : "fail"}`}>
        {c.passed ? "✓" : "✗"}
      </span>
      <span className="reader-assessment-body">
        <span>{c.id}</span>
        <span className="reader-assessment-meta">
          {" "}
          · {String(c.answer)} · confidence {c.confidence.toFixed(2)}
        </span>
        {c.rationale && <div className="reader-assessment-meta">{c.rationale}</div>}
      </span>
    </li>
  );
}

const VERDICT_TEXT: Record<RunAssessment["verdict"], string> = {
  pass: "Passed",
  fail: "Failed",
  uncertain: "Uncertain",
  not_assessed: "Not assessed",
};

/**
 * The run's assessment: the judge's verdict per criterion, the schema check,
 * and the person's verdict, with Accept and Reject to set it. Renders nothing
 * for a run with no assessment.
 */
function ReaderAssessment({
  run,
  taskName,
  onAssessed,
}: {
  run: TaskRun;
  /** Absent for a run whose task was deleted: no verdict can be set. */
  taskName?: string;
  onAssessed: (run: TaskRun) => void;
}) {
  const assessTool = useTool<{ run: TaskRun }>("assess");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = run.assessment;
  if (!a) return null;

  async function setVerdict(verdict: "pass" | "fail") {
    setBusy(true);
    setError(null);
    try {
      const res = await assessTool.call({ runId: run.id, name: taskName, verdict });
      if (res.data?.run) onAssessed(res.data.run);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reader-assessment">
      <div className="reader-section-label">
        Assessment · {VERDICT_TEXT[a.verdict]}
        {a.judge ? ` · judged by ${a.judge.version ?? a.judge.id}` : ""}
      </div>
      {a.reason && <div className="reader-assessment-note">{a.reason}</div>}
      {a.schema && (
        <div className="reader-assessment-note">
          Output schema:{" "}
          {a.schema.valid ? "matches" : `does not match (${(a.schema.errors ?? []).join("; ")})`}
        </div>
      )}
      {a.criteria && a.criteria.length > 0 && (
        <ul className="reader-assessment-list">
          {a.criteria.map((c) => (
            <CriterionLine key={c.id} c={c} />
          ))}
        </ul>
      )}
      {a.human && (
        <div className="reader-assessment-note">
          Your verdict: {a.human.verdict === "pass" ? "accepted" : "rejected"}
          {a.human.note ? ` — ${a.human.note}` : ""}
        </div>
      )}
      {taskName && (
        <div className="reader-assessment-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => setVerdict("pass")}>
            Accept
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => setVerdict("fail")}>
            Reject
          </button>
          {error && <span className="reader-assessment-meta">{error}</span>}
        </div>
      )}
    </div>
  );
}

/** List of files the run produced; renders nothing when there are none. */
function ReaderFiles({ files }: { files: RunFileRef[] }) {
  if (files.length === 0) return null;
  return (
    <div className="reader-files">
      <div className="reader-section-label">Files produced</div>
      <ul className="reader-file-list">
        {files.map((f) => (
          <li key={f.id} className="reader-file">
            {f.filename}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Collapsible activity log of the run's tool calls; renders nothing when empty. */
function ReaderActivity({ log }: { log: RunToolCall[] }) {
  if (log.length === 0) return null;
  return (
    <details className="reader-activity">
      <summary className="reader-section-label">
        Activity log ({log.length} tool {log.length === 1 ? "call" : "calls"})
      </summary>
      <ul className="reader-activity-list">
        {log.map((tc) => (
          <li key={tc.id} className="reader-activity-item">
            <span className={`dot ${tc.ok ? "dot-success" : "dot-failure"}`} />
            <span className="reader-activity-name">{tc.name}</span>
            <span className="reader-activity-ms">{tc.ms}ms</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Footer strip of raw run metrics (iterations, tool calls, stop reason, run id). */
function ReaderFooter({ run }: { run: TaskRun }) {
  return (
    <div className="reader-footer-meta">
      <span>Iterations: {run.iterations ?? "-"}</span>
      <span>Tool calls: {run.toolCalls ?? "-"}</span>
      {run.stopReason && <span>Stop: {run.stopReason}</span>}
      <span>Run id: {run.id}</span>
    </div>
  );
}
