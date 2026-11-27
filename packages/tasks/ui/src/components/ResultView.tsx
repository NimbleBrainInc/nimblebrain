import { notify, open } from "@nimblebrain/synapse";
import { useApp } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { STARTED_BY_TEXT, startedByOf } from "../lib/activity.ts";
import { attentionOf, askMessage } from "../lib/needs-you.ts";
import { outcomeOf } from "../lib/outcome.ts";
import { inputSummary, runName, runTime } from "../lib/plain.ts";
import { readResult } from "../lib/runResult.ts";
import { renderMarkdown } from "../markdown.ts";
import {
  isOpenExecution,
  type RunFileRef,
  type TaskDetail,
  type TaskRun,
  type TaskRunResult,
} from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatDuration, formatTokens, formatUsd, toolErrorText } from "../utils.ts";
import { PageHeader } from "./Chrome.tsx";
import { NeedsYouCallout } from "./NeedsYou.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { RunBadge } from "./RunBadge.tsx";
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
  timeout: "ran out of time",
  cancelled: "was cancelled",
  error: "ended on an error",
  other: "stopped",
  not_started: "never started",
};

/**
 * Whether a run has not ended yet, from its execution. An execution this screen
 * does not know reads as ended, so it is never polled forever (CONTRACT.md §4).
 */
