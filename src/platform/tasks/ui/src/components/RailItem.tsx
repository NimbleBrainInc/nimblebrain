import type { TaskRun, TaskSummary } from "../types.ts";
import { relativeTime, statusDotClass } from "../utils.ts";

const RUN_STATUS_LABEL: Record<string, string> = {
  success: "Succeeded",
  degraded: "Finished with errors",
  failure: "Failed",
  timeout: "Timed out",
  running: "Running",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

function taskStatusLabel(s: TaskSummary): string {
  if (s.onceDone) return s.schedule;
  if (!s.enabled) return "Paused";
  if (s.disabledAt) return `Auto-disabled${s.disabledReason ? `: ${s.disabledReason}` : ""}`;
  if (!s.lastRunStatus) return "No runs yet";
  return RUN_STATUS_LABEL[s.lastRunStatus] || s.lastRunStatus;
}

/** Compact task entry in the left rail. Click → open config view. */
export function RailTaskItem({
  task,
  active,
  onClick,
}: {
  task: TaskSummary;
  active: boolean;
  onClick: () => void;
}) {
  const dotClass = statusDotClass(
    task.lastRunStatus,
    task.enabled,
    // TaskSummary doesn't expose consecutiveErrors directly; backoff is
    // surfaced via disabledReason / lastRunStatus. The detail view shows the
    // full state.
    undefined,
  );
  return (
    <button type="button" className={`rail-auto-item${active ? " active" : ""}`} onClick={onClick}>
      <span className={`dot ${dotClass}`} title={taskStatusLabel(task)} />
      <span className="rail-auto-text">
        <span className="rail-auto-name">{task.name}</span>
        <span className="rail-auto-sub">{task.schedule}</span>
      </span>
    </button>
  );
}

/** Compact run entry in the left rail. Click → open reader. */
export function RailRunItem({
  run,
  taskName,
  active,
  onClick,
}: {
  run: TaskRun;
  taskName?: string;
  active: boolean;
  onClick: () => void;
}) {
  const dotClass = statusDotClass(run.status, true);
  const label = taskName || run.taskId || "unknown";
  const snippet = run.error
    ? `Error: ${run.error}`
    : run.resultPreview
        ?.replace(/[#*`>_~-]/g, "")
        .trim()
        .slice(0, 90) || "";
  return (
    <button type="button" className={`rail-run-item${active ? " active" : ""}`} onClick={onClick}>
      <div className="rail-run-top">
        <span className={`dot ${dotClass}`} title={RUN_STATUS_LABEL[run.status] || run.status} />
        <span className="rail-run-name">{label}</span>
        <span className="rail-run-time">{relativeTime(run.startedAt)}</span>
      </div>
      {snippet && <div className="rail-run-snippet">{snippet}</div>}
    </button>
  );
}
