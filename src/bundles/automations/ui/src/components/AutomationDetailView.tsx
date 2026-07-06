import { useCallTool, useDataSync } from "@nimblebrain/synapse/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { BackArrowIcon, WarningIcon } from "../icons.tsx";
import { renderMarkdown } from "../markdown.ts";
import type { AutomationDetail, AutomationRun } from "../types.ts";
import {
  asDict,
  formatCost,
  formatDuration,
  formatTokens,
  relativeTime,
  statusDotClass,
} from "../utils.ts";
import { InlineEditInput, InlineEditTextarea } from "./InlineEdit.tsx";
import { RunRow } from "./RunRow.tsx";
import { ScheduleEditor } from "./ScheduleEditor.tsx";
import { SkeletonCards } from "./Skeleton.tsx";

export function AutomationDetailView({
  automationName,
  onBack,
  actionInProgress,
  onRunNow: _onRunNow,
  onToggle,
  onDelete,
  onCancel,
  onUpdate,
}: {
  automationName: string;
  onBack: () => void;
  actionInProgress?: string;
  onRunNow: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onCancel: () => void;
  onUpdate: (name: string, fields: Record<string, unknown>) => Promise<void>;
}) {
  const statusTool = useCallTool<string>("status");
  const runNowTool = useCallTool<string>("run");
  const [detail, setDetail] = useState<AutomationDetail | null>(null);
  const [detailRuns, setDetailRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AutomationRun | null>(null);
  const [testRunning, setTestRunning] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: statusTool.call is stable, adding it would cause infinite re-renders
  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await statusTool.call({ name: automationName, limit: 20 });
      const { automation, runs } = parseStatusResult(asDict(result.data));
      if (automation) {
        setDetail(automation);
        setDetailRuns(runs);
      }
    } catch (err) {
      setError(errorMessage(err, "Failed to load automation details"));
    } finally {
      setLoading(false);
    }
  }, [automationName]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);
  useDataSync(() => {
    loadDetail();
  });

  const disabled = !!actionInProgress;

  async function saveField(field: string, value: unknown) {
    setEditing(null);
    setError(null);
    try {
      await onUpdate(automationName, { [field]: value });
      // Refresh ONLY on success. loadDetail() calls setError(null) before its
      // first await, so calling it after a failed save runs in the same
      // synchronous continuation as the catch's setError(message) — React
      // batches them and the null wins, silently clearing the banner. On
      // failure we keep the error and let the closed editor (setEditing(null))
      // re-render the field at its unchanged saved value.
      loadDetail();
    } catch (err) {
      setError(errorMessage(err, "Failed to save change."));
    }
  }

  async function handleRunNow() {
    setTestRunning(true);
    setTestResult(null);
    try {
      const result = await runNowTool.call({ name: automationName });
      const data = asDict(result.data);
      const run = data.run as AutomationRun | undefined;
      setTestResult(run ?? null);
      loadDetail(); // refresh status
    } catch {
      // silent — error shown via refresh
    } finally {
      setTestRunning(false);
    }
  }

  if (!detail) {
    return (
      <DetailLoadingState
        loading={loading}
        error={error}
        automationName={automationName}
        onBack={onBack}
      />
    );
  }

  const d = detail;

  return (
    <div className="app">
      <DetailHeader d={d} />

      <div className="content">
        {error && <div className="error-banner">{error}</div>}

        <DetailActions
          d={d}
          actionInProgress={actionInProgress}
          testRunning={testRunning}
          disabled={disabled}
          onRunNow={handleRunNow}
          onCancel={onCancel}
          onToggle={onToggle}
          onDelete={onDelete}
        />

        <ManualRunResult result={testResult} onDismiss={() => setTestResult(null)} />

        <PromptSection
          prompt={d.prompt}
          isEditing={editing === "prompt"}
          onEdit={() => setEditing("prompt")}
          onSave={(val) => saveField("prompt", val)}
          onCancelEdit={() => setEditing(null)}
        />

        <StatusSection d={d} />

        <ConfigSection
          d={d}
          editing={editing}
          onEdit={setEditing}
          onSave={saveField}
          onCancelEdit={() => setEditing(null)}
        />

        <RecentRuns runs={detailRuns} />
      </div>
    </div>
  );
}

/** Extracts a human-readable message from an unknown error, falling back to a default. */
function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Splits the `status` tool payload into the automation detail and its recent runs. */
function parseStatusResult(data: Record<string, unknown>): {
  automation: AutomationDetail | undefined;
  runs: AutomationRun[];
} {
  return {
    automation: data.automation as AutomationDetail | undefined,
    runs: (data.recentRuns as AutomationRun[]) ?? [],
  };
}

