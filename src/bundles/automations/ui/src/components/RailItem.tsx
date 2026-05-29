import type { AutomationRun, AutomationSummary } from "../types.ts";
import { relativeTime, statusDotClass } from "../utils.ts";

const RUN_STATUS_LABEL: Record<string, string> = {
  success: "Succeeded",
  failure: "Failed",
  timeout: "Timed out",
  running: "Running",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

function automationStatusLabel(s: AutomationSummary): string {
  if (!s.enabled) return "Paused";
  if (s.disabledAt) return `Auto-disabled${s.disabledReason ? `: ${s.disabledReason}` : ""}`;
  if (!s.lastRunStatus) return "No runs yet";
  return RUN_STATUS_LABEL[s.lastRunStatus] || s.lastRunStatus;
}

/** Compact automation entry in the left rail. Click → open config view. */
export function RailAutomationItem({
  automation,
  active,
  onClick,
}: {
  automation: AutomationSummary;
  active: boolean;
  onClick: () => void;
}) {
  const dotClass = statusDotClass(
    automation.lastRunStatus,
    automation.enabled,
    // AutomationSummary doesn't expose consecutiveErrors directly; backoff is
    // surfaced via disabledReason / lastRunStatus. The detail view shows the
    // full state.
    undefined,
  );
  return (
    <button type="button" className={`rail-auto-item${active ? " active" : ""}`} onClick={onClick}>
      <span className={`dot ${dotClass}`} title={automationStatusLabel(automation)} />
      <span className="rail-auto-text">
        <span className="rail-auto-name">{automation.name}</span>
        <span className="rail-auto-sub">{automation.schedule}</span>
      </span>
    </button>
  );
}

/** Compact run entry in the left rail. Click → open reader. */
export function RailRunItem({
  run,
  automationName,
  active,
  onClick,
}: {
  run: AutomationRun;
  automationName?: string;
  active: boolean;
  onClick: () => void;
}) {
  const dotClass = statusDotClass(run.status, true);
  const label = automationName || run.automationId || "unknown";
  const snippet = run.error
    ? `Error: ${run.error}`
    : run.resultPreview
        ?.replace(/[#*`>_~\-]/g, "")
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
