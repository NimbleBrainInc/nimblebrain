import { action as hostAction } from "@nimblebrain/synapse";
import { useApp } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useState } from "react";
import { STARTED_BY_TEXT, startedByOf } from "../lib/activity.ts";
import { assessmentReasonText, inputSummary, runName, runTime } from "../lib/plain.ts";
import { readResult } from "../lib/runResult.ts";
import { effectiveVerdict } from "../lib/verdict.ts";
import { renderMarkdown } from "../markdown.ts";
import type { RunFileRef, TaskCriterion, TaskDetail, TaskRun, TaskRunResult } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatDuration, formatTokens, formatUsd, toolErrorText } from "../utils.ts";
import { AssessmentPanel } from "./AssessmentPanel.tsx";
import { PageHeader } from "./Chrome.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { RunBadge, StatusBadge } from "./RunBadge.tsx";
import { Elapsed, RunSteps } from "./RunSteps.tsx";
import { Section, Sections, SummaryStrip, type Tile } from "./Section.tsx";
import { asJson, ResultPreview } from "./StructuredView.tsx";

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

/** Whether a deliverable reads as structured values (an output schema's value, or JSON text). */
function isStructured(result: TaskRunResult | null, output: string): boolean {
  return result?.structured !== undefined || typeof asJson(output) === "object";
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
  const [raw, setRaw] = useState(false);
  // Every run writes a result; a run recorded before that has only its preview.
  const output = result?.output ?? run?.resultPreview ?? "";
  const files = result?.outputFiles ?? [];
  const structured = isStructured(result, output);
  return (
    <Section
      title="Result"
      aside={
        structured && (
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={raw}
            onClick={() => setRaw(!raw)}
          >
            {raw ? "Show values" : "Show raw"}
          </button>
        )
      }
    >
      {structured ? (
        <ResultPreview structured={result?.structured} text={output} raw={raw} />
      ) : output ? (
        <div
          className="out-md"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify in renderMarkdown
          dangerouslySetInnerHTML={{ __html: renderMarkdown(output) }}
        />
      ) : (
        <p className="muted">
          {run?.execution === "skipped"
            ? "This run did not start, so it left no deliverable."
            : "No deliverable for this run."}
        </p>
      )}
      {!result && run?.resultPreview && (
        <p className="muted">Showing the preview; the full result could not be read.</p>
      )}
      {files.length > 0 && (
        <div className="result-files">
          <h3 className="sub-heading">Files</h3>
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
    </Section>
  );
}

/** How the run ended in a phrase: "Completed", "Stopped before finishing: it hit its step limit". */
export function outcomeText(
  run?: TaskRun,
  result?: TaskRunResult | null,
): { value: string; sub?: string } {
  const execution = run?.execution ?? result?.execution;
  const stop = run?.stopReason ?? result?.stopReason;
  const value = execution ? (EXECUTION_TEXT[execution] ?? execution) : "Ended";
  if (stop && stop !== "complete") return { value, sub: `It ${STOP_TEXT[stop] ?? stop}.` };
  if (run?.unrecoveredToolFailures?.length) return { value, sub: "Some tool calls failed." };
  return { value, sub: run?.error ? run.error.split("\n")[0] : undefined };
}

/** The outcome's detail: the error, the budget that stopped it, tools that failed for good. */
function OutcomeDetail({ run }: { run?: TaskRun }) {
  return (
    <>
      {run?.spendAccountId?.startsWith("task-batch:") && <p>The batch's budget stopped it.</p>}
      {run?.spendAccountId?.startsWith("task-budget:") && (
        <p>The task's token budget stopped it.</p>
      )}
      {run?.error && <pre className="reader-error-body">{run.error}</pre>}
      {run?.unrecoveredToolFailures && run.unrecoveredToolFailures.length > 0 && (
        <p>Tools that failed with no later success: {run.unrecoveredToolFailures.join(", ")}</p>
      )}
    </>
  );
}

/** What the run cost: the run's model calls, the judge, and the tokens. */
function CostDetail({ run, result }: { run?: TaskRun; result: TaskRunResult | null }) {
  const judgeCost = (run?.assessment ?? result?.assessment)?.usage?.costUsd;
  return (
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
          {formatTokens(run?.inputTokens ?? result?.usage.inputTokens)} in ·{" "}
          {formatTokens(run?.outputTokens ?? result?.usage.outputTokens)} out
        </dd>
      </div>
      <div className="sv-pair">
        <dt>Steps</dt>
        <dd>{run?.iterations ?? result?.usage.iterations ?? "—"}</dd>
      </div>
    </dl>
  );
}

/** The run's report card: outcome, verdict, input, how long it took, what it cost. */
export function RunSummary({ run, result }: { run?: TaskRun; result: TaskRunResult | null }) {
  const outcome = outcomeText(run, result);
  const assessment = run?.assessment ?? result?.assessment;
  const verdict = effectiveVerdict(assessment);
  const judgeCost = assessment?.usage?.costUsd;
  const total = (run?.costUsd ?? 0) + (judgeCost ?? 0);
  const input = inputSummary(run?.input);
  const tiles: Tile[] = [
    {
      id: "outcome",
      label: "Outcome",
      value: outcome.value,
      sub: outcome.sub,
      detail:
        run?.error || run?.unrecoveredToolFailures?.length || run?.spendAccountId ? (
          <OutcomeDetail run={run} />
        ) : undefined,
    },
    {
      id: "verdict",
      label: "Verdict",
      value: verdict ? (
        <StatusBadge tone={verdict.tone} label={verdict.word} />
      ) : (
        "Not assessed yet"
      ),
      sub:
        verdict?.judge ??
        (assessment?.reason
          ? firstSentence(assessmentReasonText(assessment.reason.code))
          : undefined),
    },
    {
      id: "input",
      label: "Input",
      value: input ?? (run?.input === undefined ? "No input" : "See input"),
      detail:
        run?.input !== undefined ? (
          <pre className="code-block">{JSON.stringify(run.input, null, 2)}</pre>
        ) : undefined,
    },
    {
      id: "took",
      label: "Took",
      value: run?.completedAt ? formatDuration(run.startedAt, run.completedAt) : "—",
      sub: run ? `${STARTED_BY_TEXT[startedByOf(run)]} · ${runTime(run.startedAt)}` : undefined,
    },
    {
      id: "cost",
      label: "Cost",
      value: formatUsd(total),
      sub:
        judgeCost !== undefined ? `Includes ${formatUsd(judgeCost)} for the judge` : "Model calls",
      detail: <CostDetail run={run} result={result} />,
    },
  ];
  return <SummaryStrip tiles={tiles} label="Run summary" />;
}

function firstSentence(text: string): string {
  const end = text.indexOf(". ");
  return end > 0 ? text.slice(0, end + 1) : text;
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

/** The run's task: its name and criteria (for each rule's text), or that it is gone. */
async function readTask(
  call: ToolCall,
  taskId: string | undefined,
): Promise<{ taskName?: string; criteria?: TaskCriterion[]; taskGone?: boolean }> {
  if (!taskId) return {};
  try {
    const res = await call({ taskId, limit: 0 });
    const task = asDict(res.data).task as TaskDetail | undefined;
    return task ? { taskName: task.name, criteria: task.criteria } : { taskGone: true };
  } catch (err) {
    return /no task with id/i.test(toolErrorText(err)) ? { taskGone: true } : {};
  }
}

/** What the screen shows from what was read. */
function stateOf(
  read: { run?: TaskRun; result: TaskRunResult | null; open: boolean; error?: string },
  fallback: TaskRun | undefined,
  task: { taskName?: string; criteria?: TaskCriterion[]; taskGone?: boolean },
): RunResultState {
  const run = read.run ?? fallback;
  const open = read.open || (!!run && isOpenRun(run));
  const status = open ? "open" : read.result || run ? "ready" : "error";
  return { status, run, result: read.result, error: read.error, ...task };
}

/**
 * Load a run's record, result, and its task's criteria; poll while the run
 * is still open.
 */
export function useRunResult(
  runId: string,
  taskId: string | undefined,
  initialRun?: TaskRun,
): RunResultState & { setRun: (run: TaskRun) => void; reload: () => void } {
  const resultTool = useTool<string>("run_result");
  const statusTool = useTool<string>("status");
  const [state, setState] = useState<RunResultState>({
    status: "loading",
    run: initialRun,
    result: null,
  });
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tool calls are stable; reload on run, task, or tick
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    void (async () => {
      const [read, task] = await Promise.all([
        readResult(resultTool.call, runId, taskId),
        readTask(statusTool.call, taskId),
      ]);
      if (cancelled) return;
      const next = stateOf(read, initialRun, task);
      setState(next);
      if (next.status === "open") timer = setTimeout(() => setTick((t) => t + 1), POLL_MS);
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, taskId, tick]);

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
 * The run's page below its header: the report card, then the result, whether
 * it is good, and the steps it took, each a section; links to related runs last.
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
  // The verdict goes on a run that left a deliverable, as `tasks__assess` requires.
  const canJudge = canAct && (run?.execution === "completed" || run?.execution === "incomplete");
  return (
    <Sections>
      <RunSummary run={run} result={result} />
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
      <RunSteps log={result?.activityLog ?? []} />
      <RelatedLinks run={run} onOpenRun={onOpenRun} onOpenBatch={onOpenBatch} />
    </Sections>
  );
}

/** Set a verdict or re-judge, keeping the screen's copy of the run current. */
export function useAssess(
  runId: string,
  taskId: string | undefined,
  onRun: (run: TaskRun) => void,
) {
  const assessTool = useTool<string>("assess");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function call(args: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await assessTool.call({ runId, ...(taskId ? { taskId } : {}), ...args });
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
  label,
  taskName,
  taskGone,
}: {
  label?: TaskRun["label"];
  taskName?: string;
  taskGone: boolean;
}) {
  return (
    <>
      <RunBadge label={label} />
      {taskName && <span>{taskName}</span>}
      {taskGone && <span className="tag">task deleted</span>}
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
  onRunLoaded,
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
  /** Told the run's record once read, so the crumb can name the run as the heading does. */
  onRunLoaded?: (run: TaskRun) => void;
}) {
  const ownerTaskId = taskId ?? initialRun?.taskId;
  const state = useRunResult(runId, ownerTaskId, initialRun);
  const loadedStart = state.run?.startedAt;
  // biome-ignore lint/correctness/useExhaustiveDependencies: report once per run start, not per callback identity
  useEffect(() => {
    if (state.run && !initialRun) onRunLoaded?.(state.run);
  }, [loadedStart]);
  const assess = useAssess(runId, ownerTaskId, state.setRun);
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
      <PageHeader
        title={runName(run?.startedAt)}
        onBack={onBack}
        status={
          <ResultSub label={label} taskName={shownName ?? taskId} taskGone={!!state.taskGone} />
        }
        actions={
          <>
            {state.status === "open" && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  void cancelTool.call({ runId }).finally(() => {
                    setCancelling(false);
                    state.reload();
                  });
                }}
              >
                {cancelling ? "Cancelling…" : "Cancel run"}
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
            <RowMenu
              label="More actions for this run"
              items={[
                ...(output
                  ? [{ label: copied ? "Copied" : "Copy result", onSelect: () => void copy() }]
                  : []),
                {
                  label: "Copy run id",
                  onSelect: () => void navigator.clipboard?.writeText(runId),
                },
              ]}
            />
          </>
        }
      />
      <div className="content">
        <div className="view-pad result-content">
          <ResultBody
            state={state}
            canAct={!!ownerTaskId && !state.taskGone}
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