export function isOpenRun(run?: Pick<TaskRun, "execution">): boolean {
  return isOpenExecution(run?.execution);
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
  const output = result?.output ?? "";
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
          // biome-ignore lint/security/noDangerouslySetInnerHtml: `renderMarkdown` returns DOMPurify output under an explicit tag and attribute allowlist (pinned by markdown.test.ts)
          dangerouslySetInnerHTML={{ __html: renderMarkdown(output) }}
        />
      ) : (
        <p className="muted">
          {run?.execution === "skipped"
            ? "This run did not start, so it left no deliverable."
            : "No deliverable for this run."}
        </p>
      )}
      {files.length > 0 && (
        <div className="result-files">
          <h3 className="sub-heading">Files</h3>
          <ul>
            {files.map((f) => (
              <li key={f.uri}>
                {onOpenFile ? (
                  <button type="button" className="link-btn" onClick={() => onOpenFile(f)}>
                    {f.name ?? f.uri}
                  </button>
                ) : (
                  (f.name ?? f.uri)
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
  const stop = result?.stopReason;
  const value = execution ? (EXECUTION_TEXT[execution] ?? execution) : "Ended";
  if (stop && stop !== "complete") return { value, sub: `It ${STOP_TEXT[stop] ?? stop}.` };
  if (run?.unrecoveredToolFailures?.length) return { value, sub: "Some tool calls failed." };
  return { value, sub: run?.error ? run.error.split("\n")[0] : undefined };
}

/** The outcome's detail: the error, the spend limit that stopped it, tools that failed for good. */
function OutcomeDetail({ run }: { run?: TaskRun }) {
  return (
    <>
      {run?.spendAccountId && <p>A spend limit stopped it.</p>}
      {run?.error && <pre className="reader-error-body">{run.error}</pre>}
      {run?.unrecoveredToolFailures && run.unrecoveredToolFailures.length > 0 && (
        <p>Tools that failed with no later success: {run.unrecoveredToolFailures.join(", ")}</p>
      )}
    </>
  );
}

/** What the run cost: its model calls, and the tokens. */
function CostDetail({ run, result }: { run?: TaskRun; result: TaskRunResult | null }) {
  return (
    <dl className="sv-dl">
      <div className="sv-pair">
        <dt>Run</dt>
        <dd>{run?.costUsd !== undefined ? formatUsd(run.costUsd) : "Not recorded"}</dd>
      </div>
      {run?.unpricedCalls !== undefined && (
        <div className="sv-pair">
          <dt>Unpriced calls</dt>
          <dd>{run.unpricedCalls}</dd>
        </div>
      )}
      <div className="sv-pair">
        <dt>Tokens</dt>
        <dd>
          {formatTokens(run?.inputTokens ?? result?.usage?.inputTokens)} in ·{" "}
          {formatTokens(run?.outputTokens ?? result?.usage?.outputTokens)} out
        </dd>
      </div>
      <div className="sv-pair">
        <dt>Steps</dt>
        <dd>{run?.iterations ?? result?.usage?.iterations ?? "—"}</dd>
      </div>
    </dl>
  );
}

/** The run's report card: outcome, input, how long it took, what it cost. */
export function RunSummary({ run, result }: { run?: TaskRun; result: TaskRunResult | null }) {
  const outcome = outcomeText(run, result);
  const total = run?.costUsd ?? 0;
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
      value:
        run?.startedAt && run.completedAt ? formatDuration(run.startedAt, run.completedAt) : "—",
      sub: run
        ? [STARTED_BY_TEXT[startedByOf(run)], run.startedAt ? runTime(run.startedAt) : ""]
            .filter(Boolean)
            .join(" · ")
        : undefined,
    },
    {
      id: "cost",
      label: "Cost",
      value: formatUsd(total),
      sub: "Model calls",
      detail: <CostDetail run={run} result={result} />,
    },
  ];
  return <SummaryStrip tiles={tiles} label="Run summary" />;
}

/** What a run result screen holds once loaded. */
export interface RunResultState {
  status: "loading" | "open" | "ready" | "error";
  run?: TaskRun;
  result: TaskRunResult | null;
  error?: string;
  /** The task's name, once read; absent while unknown. */
  taskName?: string;
  /** True once the task was looked up and is gone. */
  taskGone?: boolean;
  /** The task's `allowedTools`, once read. */
  allowedTools?: string[];
}

/** Poll interval while a run is still open. */
const POLL_MS = 3000;

type ToolCall = (args: Record<string, unknown>) => Promise<{ data?: unknown }>;

/** The run's task: its name, or that it is gone. */
async function readTask(
  call: ToolCall,
  taskId: string | undefined,
): Promise<{ taskName?: string; taskGone?: boolean; allowedTools?: string[] }> {
  if (!taskId) return {};
  try {
    const res = await call({ taskId, limit: 0 });
    const task = asDict(res.data).task as TaskDetail | undefined;
    if (!task) return { taskGone: true };
    return { taskName: task.name, ...(task.allowedTools ? { allowedTools: task.allowedTools } : {}) };
  } catch (err) {
    return /no task with id/i.test(toolErrorText(err)) ? { taskGone: true } : {};
  }
}

/** What the screen shows from what was read. */
function stateOf(
  read: { run?: TaskRun; result: TaskRunResult | null; open: boolean; error?: string },
  fallback: TaskRun | undefined,
  task: { taskName?: string; taskGone?: boolean; allowedTools?: string[] },
): RunResultState {
  const run = read.run ?? fallback;
  const open = read.open || (!!run && isOpenRun(run));
  const status = open ? "open" : read.result || run ? "ready" : "error";
  return { status, run, result: read.result, error: read.error, ...task };
}

/**
 * Load a run's record and result, and its task's name; poll while the run is
 * still open. The task is the one given, else the run's own once read.
 */
export function useRunResult(
  runId: string,
  taskId?: string,
  initialRun?: TaskRun,
): RunResultState & { reload: () => void } {
  const resultTool = useTool<string>("run_result");
  const statusTool = useTool<string>("status");
  const [state, setState] = useState<RunResultState>({
    status: "loading",
    run: initialRun,
    result: null,
  });
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `initialRun` is only the fallback shown until the first read lands, so a new one must not re-read; `tick` is the poll and reload signal
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    void (async () => {
      const read = await readResult(resultTool.call, runId);
      const task = await readTask(statusTool.call, taskId ?? read.run?.taskId);
      if (cancelled) return;
      const next = stateOf(read, initialRun, task);
      setState(next);
      if (next.status === "open") timer = setTimeout(() => setTick((t) => t + 1), POLL_MS);
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, taskId, resultTool, statusTool, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
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
        {state.run?.execution === "queued" ? (
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
  onOpenFile,
  onOpenRun,
  onOpenBatch,
  onEdit,
  onAsk,
}: {
  state: RunResultState;
  onOpenFile?: (file: RunFileRef) => void;
  onOpenRun?: (runId: string) => void;
  onOpenBatch?: (batchId: string) => void;
  /** Open the run's task's form; absent when there is no task to edit. */
  onEdit?: () => void;
  /** Ask the agent in chat about the run, given why it needs the person. */
  onAsk?: (sentence: string) => void;
}) {
  const status = <ResultStatus state={state} />;
  if (state.status !== "ready" && (state.status !== "loading" || !state.run)) return status;
  const { run, result } = state;
  const sentence = attentionOf(run, {
    log: result?.activityLog,
    allowedTools: state.allowedTools,
    stopReason: result?.stopReason,
  });
  return (
    <Sections>
      {sentence && (
        <NeedsYouCallout
          sentence={sentence}
          tone={run?.label === "Needs review" ? "warning" : "danger"}
          onEdit={onEdit}
          onAsk={onAsk ? () => onAsk(sentence) : undefined}
        />
      )}
      <RunSummary run={run} result={result} />
      <Deliverable result={result} run={run} onOpenFile={onOpenFile} />
      <RunSteps log={result?.activityLog ?? []} />
      <RelatedLinks run={run} onOpenRun={onOpenRun} onOpenBatch={onOpenBatch} />
    </Sections>
  );
}

/**
 * Open a run's file through the host, by the reference the host recorded for
 * it: the host finds the app that shows it. A refusal is shown as a notice
 * rather than dropped.
 */
export function useOpenFile(): (file: RunFileRef) => void {
  const app = useApp();
  return (file) => {
    open(app, file.uri).catch((err: unknown) =>
      notify(app, {
        level: "error",
        title: "Couldn't open the file",
        description: err instanceof Error ? err.message : String(err),
      }).catch(() => {}),
    );
  };
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
      {label && outcomeOf(label).word !== label && <span className="muted">{label}</span>}
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
  onEdit,
  onAsk,
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
  /** Open a task's form. */
  onEdit?: (taskId: string) => void;
  /** Hand a message to the agent in chat; absent where the host takes no message. */
  onAsk?: (message: string) => void;
}) {
  const ownerTaskId = taskId ?? initialRun?.taskId;
  const state = useRunResult(runId, ownerTaskId, initialRun);
  // Told once the record is read, not on each poll that re-reads it.
  const loadedStart = state.run?.startedAt;
  const reportLoaded = useEffectEvent(() => {
    if (state.run && !initialRun) onRunLoaded?.(state.run);
  });
  useEffect(() => {
    if (loadedStart !== undefined) reportLoaded();
  }, [loadedStart]);
  const cancelTool = useTool<string>("cancel");
  const [cancelling, setCancelling] = useState(false);
  const openFile = useOpenFile();
  const [copied, setCopied] = useState(false);
  const run = state.run;
  const label = run?.label ?? state.result?.label;
  const shownName = taskName ?? state.taskName;
  const rerunId = taskId ?? run?.taskId;
  const output = state.result?.output ?? "";
  // A task still there is one the person can fix; a deleted task's run only reads.
  const canFix = !!rerunId && !!shownName && !state.taskGone;

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
            onOpenFile={openFile}
            onOpenRun={(id) => onOpenRun(id, taskId)}
            onOpenBatch={onOpenBatch}
            onEdit={canFix && onEdit ? () => onEdit(rerunId) : undefined}
            onAsk={
              canFix && onAsk
                ? (sentence) => onAsk(askMessage({ id: rerunId, name: shownName }, { id: runId }, sentence))
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