/** Label for the cancel button while a run is cancelling or a manual test is in flight. */
function cancelButtonLabel(actionInProgress: string | undefined, testRunning: boolean): string {
  if (actionInProgress === "cancelling") return "Cancelling…";
  if (testRunning) return "Running…";
  return "Cancel Run";
}

/** Label for the pause/resume/re-enable toggle button. */
function toggleButtonLabel(actionInProgress: string | undefined, d: AutomationDetail): string {
  if (actionInProgress === "pausing") return "Pausing…";
  if (actionInProgress === "resuming") return "Resuming…";
  if (d.enabled) return "Pause";
  return d.disabledReason ? "Re-enable" : "Resume";
}

/** Pre-load chrome: skeleton while loading, error banner on failure, otherwise nothing. */
function DetailLoadingState({
  loading,
  error,
  automationName,
  onBack,
}: {
  loading: boolean;
  error: string | null;
  automationName: string;
  onBack: () => void;
}) {
  if (loading) {
    return (
      <div className="app">
        <div className="header">
          <div className="detail-header">
            <button type="button" className="back-btn" onClick={onBack}>
              <BackArrowIcon />
            </button>
            <div className="detail-name">Loading...</div>
          </div>
        </div>
        <div className="content">
          <SkeletonCards count={2} />
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="app">
        <div className="header">
          <div className="detail-header">
            <button type="button" className="back-btn" onClick={onBack}>
              <BackArrowIcon />
            </button>
            <div className="detail-name">{automationName}</div>
          </div>
        </div>
        <div className="content">
          <div className="error-banner">{error}</div>
        </div>
      </div>
    );
  }
  return null;
}

/** Detail header: status dot, name, paused/auto-disabled tag, description, and any disabled reason. */
function DetailHeader({ d }: { d: AutomationDetail }) {
  return (
    <div className="header">
      <div className="detail-header">
        <div className="detail-name">
          <span
            className={`dot ${statusDotClass(d.lastRunStatus, d.enabled, d.consecutiveErrors)}`}
            style={{ marginRight: 8 }}
          />
          {d.name}
          {!d.enabled && (
            <span
              style={{
                fontSize: 13,
                color: d.disabledReason
                  ? "var(--nb-color-danger, #dc2626)"
                  : "var(--color-text-secondary, #737373)",
                fontWeight: 400,
                marginLeft: 8,
              }}
            >
              {d.disabledReason ? "(auto-disabled)" : "(paused)"}
            </span>
          )}
        </div>
      </div>
      {d.description && <div className="detail-desc">{d.description}</div>}
      {d.disabledReason && (
        <div
          style={{
            fontSize: 12,
            color: "var(--nb-color-danger, #dc2626)",
            padding: "8px 16px",
            background: "color-mix(in srgb, var(--nb-color-danger, #dc2626) 8%, transparent)",
            borderRadius: 6,
            margin: "8px 16px 0",
          }}
        >
          {d.disabledReason}
        </div>
      )}
    </div>
  );
}

