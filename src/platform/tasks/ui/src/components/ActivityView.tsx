import { useEffect, useId, useRef, useState } from "react";
import {
  type ActivityFilters,
  type ActivityRow,
  DEFAULT_FILTERS,
  filterRuns,
  mergeRows,
  STARTED_BY_TEXT,
  type StartedBy,
  showsBatches,
  sinceOf,
  startedByOf,
} from "../lib/activity.ts";
import { assessmentReasonText, inputSummary } from "../lib/plain.ts";
import type { RunLabel, TaskBatch, TaskRun, TaskSummary } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatDuration, formatUsd, relativeTime, toolErrorText } from "../utils.ts";
import { BatchProgress } from "./BatchPane.tsx";
import { RunBadge } from "./RunBadge.tsx";
import { Section } from "./Section.tsx";
import { SkeletonRows } from "./Skeleton.tsx";

const PAGE = 50;

const LABELS: RunLabel[] = [
  "Succeeded",
  "Poor result",
  "Needs review",
  "Failed",
  "Skipped",
  "Cancelled",
];

const STARTED_BY: StartedBy[] = ["schedule", "event", "manual", "batch", "retry", "not_started"];

const RANGES: Array<{ value: ActivityFilters["range"]; text: string }> = [
  { value: 1, text: "Last 24 hours" },
  { value: 7, text: "Last 7 days" },
  { value: 30, text: "Last 30 days" },
  { value: 90, text: "Last 90 days" },
  { value: "all", text: "All time" },
];

/**
 * The newest page merged into the loaded runs: a run in both takes the
 * newest copy, new runs go on top, and older loaded pages stay.
 */
export function mergeNewest(loaded: TaskRun[], newest: TaskRun[]): TaskRun[] {
  const fresh = new Map(newest.map((r) => [r.id, r]));
  const kept = loaded.filter((r) => !fresh.has(r.id));
  return [...newest, ...kept].sort((a, b) =>
    a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
  );
}

/** The short reason a run that did not succeed reads as, for its row. */
export function rowNote(run: TaskRun): string {
  if (run.error) return run.error.split("\n")[0]?.slice(0, 120) ?? "";
  if (run.assessment?.reason) return assessmentReasonText(run.assessment.reason.code);
  return "";
}

