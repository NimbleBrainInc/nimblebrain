/** How the Activity view reads a run: who started it, and the filters over that. */
import type { RunLabel, TaskBatch, TaskRun } from "../types.ts";

export type StartedBy = "schedule" | "event" | "manual" | "batch" | "retry" | "not_started";

export const STARTED_BY_TEXT: Record<StartedBy, string> = {
  schedule: "Schedule",
  event: "Event",
  manual: "Run now",
  batch: "Batch",
  retry: "Retry",
  not_started: "Not started",
};

/**
 * Who started a run, from its record. A batch item and a retry name their
 * parent before the trigger; a run that never started carries no trigger.
 * Run now from this panel and a remote `tasks__run` are both `manual`: the
 * record does not say which client asked.
 */
export function startedByOf(run: Pick<TaskRun, "batchId" | "retryOf" | "trigger">): StartedBy {
  if (run.batchId) return "batch";
  if (run.retryOf) return "retry";
  if (run.trigger === "scheduled") return "schedule";
  if (run.trigger === "event") return "event";
  if (run.trigger === "manual") return "manual";
  return "not_started";
}

export interface ActivityFilters {
  label: RunLabel | "all";
  taskId: string | "all";
  startedBy: StartedBy | "all";
  /** Days back from now; "all" for the whole history. */
  range: 1 | 7 | 30 | 90 | "all";
}

export const DEFAULT_FILTERS: ActivityFilters = {
  label: "all",
  taskId: "all",
  startedBy: "all",
  range: 7,
};

/** The ISO instant the range starts at, or undefined for the whole history. */
export function sinceOf(range: ActivityFilters["range"], now = Date.now()): string | undefined {
  return range === "all" ? undefined : new Date(now - range * 86_400_000).toISOString();
}

/** The filters the server cannot apply (label, started by), applied to a page of runs. */
export function filterRuns(runs: TaskRun[], f: ActivityFilters): TaskRun[] {
  return runs.filter(
    (r) =>
      (f.label === "all" || r.label === f.label) &&
      (f.startedBy === "all" || startedByOf(r) === f.startedBy),
  );
}

/** Whether batches belong in the list under these filters. */
export function showsBatches(f: ActivityFilters): boolean {
  return f.label === "all" && (f.startedBy === "all" || f.startedBy === "batch");
}

export type ActivityRow =
  | { kind: "run"; at: string; run: TaskRun }
  | { kind: "batch"; at: string; batch: TaskBatch };

/**
 * Runs and batches in one list, newest first. A batch sits at its start
 * time and only within the loaded window of runs (newer than `floor`), so
 * paging back does not pull every old batch to the top.
 */
export function mergeRows(
  runs: TaskRun[],
  batches: TaskBatch[],
  floor: string | undefined,
): ActivityRow[] {
  const rows: ActivityRow[] = runs.map((run) => ({ kind: "run", at: run.startedAt, run }));
  for (const batch of batches) {
    if (floor && batch.createdAt < floor) continue;
    rows.push({ kind: "batch", at: batch.createdAt, batch });
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