/** Action bar: run-now/cancel, pause/resume toggle, and delete. */
function DetailActions({
  d,
  actionInProgress,
  testRunning,
  disabled,
  onRunNow,
  onCancel,
  onToggle,
  onDelete,
}: {
  d: AutomationDetail;
  actionInProgress: string | undefined;
  testRunning: boolean;
  disabled: boolean;
  onRunNow: () => void;
  onCancel: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="detail-actions">
      {actionInProgress === "running" || testRunning ? (
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          style={{ color: "var(--nb-color-danger, #dc2626)" }}
          disabled={testRunning}
        >
          {cancelButtonLabel(actionInProgress, testRunning)}
        </button>
      ) : (
        <button type="button" className="btn" disabled={disabled || testRunning} onClick={onRunNow}>
          {testRunning ? "Running…" : "Run Now"}
        </button>
      )}
      <button type="button" className="btn" disabled={disabled} onClick={onToggle}>
        {toggleButtonLabel(actionInProgress, d)}
      </button>
      <button type="button" className="btn btn-danger" disabled={disabled} onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

/** Result card for the most recent manual ("Run Now") execution. */
function ManualRunResult({
  result,
  onDismiss,
}: {
  result: AutomationRun | null;
  onDismiss: () => void;
}) {
  if (!result) return null;
  return (
    <div className="detail-section">
      <div className="detail-section-title">
        Last Manual Run
        <button
          type="button"
          className="btn"
          style={{ marginLeft: 8, padding: "2px 8px", fontSize: 11 }}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
      <div
        style={{
          padding: 12,
          borderRadius: 6,
          border: "1px solid var(--color-border, #e5e5e5)",
          fontSize: 13,
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <span className={`dot ${statusDotClass(result.status, true)}`} />
          <strong>{result.status}</strong>
          {result.inputTokens != null && (
            <span
              style={{
                color: "var(--color-text-secondary, #737373)",
                marginLeft: 12,
                fontSize: 11,
              }}
            >
              {formatTokens(result.inputTokens)} in / {formatTokens(result.outputTokens)} out
            </span>
          )}
          {result.startedAt && result.completedAt && (
            <span
              style={{
                color: "var(--color-text-secondary, #737373)",
                marginLeft: 12,
                fontSize: 11,
              }}
            >
              {formatDuration(result.startedAt, result.completedAt as string)}
            </span>
          )}
        </div>
        {result.resultPreview && (
          <div
            className="out-md"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify in renderMarkdown
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(result.resultPreview as string),
            }}
          />
        )}
        {result.error && (
          <pre style={{ color: "var(--nb-color-danger, #dc2626)", fontSize: 12 }}>
            {result.error}
          </pre>
        )}
      </div>
    </div>
  );
}

/** Prompt section: click-to-edit textarea for the automation's prompt. */
function PromptSection({
  prompt,
  isEditing,
  onEdit,
  onSave,
  onCancelEdit,
}: {
  prompt: string;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (val: string) => void;
  onCancelEdit: () => void;
}) {
  return (
    <div className="detail-section">
      <div className="detail-section-title">Prompt</div>
      {isEditing ? (
        <InlineEditTextarea value={prompt || ""} onSave={onSave} onCancel={onCancelEdit} />
      ) : (
        // biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit interaction
        // biome-ignore lint/a11y/noStaticElementInteractions: click-to-edit interaction
        <div className="detail-prompt" onClick={onEdit}>
          {prompt || "(no prompt)"}
          <span className="detail-prompt-hint">click to edit</span>
        </div>
      )}
    </div>
  );
}

/** Cumulative token usage, actual spend, and per-period budget row. */
function TokenUsageRow({ d }: { d: AutomationDetail }) {
  return (
    <div className="detail-status-row" style={{ fontSize: 11 }}>
      <span>
        Cumulative tokens: {formatTokens(d.cumulativeInputTokens)} in /{" "}
        {formatTokens(d.cumulativeOutputTokens)} out
      </span>
      {d.actualCostUsd != null && d.actualCostUsd > 0 && (
        <span>Actual spend: {formatCost(d.actualCostUsd)}</span>
      )}
      {d.tokenBudget?.maxInputTokens != null && (
        <span>
          Budget: {formatTokens(d.cumulativeInputTokens)} /{" "}
          {formatTokens(d.tokenBudget.maxInputTokens)} input
        </span>
      )}
      {d.tokenBudget?.maxOutputTokens != null && (
        <span>
          Budget: {formatTokens(d.cumulativeOutputTokens)} /{" "}
          {formatTokens(d.tokenBudget.maxOutputTokens)} output
        </span>
      )}
      {d.tokenBudget?.period && <span>Resets: {d.tokenBudget.period}</span>}
    </div>
  );
}

/** Status section: enabled state, run count, error backoff, timing, cost, token usage, and provenance. */
function StatusSection({ d }: { d: AutomationDetail }) {
  return (
    <div className="detail-section">
      <div className="detail-section-title">Status</div>
      <div className="detail-status-row">
        <span>
          <span
            className={`dot ${statusDotClass(d.lastRunStatus, d.enabled, d.consecutiveErrors)}`}
          />
          {d.enabled ? "Enabled" : "Disabled"}
        </span>
        <span>Runs: {d.runCount}</span>
        {d.consecutiveErrors > 0 && (
          <span className="backoff-badge">
            <WarningIcon />
            {d.consecutiveErrors} consecutive error{d.consecutiveErrors === 1 ? "" : "s"}
          </span>
        )}
        {d.lastRunAt && <span>Last: {relativeTime(d.lastRunAt)}</span>}
        {d.nextRunAt && <span>Next: {relativeTime(d.nextRunAt)}</span>}
        {d.estimatedCostPerDay != null && (
          <span>
            Est. cost: {formatCost(d.estimatedCostPerDay)}/day (
            {formatCost(d.estimatedCostPerMonth)}/mo)
          </span>
        )}
      </div>
      {(d.cumulativeInputTokens != null || d.cumulativeOutputTokens != null) && (
        <TokenUsageRow d={d} />
      )}
      <div className="detail-status-row" style={{ fontSize: 11 }}>
        <span>Source: {d.source}</span>
        {d.createdAt && <span>Created: {new Date(d.createdAt).toLocaleDateString()}</span>}
        {d.updatedAt && <span>Updated: {new Date(d.updatedAt).toLocaleDateString()}</span>}
      </div>
    </div>
  );
}

/** Click-to-edit config cell: shows an inline editor when active, otherwise the display value. */
function EditableConfigItem({
  label,
  active,
  onActivate,
  editor,
  children,
}: {
  label: string;
  active: boolean;
  onActivate: () => void;
  editor: ReactNode;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit config item
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-edit config item
    <div className="detail-config-item" onClick={() => !active && onActivate()}>
      <div className="detail-config-label">{label}</div>
      {active ? editor : children}
    </div>
  );
}

/** Configuration grid: click-to-edit schedule, model, iteration/token limits, tools, and (read-only) skill. */
function ConfigSection({
  d,
  editing,
  onEdit,
  onSave,
  onCancelEdit,
}: {
  d: AutomationDetail;
  editing: string | null;
  onEdit: (field: string) => void;
  onSave: (field: string, value: unknown) => void;
  onCancelEdit: () => void;
}) {
  return (
    <div className="detail-section">
      <div className="detail-section-title">Configuration</div>
      <div className="detail-config-grid">
        <EditableConfigItem
          label="Schedule"
          active={editing === "schedule"}
          onActivate={() => onEdit("schedule")}
          editor={
            <ScheduleEditor
              schedule={d.schedule as Record<string, unknown>}
              onSave={(spec) => onSave("schedule", spec)}
              onCancel={onCancelEdit}
            />
          }
        >
          <div className="detail-config-value">
            {d.scheduleHuman ||
              (typeof d.schedule === "string" ? d.schedule : JSON.stringify(d.schedule))}
          </div>
        </EditableConfigItem>

        <EditableConfigItem
          label="Model"
          active={editing === "model"}
          onActivate={() => onEdit("model")}
          editor={
            <InlineEditInput
              value={d.model || ""}
              onSave={(val) => onSave("model", val || null)}
              onCancel={onCancelEdit}
            />
          }
        >
          <div className={`detail-config-value${!d.model ? " muted" : ""}`}>
            {d.model || "default"}
          </div>
        </EditableConfigItem>

        <EditableConfigItem
          label="Max Iterations"
          active={editing === "maxIterations"}
          onActivate={() => onEdit("maxIterations")}
          editor={
            <InlineEditInput
              value={String(d.maxIterations)}
              type="number"
              onSave={(val) => onSave("maxIterations", Number(val))}
              onCancel={onCancelEdit}
            />
          }
        >
          <div className="detail-config-value">{d.maxIterations}</div>
        </EditableConfigItem>

        <EditableConfigItem
          label="Max Input Tokens"
          active={editing === "maxInputTokens"}
          onActivate={() => onEdit("maxInputTokens")}
          editor={
            <InlineEditInput
              value={String(d.maxInputTokens)}
              type="number"
              onSave={(val) => onSave("maxInputTokens", Number(val))}
              onCancel={onCancelEdit}
            />
          }
        >
          <div className="detail-config-value">{formatTokens(d.maxInputTokens)}</div>
        </EditableConfigItem>

        <EditableConfigItem
          label="Allowed Tools"
          active={editing === "allowedTools"}
          onActivate={() => onEdit("allowedTools")}
          editor={
            <InlineEditInput
              value={(d.allowedTools || []).join(", ")}
              onSave={(val) =>
                onSave(
                  "allowedTools",
                  val
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
              onCancel={onCancelEdit}
            />
          }
        >
          <div className={`detail-config-value${!d.allowedTools?.length ? " muted" : ""}`}>
            {d.allowedTools?.length ? d.allowedTools.join(", ") : "all"}
          </div>
        </EditableConfigItem>

        <div className="detail-config-item">
          <div className="detail-config-label">Skill</div>
          <div className={`detail-config-value${!d.skill ? " muted" : ""}`}>
            {d.skill || "none"}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Recent runs list, or an empty state when the automation has never run. */
function RecentRuns({ runs }: { runs: AutomationRun[] }) {
  return (
    <div className="detail-section">
      <div className="detail-section-title">Recent Runs</div>
      {runs.length > 0 ? (
        <div className="run-list">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </div>
      ) : (
        <div className="empty-state" style={{ padding: "24px" }}>
          <div className="empty-state-desc">No runs yet.</div>
        </div>
      )}
    </div>
  );
}
