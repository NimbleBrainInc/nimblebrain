import { WarningIcon } from "../icons.tsx";
import type { AutomationSummary } from "../types.ts";
import { formatCost, statusDotClass } from "../utils.ts";

export function AutomationCard({
  automation,
  actionInProgress,
  onClick,
  onRunNow,
  onToggle,
  onDelete,
  onCancel,
}: {
  automation: AutomationSummary;
  actionInProgress?: string;
  onClick: () => void;
  onRunNow: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const a = automation;
  const hasBackoff = a.enabled && (a.consecutiveErrors ?? 0) > 0;
  const isAutoDisabled = !a.enabled && !!a.disabledReason;
  const dotClass = hasBackoff
    ? "dot-backoff"
    : statusDotClass(a.lastRunStatus, a.enabled, a.consecutiveErrors);
  const disabled = !!actionInProgress;
  const isRunning = actionInProgress === "running";

  const toggleLabel =
    actionInProgress === "pausing"
      ? "Pausing\u2026"
      : actionInProgress === "resuming"
        ? "Resuming\u2026"
        : a.enabled
          ? "Pause"
          : isAutoDisabled
            ? "Re-enable"
            : "Resume";

  return (
    // biome-ignore lint/a11y/useSemanticElements: complex card layout cannot be a simple button
    <div
      className="auto-card"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="auto-card-top">
        <div className="auto-card-info">
          <div className="auto-card-name">
            <span className={`dot ${dotClass}`} />
            {a.name}
            {!a.enabled && (
              <span
                style={{
                  fontSize: 11,
                  color: isAutoDisabled
                    ? "var(--nb-color-danger, #dc2626)"
                    : "var(--color-text-secondary, #737373)",
                  fontWeight: 400,
                }}
              >
                {isAutoDisabled ? "(auto-disabled)" : "(paused)"}
              </span>
            )}
          </div>
          <div className="auto-card-schedule">{a.schedule}</div>
          {isAutoDisabled && a.disabledReason && (
            <div
              style={{
                fontSize: 11,
                color: "var(--nb-color-danger, #dc2626)",
                marginTop: 2,
              }}
            >
              {a.disabledReason}
            </div>
          )}
          <div className="auto-card-meta">
            {a.lastRunAt && <span>Last: {a.lastRunAt}</span>}
            {a.nextRunAt && (
              <span>
                Next: {a.nextRunAt}
                {hasBackoff ? " (backoff)" : ""}
              </span>
            )}
            {hasBackoff && (
              <span className="backoff-badge">
                <WarningIcon />
                {a.consecutiveErrors} error{a.consecutiveErrors === 1 ? "" : "s"}
              </span>
            )}
            {a.estimatedCostPerDay != null && a.estimatedCostPerDay >= 0.01 && (
              <span>~{formatCost(a.estimatedCostPerDay)}/day</span>
            )}
          </div>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation container for nested buttons */}
        <div className="auto-card-actions" role="presentation" onClick={(e) => e.stopPropagation()}>
          {isRunning ? (
            <button
              type="button"
              className="btn"
              onClick={onCancel}
              style={{ color: "var(--nb-color-danger, #dc2626)" }}
            >
              {actionInProgress === "cancelling" ? "Cancelling\u2026" : "Cancel Run"}
            </button>
          ) : (
            <button type="button" className="btn" disabled={disabled} onClick={onRunNow}>
              Run Now
            </button>
          )}
          <button type="button" className="btn" disabled={disabled} onClick={onToggle}>
            {toggleLabel}
          </button>
          <button type="button" className="btn btn-danger" disabled={disabled} onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
