import { useCallTool, useDataSync } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useState } from "react";
import { BackArrowIcon, WarningIcon } from "../icons.tsx";
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
      const data = asDict(result.data);
      const automation = data.automation as AutomationDetail | undefined;
      const runs = (data.recentRuns as AutomationRun[]) ?? [];
      if (automation) {
        setDetail(automation);
        setDetailRuns(runs);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load automation details");
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
    await onUpdate(automationName, { [field]: value });
    loadDetail();
  }

  if (loading && !detail) {
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

  if (error && !detail) {
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

  if (!detail) return null;

  const d = detail;

  return (
    <div className="app">
      <div className="header">
        <div className="detail-header">
          <button type="button" className="back-btn" onClick={onBack}>
            <BackArrowIcon />
          </button>
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

      <div className="content">
        {error && <div className="error-banner">{error}</div>}

        {/* Actions */}
        <div className="detail-actions">
          {actionInProgress === "running" || testRunning ? (
            <button
              type="button"
              className="btn"
              onClick={onCancel}
              style={{ color: "var(--nb-color-danger, #dc2626)" }}
              disabled={testRunning}
            >
              {actionInProgress === "cancelling"
                ? "Cancelling\u2026"
                : testRunning
                  ? "Running\u2026"
                  : "Cancel Run"}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={disabled || testRunning}
              onClick={async () => {
                setTestRunning(true);
                setTestResult(null);
                try {
                  const result = await runNowTool.call({ name: automationName });
                  const data = asDict(result.data);
                  const run = data.run as AutomationRun | undefined;
                  if (run) setTestResult(run);
                  loadDetail(); // refresh status
                } catch {
                  // silent — error shown via refresh
                } finally {
                  setTestRunning(false);
                }
              }}
            >
              {testRunning ? "Running\u2026" : "Run Now"}
            </button>
          )}
          <button type="button" className="btn" disabled={disabled} onClick={onToggle}>
            {actionInProgress === "pausing"
              ? "Pausing\u2026"
              : actionInProgress === "resuming"
                ? "Resuming\u2026"
                : d.enabled
                  ? "Pause"
                  : d.disabledReason
                    ? "Re-enable"
                    : "Resume"}
          </button>
          <button type="button" className="btn btn-danger" disabled={disabled} onClick={onDelete}>
            Delete
          </button>
        </div>

        {/* Last Manual Run result */}
        {testResult && (
          <div className="detail-section">
            <div className="detail-section-title">
              Last Manual Run
              <button
                type="button"
                className="btn"
                style={{ marginLeft: 8, padding: "2px 8px", fontSize: 11 }}
                onClick={() => setTestResult(null)}
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
                <span className={`dot ${statusDotClass(testResult.status, true)}`} />
                <strong>{testResult.status}</strong>
                {testResult.inputTokens != null && (
                  <span
                    style={{
                      color: "var(--color-text-secondary, #737373)",
                      marginLeft: 12,
                      fontSize: 11,
                    }}
                  >
                    {formatTokens(testResult.inputTokens)} in /{" "}
                    {formatTokens(testResult.outputTokens)} out
                  </span>
                )}
                {testResult.startedAt && testResult.completedAt && (
                  <span
                    style={{
                      color: "var(--color-text-secondary, #737373)",
                      marginLeft: 12,
                      fontSize: 11,
                    }}
                  >
                    {formatDuration(testResult.startedAt, testResult.completedAt as string)}
                  </span>
                )}
              </div>
              {testResult.resultPreview && (
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                  {testResult.resultPreview}
                </pre>
              )}
              {testResult.error && (
                <pre style={{ color: "var(--nb-color-danger, #dc2626)", fontSize: 12 }}>
                  {testResult.error}
                </pre>
              )}
            </div>
          </div>
        )}

        {/* Prompt */}
        <div className="detail-section">
          <div className="detail-section-title">Prompt</div>
          {editing === "prompt" ? (
            <InlineEditTextarea
              value={d.prompt || ""}
              onSave={(val) => saveField("prompt", val)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            // biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit interaction
            // biome-ignore lint/a11y/noStaticElementInteractions: click-to-edit interaction
            <div className="detail-prompt" onClick={() => setEditing("prompt")}>
              {d.prompt || "(no prompt)"}
              <span className="detail-prompt-hint">click to edit</span>
            </div>
          )}
        </div>

        {/* Status */}
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
          )}
          <div className="detail-status-row" style={{ fontSize: 11 }}>
            <span>Source: {d.source}</span>
            {d.createdAt && <span>Created: {new Date(d.createdAt).toLocaleDateString()}</span>}
            {d.updatedAt && <span>Updated: {new Date(d.updatedAt).toLocaleDateString()}</span>}
          </div>
        </div>

        {/* Config */}
        <div className="detail-section">
          <div className="detail-section-title">Configuration</div>
          <div className="detail-config-grid">
            {/* Schedule */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit config item */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-edit config item */}
            <div
              className="detail-config-item"
              onClick={() => editing !== "schedule" && setEditing("schedule")}
            >
              <div className="detail-config-label">Schedule</div>
              {editing === "schedule" ? (
                <ScheduleEditor
                  schedule={d.schedule as Record<string, unknown>}
                  onSave={(spec) => saveField("schedule", spec)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="detail-config-value">
                  {d.scheduleHuman ||
                    (typeof d.schedule === "string" ? d.schedule : JSON.stringify(d.schedule))}
                </div>
              )}
            </div>

            {/* Model */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit config item */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-edit config item */}
            <div
              className="detail-config-item"
              onClick={() => editing !== "model" && setEditing("model")}
            >
              <div className="detail-config-label">Model</div>
              {editing === "model" ? (
                <InlineEditInput
                  value={d.model || ""}
                  onSave={(val) => saveField("model", val || null)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className={`detail-config-value${!d.model ? " muted" : ""}`}>
                  {d.model || "default"}
                </div>
              )}
            </div>

            {/* Max Iterations */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit config item */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-edit config item */}
            <div
              className="detail-config-item"
              onClick={() => editing !== "maxIterations" && setEditing("maxIterations")}
            >
              <div className="detail-config-label">Max Iterations</div>
              {editing === "maxIterations" ? (
                <InlineEditInput
                  value={String(d.maxIterations)}
                  type="number"
                  onSave={(val) => saveField("maxIterations", Number(val))}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="detail-config-value">{d.maxIterations}</div>
              )}
            </div>

            {/* Max Input Tokens */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit config item */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-edit config item */}
            <div
              className="detail-config-item"
              onClick={() => editing !== "maxInputTokens" && setEditing("maxInputTokens")}
            >
              <div className="detail-config-label">Max Input Tokens</div>
              {editing === "maxInputTokens" ? (
                <InlineEditInput
                  value={String(d.maxInputTokens)}
                  type="number"
                  onSave={(val) => saveField("maxInputTokens", Number(val))}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="detail-config-value">{formatTokens(d.maxInputTokens)}</div>
              )}
            </div>

            {/* Allowed Tools */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit config item */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-edit config item */}
            <div
              className="detail-config-item"
              onClick={() => editing !== "allowedTools" && setEditing("allowedTools")}
            >
              <div className="detail-config-label">Allowed Tools</div>
              {editing === "allowedTools" ? (
                <InlineEditInput
                  value={(d.allowedTools || []).join(", ")}
                  onSave={(val) =>
                    saveField(
                      "allowedTools",
                      val
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    )
                  }
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className={`detail-config-value${!d.allowedTools?.length ? " muted" : ""}`}>
                  {d.allowedTools?.length ? d.allowedTools.join(", ") : "all"}
                </div>
              )}
            </div>

            {/* Skill */}
            <div className="detail-config-item">
              <div className="detail-config-label">Skill</div>
              <div className={`detail-config-value${!d.skill ? " muted" : ""}`}>
                {d.skill || "none"}
              </div>
            </div>
          </div>
        </div>

        {/* Recent Runs */}
        <div className="detail-section">
          <div className="detail-section-title">Recent Runs</div>
          {detailRuns.length > 0 ? (
            <div className="run-list">
              {detailRuns.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          ) : (
            <div className="empty-state" style={{ padding: "24px" }}>
              <div className="empty-state-desc">No runs yet.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