function FilterBar({
  filters,
  tasks,
  onChange,
}: {
  filters: ActivityFilters;
  /** Null: no task filter. */
  tasks: TaskSummary[] | null;
  onChange: (f: ActivityFilters) => void;
}) {
  const id = useId();
  return (
    <fieldset className="filter-bar">
      <legend className="sr-only">Filter runs</legend>
      <label htmlFor={`${id}-label`}>
        <span className="filter-name">Outcome</span>
        <select
          id={`${id}-label`}
          value={filters.label}
          onChange={(e) =>
            onChange({ ...filters, label: e.target.value as ActivityFilters["label"] })
          }
        >
          <option value="all">All</option>
          {LABELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {tasks && (
        <label htmlFor={`${id}-task`}>
          <span className="filter-name">Task</span>
          <select
            id={`${id}-task`}
            value={filters.taskId}
            onChange={(e) => onChange({ ...filters, taskId: e.target.value })}
          >
            <option value="all">All</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label htmlFor={`${id}-by`}>
        <span className="filter-name">Started by</span>
        <select
          id={`${id}-by`}
          value={filters.startedBy}
          onChange={(e) =>
            onChange({ ...filters, startedBy: e.target.value as ActivityFilters["startedBy"] })
          }
        >
          <option value="all">All</option>
          {STARTED_BY.map((s) => (
            <option key={s} value={s}>
              {STARTED_BY_TEXT[s]}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-range`}>
        <span className="filter-name">When</span>
        <select
          id={`${id}-range`}
          value={String(filters.range)}
          onChange={(e) =>
            onChange({
              ...filters,
              range: (e.target.value === "all"
                ? "all"
                : Number(e.target.value)) as ActivityFilters["range"],
            })
          }
        >
          {RANGES.map((r) => (
            <option key={String(r.value)} value={String(r.value)}>
              {r.text}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

function RunRowItem({
  run,
  taskName,
  onOpen,
}: {
  run: TaskRun;
  taskName?: string;
  onOpen: (run: TaskRun) => void;
}) {
  const note = rowNote(run);
  const input = inputSummary(run.input);
  return (
    <li className="act-row">
      <button type="button" className="act-main" onClick={() => onOpen(run)}>
        <span className="act-label">
          <RunBadge label={run.label} />
        </span>
        <span className="act-task">
          {taskName ?? run.taskId}
          {input && <span className="act-input"> · {input}</span>}
          {note && <span className="cell-sub act-note">{note}</span>}
        </span>
        <span className="act-by">{STARTED_BY_TEXT[startedByOf(run)]}</span>
        <time
          className="act-when"
          dateTime={run.startedAt}
          title={new Date(run.startedAt).toLocaleString()}
        >
          {relativeTime(run.startedAt)}
        </time>
        <span className="act-cost num">
          {run.costUsd !== undefined ? formatUsd(run.costUsd) : "—"}
        </span>
        <span className="act-dur num">{formatDuration(run.startedAt, run.completedAt)}</span>
      </button>
    </li>
  );
}

function BatchRowItem({
  batch,
  taskName,
  onOpen,
}: {
  batch: TaskBatch;
  taskName?: string;
  onOpen: (batch: TaskBatch) => void;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const { counts } = batch;
  return (
    <li className="act-row act-batch">
      <button
        type="button"
        className="act-main"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="act-label">
          <span className={`chev${open ? " open" : ""}`} aria-hidden="true">
            ▸
          </span>{" "}
          Batch
        </span>
        <span className="act-task">
          {taskName ?? batch.taskId}
          <span className="cell-sub">
            {batch.done}/{batch.items} · {counts.pass} pass · {counts.fail} fail ·{" "}
            {counts.uncertain} uncertain
            {counts.failed > 0 ? ` · ${counts.failed} failed` : ""}
          </span>
        </span>
        <span className="act-by">{batch.state[0]?.toUpperCase() + batch.state.slice(1)}</span>
        <time className="act-when" dateTime={batch.createdAt}>
          {relativeTime(batch.createdAt)}
        </time>
        <span className="act-cost num">{formatUsd(batch.costUsd)}</span>
        <span className="act-dur num" />
      </button>
      {open && (
        <div className="act-expand" id={panel}>
          <BatchProgress batch={batch} />
          {batch.pause && <div className="batch-note">{batch.pause.message}</div>}
          <button type="button" className="btn" onClick={() => onOpen(batch)}>
            Open results
          </button>
        </div>
      )}
    </li>
  );
}

/** The list of runs and batches, or why it is empty. */
function ActivityRows({
  rows,
  loading,
  error,
  filtered,
  hasMore,
  names,
  onOpenRun,
  onOpenBatch,
}: {
  rows: ActivityRow[];
  loading: boolean;
  error: string | null;
  filtered: boolean;
  hasMore: boolean;
  names: Map<string, string>;
  onOpenRun: (run: TaskRun) => void;
  onOpenBatch: (batch: TaskBatch) => void;
}) {
  return (
    <>
      {rows.length === 0 && loading && (
        <div aria-busy="true">
          <SkeletonRows count={5} />
        </div>
      )}
      {rows.length === 0 && !loading && !error && (
        <div className="empty-block">
          <h2 className="empty-state-title">{filtered ? "No runs match" : "No runs yet"}</h2>
          <p className="empty-state-desc">
            {filtered
              ? hasMore
                ? "Nothing in what has loaded matches. Load older runs, or widen the filters."
                : "Widen the filters or the time range."
              : "Runs show here as they happen: on a schedule, from an event, or when you run a task."}
          </p>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="act-list" aria-label="Runs">
          {rows.map((row) =>
            row.kind === "run" ? (
              <RunRowItem
                key={row.run.id}
                run={row.run}
                taskName={names.get(row.run.taskId)}
                onOpen={onOpenRun}
              />
            ) : (
              <BatchRowItem
                key={row.batch.id}
                batch={row.batch}
                taskName={names.get(row.batch.taskId)}
                onOpen={onOpenBatch}
              />
            ),
          )}
        </ul>
      )}
    </>
  );
}

/** Every run from every source, newest first, with batches as one row each. */
export function ActivityBody({
  rows,
  loading,
  error,
  filters,
  tasks,
  fixedTask,
  hasMore,
  onFilters,
  onMore,
  onOpenRun,
  onOpenBatch,
}: {
  rows: ActivityRow[];
  loading: boolean;
  error: string | null;
  filters: ActivityFilters;
  tasks: TaskSummary[];
  /** One task's runs: no task filter or task column. */
  fixedTask?: boolean;
  hasMore: boolean;
  onFilters: (f: ActivityFilters) => void;
  onMore: () => void;
  onOpenRun: (run: TaskRun) => void;
  onOpenBatch: (batch: TaskBatch) => void;
}) {
  const names = new Map(tasks.map((t) => [t.id, t.name]));
  const filtered =
    filters.label !== "all" ||
    filters.startedBy !== "all" ||
    (!fixedTask && (filters.taskId !== "all" || filters.range !== DEFAULT_FILTERS.range));
  return (
    <div className="view-pad">
      <Section
        title="Runs"
        aside={
          rows.length > 0 ? (
            <span className="muted">
              {rows.length} shown{hasMore ? ", more to load" : ""}
            </span>
          ) : undefined
        }
      >
        <FilterBar filters={filters} tasks={fixedTask ? null : tasks} onChange={onFilters} />
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <ActivityRows
          rows={rows}
          loading={loading}
          error={error}
          filtered={filtered}
          hasMore={hasMore}
          names={names}
          onOpenRun={onOpenRun}
          onOpenBatch={onOpenBatch}
        />
        {hasMore && (
          <button type="button" className="btn load-more" disabled={loading} onClick={onMore}>
            {loading ? "Loading…" : "Load older runs"}
          </button>
        )}
      </Section>
    </div>
  );
}

/** The Activity view: pages runs back through the archive with the filters the server applies. */
export function ActivityView({
  tasks,
  taskId,
  refreshKey,
  onOpenRun,
  onOpenBatch,
}: {
  tasks: TaskSummary[];
  /** One task's runs only: the task filter is fixed and hidden. */
  taskId?: string;
  refreshKey: number;
  onOpenRun: (run: TaskRun) => void;
  onOpenBatch: (batch: TaskBatch) => void;
}) {
  const runsTool = useTool<string>("runs");
  const batchesTool = useTool<string>("batches");
  const [filters, setFilters] = useState<ActivityFilters>(() =>
    taskId ? { ...DEFAULT_FILTERS, taskId, range: "all" } : DEFAULT_FILTERS,
  );
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [batches, setBatches] = useState<TaskBatch[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function page(
    before: string | undefined,
    f: ActivityFilters,
  ): Promise<{
    runs: TaskRun[];
    nextBefore?: string;
  }> {
    const since = sinceOf(f.range);
    const res = await runsTool.call({
      limit: PAGE,
      excludeBatchRuns: true,
      // A `before` on the first page too, so it reads back through the archive.
      before: before ?? new Date(Date.now() + 60_000).toISOString(),
      ...(since ? { since } : {}),
      ...(f.taskId !== "all" ? { taskId: f.taskId } : {}),
    });
    const data = asDict(res.data);
    return {
      runs: (data.runs as TaskRun[]) ?? [],
      nextBefore: data.nextBefore as string | undefined,
    };
  }

  // A data change re-reads the newest page and merges it into what is loaded,
  // so older pages stay; a filter change starts over.
  const filtersKey = JSON.stringify(filters);
  const lastFilters = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tool calls are stable; reload on filters or data change
  useEffect(() => {
    let cancelled = false;
    const reset = lastFilters.current !== filtersKey;
    lastFilters.current = filtersKey;
    setLoading(true);
    setError(null);
    Promise.all([
      page(undefined, filters),
      showsBatches(filters)
        ? batchesTool
            .call({ limit: 100, ...(filters.taskId !== "all" ? { taskId: filters.taskId } : {}) })
            .then((r) => (asDict(r.data).batches as TaskBatch[]) ?? [])
        : Promise.resolve([] as TaskBatch[]),
    ])
      .then(([first, b]) => {
        if (cancelled) return;
        if (reset) {
          setRuns(first.runs);
          setNextBefore(first.nextBefore);
        } else {
          setRuns((prev) => mergeNewest(prev, first.runs));
        }
        setBatches(b);
      })
      .catch((err) => {
        if (!cancelled) setError(toolErrorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filtersKey, refreshKey]);

  async function more() {
    if (!nextBefore) return;
    setLoading(true);
    try {
      const next = await page(nextBefore, filters);
      setRuns((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...next.runs.filter((r) => !seen.has(r.id))];
      });
      setNextBefore(next.nextBefore);
    } catch (err) {
      setError(toolErrorText(err));
    } finally {
      setLoading(false);
    }
  }

  const since = sinceOf(filters.range);
  // Batches older than the loaded runs wait until paging reaches them.
  const batchesOnly = filters.startedBy === "batch";
  const floor = nextBefore && !batchesOnly ? runs[runs.length - 1]?.startedAt : since;
  const shownRuns = batchesOnly ? [] : filterRuns(runs, filters);
  const rows = mergeRows(shownRuns, showsBatches(filters) ? batches : [], floor);

  return (
    <ActivityBody
      rows={rows}
      loading={loading}
      error={error}
      filters={filters}
      tasks={tasks}
      fixedTask={!!taskId}
      hasMore={!!nextBefore && !batchesOnly}
      onFilters={setFilters}
      onMore={() => void more()}
      onOpenRun={onOpenRun}
      onOpenBatch={onOpenBatch}
    />
  );
}
