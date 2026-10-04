import { WarningIcon } from "../icons.tsx";
import type { AutomationSummary } from "../types.ts";
import { formatCost, statusDotClass } from "../utils.ts";

/** Human label for the pause/resume toggle button given the in-progress action and enabled state. */
function toggleButtonLabel(
  actionInProgress: string | undefined,
  enabled: boolean,
  isAutoDisabled: boolean,
): string {
  if (actionInProgress === "pausing") return "Pausing\u2026";
  if (actionInProgress === "resuming") return "Resuming\u2026";
  if (enabled) return "Pause";
  return isAutoDisabled ? "Re-enable" : "Resume";
}

/** Small label shown after the name when an automation is paused, auto-disabled, or done. */
function DisabledLabel({ isAutoDisabled, isDone }: { isAutoDisabled: boolean; isDone: boolean }) {
  if (isDone) {
    return (
      <span style={{ fontSize: 11, color: "var(--color-text-secondary)", fontWeight: 400 }}>
        (done)
      </span>
    );
  }
  return (
    <span
      style={{
        fontSize: 11,
        color: isAutoDisabled ? "var(--nb-color-danger)" : "var(--color-text-secondary)",
        fontWeight: 400,
      }}
    >
      {isAutoDisabled ? "(auto-disabled)" : "(paused)"}
    </span>
  );
}

/** Meta row: last/next run times, backoff error badge, and estimated daily cost. */
function CardMeta({
  automation,
  hasBackoff,
}: {
  automation: AutomationSummary;
  hasBackoff: boolean;
}) {
  const a = automation;
  return (
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
  );
}

/** Action buttons for a card: run/cancel, pause/resume toggle, and delete. */
function CardActions({
  actionInProgress,
  isRunning,
  disabled,
  toggleLabel,
  toggleHidden,
  onRunNow,
  onToggle,
  onDelete,
  onCancel,
}: {
  actionInProgress?: string;
  isRunning: boolean;
  disabled: boolean;
  toggleLabel: string;
  /** A once that is done re-arms by a new time, not by Resume. */
  toggleHidden: boolean;
  onRunNow: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation container for nested buttons
    <div className="auto-card-actions" role="presentation" onClick={(e) => e.stopPropagation()}>
      {isRunning ? (
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          style={{ color: "var(--nb-color-danger)" }}
        >
          {actionInProgress === "cancelling" ? "Cancelling\u2026" : "Cancel Run"}
        </button>
      ) : (
        <button type="button" className="btn" disabled={disabled} onClick={onRunNow}>
          Run Now
        </button>
      )}
      {!toggleHidden && (
        <button type="button" className="btn" disabled={disabled} onClick={onToggle}>
          {toggleLabel}
        </button>
      )}
      <button type="button" className="btn btn-danger" disabled={disabled} onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

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
  // A once schedule that has run (or missed its time) is done, not broken, so
  // it is not shown as auto-disabled.
  const isDone = !!a.onceDone;
  const isAutoDisabled = !a.enabled && !!a.disabledReason && !isDone;
  const dotClass = hasBackoff
    ? "dot-backoff"
    : statusDotClass(a.lastRunStatus, a.enabled, a.consecutiveErrors);
  const disabled = !!actionInProgress;
  const isRunning = actionInProgress === "running";
  const toggleLabel = toggleButtonLabel(actionInProgress, a.enabled, isAutoDisabled);

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
            {!a.enabled && <DisabledLabel isAutoDisabled={isAutoDisabled} isDone={isDone} />}
          </div>
          <div className="auto-card-schedule">{a.schedule}</div>
          {isAutoDisabled && a.disabledReason && (
            <div
              style={{
                fontSize: 11,
                color: "var(--nb-color-danger)",
                marginTop: 2,
              }}
            >
              {a.disabledReason}
            </div>
          )}
          <CardMeta automation={a} hasBackoff={hasBackoff} />
        </div>
        <CardActions
          actionInProgress={actionInProgress}
          isRunning={isRunning}
          disabled={disabled}
          toggleLabel={toggleLabel}
          toggleHidden={isDone}
          onRunNow={onRunNow}
          onToggle={onToggle}
          onDelete={onDelete}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}
