import { action as hostAction } from "@nimblebrain/synapse";
import { useApp } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useState } from "react";
import { STARTED_BY_TEXT, startedByOf } from "../lib/activity.ts";
import { renderMarkdown } from "../markdown.ts";
import type { RunFileRef, TaskCriterion, TaskDetail, TaskRun, TaskRunResult } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatDuration, formatTokens, formatUsd, toolErrorText } from "../utils.ts";
import { AssessmentPanel } from "./AssessmentPanel.tsx";
import { ScreenHead } from "./Chrome.tsx";
import { RunBadge } from "./RunBadge.tsx";
import { Elapsed, RunSteps } from "./RunSteps.tsx";
import { StructuredValue } from "./StructuredView.tsx";

const EXECUTION_TEXT: Record<string, string> = {
  queued: "Waiting for a run slot",
  running: "Running",
  skipped: "Did not start",
  completed: "Completed",
  incomplete: "Stopped before finishing",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STOP_TEXT: Record<string, string> = {
  complete: "finished",
  max_iterations: "hit its step limit",
  max_input_tokens: "hit its input-token limit",
  spend_limit: "ran out of budget",
  length: "hit the output length limit",
  content_filter: "was stopped by the content filter",
  error: "ended on an error",
  other: "stopped",
};

/** Whether a run has ended (its result can be read), from its record or result. */
export function isOpenRun(run?: Pick<TaskRun, "status" | "label">): boolean {
  return run?.status === "running" || run?.status === "queued" || run?.label === "Running";
}

/** The deliverable: structured output as values or tables, else the text as markdown; files linked. */
export function Deliverable({
  result,
  run,
  onOpenFile,
}: {
  result: TaskRunResult | null;
  run?: TaskRun;
  onOpenFile?: (file: RunFileRef) => void;
}) {
  const output = result?.output ?? run?.resultPreview ?? "";
  const files = result?.outputFiles ?? [];
  return (
    <section className="section deliverable" aria-label="Result">
      {result?.structured !== undefined ? (
        <StructuredValue value={result.structured} />
      ) : output ? (
        <div
          className="out-md"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify in renderMarkdown
          dangerouslySetInnerHTML={{ __html: renderMarkdown(output) }}
        />
      ) : (
        <p className="muted">No deliverable for this run.</p>
      )}
      {!result && run?.resultPreview && (
        <p className="muted">Showing the preview; the full result could not be read.</p>
      )}
      {files.length > 0 && (
        <div className="result-files">
          <h4 className="sub-heading">Files</h4>
          <ul>
            {files.map((f) => (
              <li key={f.id}>
                {onOpenFile ? (
                  <button type="button" className="link-btn" onClick={() => onOpenFile(f)}>
                    {f.filename}
                  </button>
                ) : (
                  f.filename
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** How the run ended: execution, stop reason, error, tools that failed for good. */
export function ExecutionPanel({ run, result }: { run?: TaskRun; result: TaskRunResult | null }) {
  const execution = run?.execution ?? result?.execution;
  const stop = run?.stopReason ?? result?.stopReason;
  if (!execution && !stop && !run?.error) return null;
  return (
    <section className="section" aria-label="How it ran">
      <h3 className="section-heading">How it ran</h3>
      <p>
        {execution ? (EXECUTION_TEXT[execution] ?? execution) : "Ended"}
        {stop && stop !== "complete" ? `: it ${STOP_TEXT[stop] ?? stop}` : ""}
        {run?.spendAccountId?.startsWith("task-batch:") ? " (the batch budget)" : ""}
        {run?.spendAccountId?.startsWith("task-budget:") ? " (the task's token budget)" : ""}.
      </p>
      {run?.error && <pre className="reader-error-body">{run.error}</pre>}
      {run?.unrecoveredToolFailures && run.unrecoveredToolFailures.length > 0 && (
        <p className="assess-reason">
          Tools that failed with no later success: {run.unrecoveredToolFailures.join(", ")}
        </p>
      )}
    </section>
  );
}

/** What the run cost: the run's model calls, the judge, and the tokens. */
export function CostPanel({ run, result }: { run?: TaskRun; result: TaskRunResult | null }) {
  const judgeCost = (run?.assessment ?? result?.assessment)?.usage?.costUsd;
  const inTok = run?.inputTokens ?? result?.usage.inputTokens;
  const outTok = run?.outputTokens ?? result?.usage.outputTokens;
  const steps = run?.iterations ?? result?.usage.iterations;
  return (
    <details className="section details">
      <summary className="section-heading">
        Cost: {formatUsd((run?.costUsd ?? 0) + (judgeCost ?? 0))}
      </summary>
      <dl className="sv-dl">
        <div className="sv-pair">
          <dt>Run</dt>
          <dd>{run?.costUsd !== undefined ? formatUsd(run.costUsd) : "Not recorded"}</dd>
        </div>
        {judgeCost !== undefined && (
          <div className="sv-pair">
            <dt>Judge</dt>
            <dd>{formatUsd(judgeCost)}</dd>
          </div>
        )}
        <div className="sv-pair">
          <dt>Tokens</dt>
          <dd>
            {formatTokens(inTok)} in · {formatTokens(outTok)} out
          </dd>
        </div>
        <div className="sv-pair">
          <dt>Steps</dt>
          <dd>{steps ?? "—"}</dd>
        </div>
      </dl>
    </details>
  );
}

/** The input the run was given, as JSON. */
export function InputPanel({ input }: { input: unknown }) {
  if (input === undefined) return null;
  return (
    <details className="section details">
      <summary className="section-heading">Input</summary>
      <pre className="code-block">{JSON.stringify(input, null, 2)}</pre>
    </details>
  );
}

/** What a run result screen holds once loaded. */
export interface RunResultState {
  status: "loading" | "open" | "ready" | "error";
  run?: TaskRun;
  result: TaskRunResult | null;
  error?: string;
  /** The task's criteria, for rule text. */
  criteria?: TaskCriterion[];
  /** The task's name, once read; absent while unknown. */
  taskName?: string;
  /** True once the task was looked up and is gone. */
  taskGone?: boolean;
}

/** Poll interval while a run is still open. */
const POLL_MS = 3000;

type ToolCall = (args: Record<string, unknown>) => Promise<{ data?: unknown }>;

/** A run's result, or that it is still open, or why it could not be read. */
async function readResult(
  call: ToolCall,
  runId: string,
  name: string | undefined,
): Promise<{ result: TaskRunResult | null; open: boolean; error?: string }> {
  try {
    const res = await call({ runId, ...(name ? { name } : {}) });
    return { result: asDict(res.data) as unknown as TaskRunResult, open: false };
  } catch (err) {
    const text = toolErrorText(err);
    return /still (queued|running)/.test(text)
      ? { result: null, open: true }
      : { result: null, open: false, error: text };
  }
}

/** A run's record from its task's recent runs; `fallback` when it is not among them. */
async function readRecord(
  call: ToolCall,
  taskId: string | undefined,
  runId: string,
  fallback: TaskRun | undefined,
): Promise<TaskRun | undefined> {
  if (!taskId) return fallback;
  try {
    const res = await call({ taskId, limit: 200 });
    const runs = (asDict(res.data).runs as TaskRun[]) ?? [];
    return runs.find((r) => r.id === runId) ?? fallback;
  } catch {
    // the record is optional: the result carries the label and assessment
    return fallback;
  }
}

/** The run's task: its name and criteria (for each rule's text), or that it is gone. */
async function readTask(
  call: ToolCall,
  name: string | undefined,
): Promise<{ taskName?: string; criteria?: TaskCriterion[]; taskGone?: boolean }> {
  if (!name) return {};
  try {
    const res = await call({ name, limit: 1 });
    const task = asDict(res.data).task as TaskDetail | undefined;
    return task ? { taskName: task.name, criteria: task.criteria } : { taskGone: true };
  } catch (err) {
    return /not found/i.test(toolErrorText(err)) ? { taskGone: true } : {};
  }
}

/** What the screen shows from what was read. */
function stateOf(
  read: { result: TaskRunResult | null; open: boolean; error?: string },
  run: TaskRun | undefined,
  task: { taskName?: string; criteria?: TaskCriterion[]; taskGone?: boolean },
): RunResultState {
  const open = read.open || (!!run && isOpenRun(run));
  const status = open ? "open" : read.result || run ? "ready" : "error";
  return { status, run, result: read.result, error: read.error, ...task };
}

/**
 * Load a run's record, result, and its task's criteria; poll while the run
 * is still open. `name` is the task's name or id (the tools take either);
 * the record is read from `taskId`'s runs.
 */
export function useRunResult(
  runId: string,
  name: string | undefined,
  taskId: string | undefined,
  initialRun?: TaskRun,
): RunResultState & { setRun: (run: TaskRun) => void; reload: () => void } {
  const resultTool = useTool<string>("run_result");
  const runsTool = useTool<string>("runs");
  const statusTool = useTool<string>("status");
  const [state, setState] = useState<RunResultState>({
    status: "loading",
    run: initialRun,
    result: null,
  });
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tool calls are stable; reload on run, name, task, or tick
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    void (async () => {
      const [read, run, task] = await Promise.all([
        readResult(resultTool.call, runId, name),
        readRecord(runsTool.call, taskId, runId, initialRun),
        readTask(statusTool.call, name),
      ]);
      if (cancelled) return;
      const next = stateOf(read, run, task);
      setState(next);
      if (next.status === "open") timer = setTimeout(() => setTick((t) => t + 1), POLL_MS);
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, name, taskId, tick]);

  const setRun = useCallback((run: TaskRun) => {
    setState((s) => ({
      ...s,
      run,
      result: s.result ? { ...s.result, assessment: run.assessment, label: run.label } : s.result,
    }));
  }, []);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, setRun, reload };
}

/** The screen while the run is loading, still open, or unreadable; null once there is something to show. */
function ResultStatus({ state }: { state: RunResultState }) {
  if (state.status === "loading" && !state.run) {
    return (
      <div className="loading-list" aria-busy="true">
        <div className="skel skel-card" />
        <div className="skel skel-row" />
        <div className="skel skel-row" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="error-banner" role="alert">
        {state.error ?? "This run's result could not be read."}
      </div>
    );
  }
  if (state.status === "open") {
    return (
      <div className="result-open" aria-live="polite">
        <span className="dot dot-running" />{" "}
        {state.run?.status === "queued" ? (
          "Waiting for a run slot."
        ) : (
          <>
            Running
            {state.run?.startedAt && (
              <>
                {" "}
                for <Elapsed since={state.run.startedAt} />
              </>
            )}
            .
          </>
        )}{" "}
        Its steps and result appear here when it ends.
      </div>
    );
  }
  return null;
}

/** Links to the run this one retried, and to its batch. */
function RelatedLinks({
  run,
  onOpenRun,
  onOpenBatch,
}: {
  run?: TaskRun;
  onOpenRun?: (runId: string) => void;
  onOpenBatch?: (batchId: string) => void;
}) {
  const retryOf = onOpenRun ? run?.retryOf : undefined;
  const batchId = onOpenBatch ? run?.batchId : undefined;
  if (!retryOf && !batchId) return null;
  return (
    <section className="section result-links" aria-label="Related">
      {retryOf && (
        <button type="button" className="link-btn" onClick={() => onOpenRun?.(retryOf)}>
          Open the run this retried
        </button>
      )}
      {batchId && (
        <button type="button" className="link-btn" onClick={() => onOpenBatch?.(batchId)}>
          Open its batch
          {run?.batchIndex !== undefined ? ` (item ${run.batchIndex + 1})` : ""}
        </button>
      )}
    </section>
  );
}

/**
 * The parts below the deliverable, in reading order: whether it is good,
 * how it ran, the tool calls, the input, the cost, and links to related runs.
 */
export function ResultBody({
  state,
  canAct,
  assessBusy,
  assessError,
  onVerdict,
  onRejudge,
  onOpenFile,
  onOpenRun,
  onOpenBatch,
}: {
  state: RunResultState;
  canAct: boolean;
  assessBusy: boolean;
  assessError: string | null;
  onVerdict: (verdict: "pass" | "fail", note: string) => void;
  onRejudge: () => void;
  onOpenFile?: (file: RunFileRef) => void;
  onOpenRun?: (runId: string) => void;
  onOpenBatch?: (batchId: string) => void;
}) {
  const status = <ResultStatus state={state} />;
  if (state.status !== "ready" && (state.status !== "loading" || !state.run)) return status;
  const { run, result } = state;
  const assessment = run?.assessment ?? result?.assessment;
  const canJudge = canAct && run?.execution !== "skipped" && !!(result || run?.resultPreview);
  return (
    <>
      <Deliverable result={result} run={run} onOpenFile={onOpenFile} />
      <AssessmentPanel
        assessment={assessment}
        criteria={state.criteria}
        canAct={canJudge}
        busy={assessBusy}
        error={assessError}
        onVerdict={onVerdict}
        onRejudge={onRejudge}
      />
      <ExecutionPanel run={run} result={result} />
      <RunSteps log={result?.activityLog ?? []} />
      <InputPanel input={run?.input} />
      <CostPanel run={run} result={result} />
      <RelatedLinks run={run} onOpenRun={onOpenRun} onOpenBatch={onOpenBatch} />
    </>
  );
}

/** Set a verdict or re-judge, keeping the screen's copy of the run current. */
export function useAssess(runId: string, name: string | undefined, onRun: (run: TaskRun) => void) {
  const assessTool = useTool<string>("assess");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function call(args: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await assessTool.call({ runId, ...(name ? { name } : {}), ...args });
      const run = asDict(res.data).run as TaskRun | undefined;
      if (run) onRun(run);
      return true;
    } catch (err) {
      setError(toolErrorText(err, "That did not save."));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    verdict: (verdict: "pass" | "fail", note: string) =>
      call({ verdict, ...(note.trim() ? { note: note.trim() } : {}) }),
    rejudge: () => call({ reassess: true }),
  };
}

/** Open a run's file in the Files app, when the host can open apps. */
export function useOpenFile(): (file: RunFileRef) => void {
  const app = useApp();
  return (file) => hostAction(app, "openApp", { name: "files", target: `files://${file.id}` });
}

/** The result screen's status line: label, who started it, when, how long, what it cost. */
function ResultSub({
  run,
  label,
  taskGone,
}: {
  run?: TaskRun;
  label?: TaskRun["label"];
  taskGone: boolean;
}) {
  return (
    <>
      <RunBadge label={label} />
      {taskGone && <span className="tag">task deleted</span>}
      {run && <span>{STARTED_BY_TEXT[startedByOf(run)]}</span>}
      {run && (
        <span>
          {new Date(run.startedAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      )}
      {run?.completedAt && <span>{formatDuration(run.startedAt, run.completedAt)}</span>}
      {run?.costUsd !== undefined && <span>{formatUsd(run.costUsd)}</span>}
    </>
  );
}

/**
 * The run result screen: the deliverable first, then whether it is good,
 * then how it was made.
 */
export function ResultScreen({
  runId,
  taskId,
  taskName,
  initialRun,
  onBack,
  onRerun,
  onOpenRun,
  onOpenBatch,
}: {
  runId: string;
  taskId?: string;
  /** Absent when the task was deleted. */
  taskName?: string;
  initialRun?: TaskRun;
  onBack: () => void;
  onRerun?: (task: { id: string; name: string }, input: unknown) => void;
  onOpenRun: (runId: string, taskId?: string) => void;
  onOpenBatch: (batchId: string) => void;
}) {
  const name = taskName ?? taskId;
  const state = useRunResult(runId, name, taskId ?? initialRun?.taskId, initialRun);
  const assess = useAssess(runId, name, state.setRun);
  const cancelTool = useTool<string>("cancel");
  const [cancelling, setCancelling] = useState(false);
  const openFile = useOpenFile();
  const [copied, setCopied] = useState(false);
  const run = state.run;
  const label = run?.label ?? state.result?.label;
  const shownName = taskName ?? state.taskName;
  const rerunId = taskId ?? run?.taskId;
  const output = state.result?.output ?? run?.resultPreview ?? "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        state.result?.structured !== undefined
          ? JSON.stringify(state.result.structured, null, 2)
          : output,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // no clipboard in this frame
    }
  }

  return (
    <div className="app">
      <ScreenHead
        title={shownName ?? taskId ?? "Run"}
        onBack={onBack}
        sub={<ResultSub run={run} label={label} taskGone={!!state.taskGone} />}
        actions={
          <>
            {state.status === "open" && name && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  void cancelTool.call({ name }).finally(() => {
                    setCancelling(false);
                    state.reload();
                  });
                }}
              >
                {cancelling ? "Cancelling…" : "Cancel run"}
              </button>
            )}
            {output && (
              <button type="button" className="btn" onClick={copy}>
                {copied ? "Copied" : "Copy result"}
              </button>
            )}
            {shownName && rerunId && !state.taskGone && onRerun && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onRerun({ id: rerunId, name: shownName }, run?.input)}
              >
                Re-run
              </button>
            )}
          </>
        }
      />
      <div className="content">
        <div className="view-pad result-content">
          <ResultBody
            state={state}
            canAct={!!name && !state.taskGone}
            assessBusy={assess.busy}
            assessError={assess.error}
            onVerdict={(v, note) => void assess.verdict(v, note)}
            onRejudge={() => void assess.rejudge()}
            onOpenFile={openFile}
            onOpenRun={(id) => onOpenRun(id, taskId)}
            onOpenBatch={onOpenBatch}
          />
        </div>
      </div>
    </div>
  );
}
