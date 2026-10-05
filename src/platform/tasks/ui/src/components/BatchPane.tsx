import { useCallback, useEffect, useState } from "react";
import { renderMarkdown } from "../markdown.ts";
import type { BatchItemResult, TaskBatch, TaskRunResult } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatCost, relativeTime } from "../utils.ts";
import { ScreenHead } from "./Chrome.tsx";
import { RunBadge } from "./RunBadge.tsx";

/** Rows per page of results. */
const PAGE = 50;

const STATE_LABEL: Record<TaskBatch["state"], string> = {
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** The output fields shown as columns: every key on the loaded rows, in first-seen order, at most six. */
export function outputColumns(rows: BatchItemResult[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.output ?? {})) {
      if (!keys.includes(key)) keys.push(key);
      if (keys.length === 6) return keys;
    }
  }
  return keys;
}

/** One batch: progress, counts, cost, controls, and a results table. */
export function BatchPane({
  batch,
  taskName,
  onChanged,
  onBack,
  onOpenRun,
}: {
  batch: TaskBatch;
  taskName?: string;
  /** Reload the panel after a control changed the batch. */
  onChanged: () => void;
  onBack?: () => void;
  /** Open an item's run on the result screen. */
  onOpenRun?: (runId: string) => void;
}) {
  const batchTool = useTool<string>("batch");
  const controlTool = useTool<string>("batch_control");
  const [rows, setRows] = useState<BatchItemResult[]>([]);
  const [nextCursor, setNextCursor] = useState<number | undefined>(undefined);
  const [failingOnly, setFailingOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: batchTool.call is stable
  const loadPage = useCallback(
    async (cursor?: number) => {
      const result = await batchTool.call({
        batchId: batch.id,
        results: true,
        limit: PAGE,
        ...(failingOnly ? { verdict: "failing" } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const data = asDict(result.data);
      const page = (data.results as BatchItemResult[]) ?? [];
      setRows((prev) => (cursor === undefined ? page : [...prev, ...page]));
      setNextCursor(data.nextCursor as number | undefined);
    },
    [batch.id, failingOnly],
  );

  // Reload the first page when the batch moves on (its `updatedAt`) or the
  // filter changes (a new `loadPage`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: updatedAt is the refresh signal, not a value read here
  useEffect(() => {
    setError(null);
    loadPage().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [loadPage, batch.updatedAt]);

  async function control(action: BatchControlAction) {
    setBusy(action);
    setError(null);
    try {
      await controlTool.call({ batchId: batch.id, action });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  const columns = outputColumns(rows);

  return (
    <div className="reader">
      <BatchHead
        batch={batch}
        taskName={taskName}
        busy={busy !== null}
        onControl={control}
        onBack={onBack}
      />
      <div className="reader-body">
        <BatchProgress batch={batch} />
        {batch.pause && <div className="batch-note">{batch.pause.message}</div>}
        {error && <div className="error-banner">{error}</div>}

        <label className="batch-filter">
          <input
            type="checkbox"
            checked={failingOnly}
            onChange={(e) => setFailingOnly(e.target.checked)}
          />
          Failing items only
        </label>

        <BatchResultsTable rows={rows} columns={columns} onOpenRun={onOpenRun} />
        {nextCursor !== undefined && (
          <button
            type="button"
            className="btn"
            style={{ marginTop: 10 }}
            onClick={() =>
              loadPage(nextCursor).catch((err) =>
                setError(err instanceof Error ? err.message : String(err)),
              )
            }
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

type BatchControlAction = "pause" | "resume" | "cancel" | "rerun_failed";

/** The controls a batch in this state offers. */
function controlsFor(batch: TaskBatch): BatchControlAction[] {
  const { counts, state } = batch;
  const rerunnable = counts.failed + counts.fail + counts.skipped + counts.cancelled > 0;
  const actions: BatchControlAction[] = [];
  if (state === "running") actions.push("pause");
  if (state === "paused") actions.push("resume");
  if (state !== "cancelled" && rerunnable) actions.push("rerun_failed");
  if (state === "running" || state === "paused") actions.push("cancel");
  return actions;
}

const CONTROL_LABEL: Record<BatchControlAction, { text: string; className: string }> = {
  pause: { text: "Pause", className: "btn" },
  resume: { text: "Resume", className: "btn btn-accent" },
  rerun_failed: { text: "Re-run failed", className: "btn" },
  cancel: { text: "Cancel", className: "btn btn-danger" },
};

/** Header: the batch, its task, state, progress and cost, and its controls. */
function BatchHead({
  batch,
  taskName,
  busy,
  onControl,
  onBack,
}: {
  batch: TaskBatch;
  taskName?: string;
  busy: boolean;
  onControl: (action: BatchControlAction) => void;
  onBack?: () => void;
}) {
  const budget = batch.budgetUsd !== undefined ? ` of ${formatCost(batch.budgetUsd)}` : "";
  return (
    <ScreenHead
      title={`Batch ${batch.id.slice(6, 10)}`}
      onBack={onBack ?? (() => {})}
      sub={
        <>
          <span>{taskName ?? batch.taskId}</span>
          <span>{STATE_LABEL[batch.state]}</span>
          <span>
            {batch.done}/{batch.items} done · {formatCost(batch.costUsd) || "$0.00"}
            {budget}
          </span>
          <span>started {relativeTime(batch.createdAt)}</span>
        </>
      }
      actions={controlsFor(batch).map((action) => (
        <button
          key={action}
          type="button"
          className={CONTROL_LABEL[action].className}
          disabled={busy}
          onClick={() => onControl(action)}
        >
          {CONTROL_LABEL[action].text}
        </button>
      ))}
    />
  );
}

/** The progress bar and the counts under it. */
export function BatchProgress({ batch }: { batch: TaskBatch }) {
  const { counts } = batch;
  const pct = batch.items > 0 ? Math.round((batch.done / batch.items) * 100) : 0;
  const stoppedEarly = counts.skipped + counts.cancelled;
  const inProgress = counts.queued + counts.running;
  return (
    <>
      <div
        className="batch-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Items done"
      >
        <div className="batch-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="batch-counts">
        <span className="batch-count batch-count-pass">✓ {counts.pass} pass</span>
        <span className="batch-count batch-count-fail">✗ {counts.fail} fail</span>
        <span className="batch-count batch-count-uncertain">? {counts.uncertain} uncertain</span>
        {counts.not_assessed > 0 && (
          <span className="batch-count">{counts.not_assessed} not assessed</span>
        )}
        {counts.failed > 0 && (
          <span className="batch-count batch-count-fail">⚠ {counts.failed} failed</span>
        )}
        {stoppedEarly > 0 && (
          <span className="batch-count">{stoppedEarly} skipped or cancelled</span>
        )}
        {inProgress > 0 && <span className="batch-count">{inProgress} in progress</span>}
        {batch.passRate !== null && (
          <span className="batch-count">pass rate {Math.round(batch.passRate * 100)}%</span>
        )}
      </div>
    </>
  );
}

/** The results table: index, output fields, verdict badge, cost, and the run's output on demand. */
function BatchResultsTable({
  rows,
  columns,
  onOpenRun,
}: {
  rows: BatchItemResult[];
  columns: string[];
  onOpenRun?: (runId: string) => void;
}) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  if (rows.length === 0) return <div className="rail-empty">No items to show.</div>;
  return (
    <table className="batch-table">
      <thead>
        <tr>
          <th>#</th>
          {columns.length === 0 && <th>Input</th>}
          {columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
          <th>Result</th>
          <th>Cost</th>
          <th>Run</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <BatchRow
            key={row.index}
            row={row}
            columns={columns}
            open={openRun === row.runId}
            onToggle={() => setOpenRun(openRun === row.runId ? null : (row.runId ?? null))}
            onOpenRun={onOpenRun}
          />
        ))}
      </tbody>
    </table>
  );
}

function BatchRow({
  row,
  columns,
  open,
  onToggle,
  onOpenRun,
}: {
  row: BatchItemResult;
  columns: string[];
  open: boolean;
  onToggle: () => void;
  onOpenRun?: (runId: string) => void;
}) {
  return (
    <>
      <tr>
        <td>{row.index}</td>
        {columns.length === 0 && <td className="batch-input">{row.inputSummary}</td>}
        {columns.map((c) => (
          <td key={c}>{row.output?.[c] === undefined ? "" : String(row.output[c])}</td>
        ))}
        <td>
          {row.label ? (
            <RunBadge label={row.label} />
          ) : (
            <span className="batch-pending">pending</span>
          )}
        </td>
        <td>{row.costUsd !== undefined ? formatCost(row.costUsd) : ""}</td>
        <td>
          {row.runId && row.state === "done" ? (
            <span className="batch-run-links">
              <button
                type="button"
                className="batch-run-link"
                aria-expanded={open}
                onClick={onToggle}
              >
                {open ? "Hide" : "Preview"}
              </button>
              {onOpenRun && (
                <button
                  type="button"
                  className="batch-run-link"
                  onClick={() => row.runId && onOpenRun(row.runId)}
                >
                  Result
                </button>
              )}
            </span>
          ) : null}
        </td>
      </tr>
      {open && row.runId && (
        <tr>
          <td colSpan={columns.length + 5}>
            <BatchRunOutput runId={row.runId} error={row.error} />
          </td>
        </tr>
      )}
    </>
  );
}

/** One item's run output, read by its run id. */
function BatchRunOutput({ runId, error }: { runId: string; error?: string }) {
  const runResultTool = useTool<TaskRunResult>("run_result");
  const [output, setOutput] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runResultTool.call is stable
  useEffect(() => {
    let cancelled = false;
    runResultTool
      .call({ runId })
      .then((res) => {
        if (!cancelled) setOutput(((res.data as TaskRunResult) ?? null)?.output ?? "");
      })
      .catch((err) => {
        if (!cancelled) setFailed(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);
  return (
    <div className="batch-run-output">
      <div className="batch-run-id">{runId}</div>
      {error && <pre className="batch-run-error">{error}</pre>}
      {failed && !error && <div className="batch-pending">{failed}</div>}
      {output && (
        <div
          className="out-md"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify in renderMarkdown
          dangerouslySetInnerHTML={{ __html: renderMarkdown(output) }}
        />
      )}
    </div>
  );
}

/** A batch on its own screen, read by id and re-read after a control or a data change. */
export function BatchScreen({
  batchId,
  taskName,
  refreshKey,
  onBack,
  onOpenRun,
}: {
  batchId: string;
  taskName?: (taskId: string) => string | undefined;
  refreshKey: number;
  onBack: () => void;
  onOpenRun: (runId: string, taskId: string) => void;
}) {
  const batchTool = useTool<string>("batch");
  const [batch, setBatch] = useState<TaskBatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: batchTool.call is stable; refreshKey and tick are signals
  useEffect(() => {
    let cancelled = false;
    batchTool
      .call({ batchId })
      .then((res) => {
        if (!cancelled) setBatch((asDict(res.data).batch as TaskBatch) ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, refreshKey, tick]);

  if (!batch) {
    return (
      <div className="app">
        <ScreenHead title="Batch" onBack={onBack} />
        <div className="content">
          {error ? (
            <div className="error-banner" role="alert">
              {error}
            </div>
          ) : (
            <div className="loading-list" aria-busy="true">
              <div className="skel skel-card" />
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="app batch-screen">
      <BatchPane
        batch={batch}
        taskName={taskName?.(batch.taskId)}
        onChanged={() => setTick((t) => t + 1)}
        onBack={onBack}
        onOpenRun={(runId) => onOpenRun(runId, batch.taskId)}
      />
    </div>
  );
}
