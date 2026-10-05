import { useEffect, useState } from "react";
import type { TaskStats, TaskSummary } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatPercent, formatUsd, relativeTime, toolErrorText } from "../utils.ts";
import { RowMenu } from "./RowMenu.tsx";
import { RunBadge } from "./RunBadge.tsx";
import { SkeletonRows } from "./Skeleton.tsx";
import { taskMenuItems } from "./TaskPage.tsx";
import { TEMPLATES, type Template } from "./templates.ts";

export interface SavedActions {
  onOpen: (task: TaskSummary) => void;
  onRunNow: (task: TaskSummary) => void;
  onRunList: (task: TaskSummary) => void;
  onEdit: (task: TaskSummary) => void;
  onDuplicate: (task: TaskSummary) => void;
  onToggle: (task: TaskSummary) => void;
  onDelete: (task: TaskSummary) => void;
  onOpenRun: (task: TaskSummary, runId: string) => void;
  onCreate: (template?: Template) => void;
}

const BUSY_TEXT: Record<string, string> = {
  running: "Starting…",
  pausing: "Turning off…",
  resuming: "Turning on…",
  deleting: "Deleting…",
};

/** Whether a task has a trigger that Pause and Resume act on. */
export function hasTrigger(task: TaskSummary): boolean {
  return (task.scheduleType ?? "none") !== "none" && !task.onceDone;
}

/** The trigger's state beside its summary: paused, turned off by the runtime, or done. */
export function triggerState(task: TaskSummary): string | null {
  if (task.onceDone) return null;
  if (!hasTrigger(task) || task.enabled) return null;
  return task.disabledReason ? "Turned off" : "Off";
}

/** Every saved task: trigger, last run, pass rate, 30-day cost, and its actions. */
export function SavedBody({
  tasks,
  loading,
  error,
  stats,
  statsError,
  busy,
  actions,
}: {
  tasks: TaskSummary[];
  loading: boolean;
  error: string | null;
  stats: Map<string, TaskStats> | null;
  statsError: string | null;
  /** Task id → what is in progress on it ("running", "pausing", …). */
  busy: Record<string, string>;
  actions: SavedActions;
}) {
  if (loading && tasks.length === 0) {
    return (
      <div className="view-pad" aria-busy="true">
        <SkeletonRows count={4} />
      </div>
    );
  }
  if (error && tasks.length === 0) {
    return (
      <div className="view-pad">
        <div className="error-banner" role="alert">
          {error}
        </div>
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <div className="view-pad empty-block">
        <h2 className="empty-state-title">No saved tasks</h2>
        <p className="empty-state-desc">
          A task is a prompt the agent carries out on its own: on a schedule, when an event arrives,
          or when you run it. Start from one of these, or from scratch.
        </p>
        <div className="template-grid">
          {TEMPLATES.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`template-card${t.id === "custom" ? " dashed" : ""}`}
              onClick={() => actions.onCreate(t)}
            >
              <span className="template-card-name">{t.name}</span>
              <span className="template-card-desc">{t.description}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="view-pad">
      {error && <div className="error-banner">{error}</div>}
      {statsError && (
        <div className="note-banner">Pass rates and costs are unavailable: {statsError}</div>
      )}
      <table className="saved-table">
        <caption className="sr-only">Saved tasks</caption>
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Trigger</th>
            <th scope="col">Last run</th>
            <th scope="col" className="num">
              Pass rate
            </th>
            <th scope="col" className="num">
              Cost (30d)
            </th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <SavedRow
              key={t.id}
              task={t}
              stats={stats?.get(t.id)}
              statsLoading={stats === null && !statsError}
              busy={busy[t.id]}
              actions={actions}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SavedRow({
  task,
  stats,
  statsLoading,
  busy,
  actions,
}: {
  task: TaskSummary;
  stats?: TaskStats;
  statsLoading: boolean;
  busy?: string;
  actions: SavedActions;
}) {
  const state = triggerState(task);
  const last = stats?.lastRun;
  const menu = taskMenuItems({
    runNow: () => actions.onRunNow(task),
    runList: () => actions.onRunList(task),
    edit: () => actions.onEdit(task),
    duplicate: () => actions.onDuplicate(task),
    remove: () => actions.onDelete(task),
    toggle: hasTrigger(task)
      ? { enabled: task.enabled, onToggle: () => actions.onToggle(task) }
      : undefined,
  });
  return (
    <tr>
      <td data-label="Task">
        <button type="button" className="task-link" onClick={() => actions.onOpen(task)}>
          {task.name}
        </button>
        {task.description && <div className="cell-sub">{task.description}</div>}
      </td>
      <td data-label="Trigger">
        <span>{task.schedule}</span>
        {state && (
          <span
            className={`state-pill${task.disabledReason ? " warn" : ""}`}
            title={task.disabledReason ?? undefined}
          >
            {state}
          </span>
        )}
        {state === "Turned off" && task.disabledReason && (
          <div className="cell-sub">{task.disabledReason}</div>
        )}
      </td>
      <td data-label="Last run">
        {last ? (
          <button
            type="button"
            className="last-run"
            onClick={() => actions.onOpenRun(task, last.id)}
            aria-label={`${last.label}, ${relativeTime(last.startedAt)}: open the result`}
          >
            <RunBadge label={last.label} />
            <span className="cell-sub">{relativeTime(last.startedAt)}</span>
          </button>
        ) : statsLoading ? (
          <span className="skel skel-inline" />
        ) : (
          <span className="cell-sub">No runs yet</span>
        )}
      </td>
      <td data-label="Pass rate" className="num">
        {statsLoading ? <span className="skel skel-inline" /> : formatPercent(stats?.passRate)}
      </td>
      <td data-label="Cost (30d)" className="num">
        {statsLoading ? <span className="skel skel-inline" /> : formatUsd(stats?.costUsd)}
      </td>
      <td className="row-actions">
        {busy && <span className="muted">{BUSY_TEXT[busy] ?? "Working…"}</span>}
        <RowMenu label={`Actions for ${task.name}`} items={menu} />
      </td>
    </tr>
  );
}

/** The Saved view: reads each task's figures over the last 30 days beside the list. */
export function SavedView({
  tasks,
  loading,
  error,
  busy,
  refreshKey,
  actions,
}: {
  tasks: TaskSummary[];
  loading: boolean;
  error: string | null;
  busy: Record<string, string>;
  /** Changes when the panel's data changed, to re-read the figures. */
  refreshKey: number;
  actions: SavedActions;
}) {
  const statsTool = useTool<string>("stats");
  const [stats, setStats] = useState<Map<string, TaskStats> | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: statsTool.call is stable; refreshKey is the signal
  useEffect(() => {
    let cancelled = false;
    statsTool
      .call({})
      .then((res) => {
        if (cancelled) return;
        const list = (asDict(res.data).tasks as TaskStats[]) ?? [];
        setStats(new Map(list.map((s) => [s.taskId, s])));
        setStatsError(null);
      })
      .catch((err) => {
        if (!cancelled) setStatsError(toolErrorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <SavedBody
      tasks={tasks}
      loading={loading}
      error={error}
      stats={stats}
      statsError={statsError}
      busy={busy}
      actions={actions}
    />
  );
}
