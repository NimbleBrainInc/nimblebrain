import { useCallTool } from "@nimblebrain/synapse/react";
import { useEffect, useRef, useState } from "react";
import { BackArrowIcon } from "../icons.tsx";
import { asDict, formatCost, formatDuration, formatTokens, statusDotClass } from "../utils.ts";
import { SchedulePicker, type ScheduleSpec } from "./SchedulePicker.tsx";

export const TEMPLATES: Array<{
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: ScheduleSpec | null;
}> = [
  {
    id: "daily-briefing",
    name: "Daily Briefing",
    description: "Morning summary of activity and priorities",
    prompt: "Generate a briefing of today's activity, upcoming events, and priorities.",
    schedule: { type: "cron", expression: "0 8 * * *", timezone: "Pacific/Honolulu" },
  },
  {
    id: "monitor-changes",
    name: "Monitor Changes",
    description: "Check for updates on a topic every 30 minutes",
    prompt: "Check for any changes or updates to [topic] and summarize what's new.",
    schedule: { type: "interval", intervalMs: 1_800_000 },
  },
  {
    id: "weekly-summary",
    name: "Weekly Summary",
    description: "End-of-week recap of decisions and open items",
    prompt: "Summarize the week's activity, key decisions, and open items.",
    schedule: { type: "cron", expression: "0 9 * * 1", timezone: "Pacific/Honolulu" },
  },
  {
    id: "custom",
    name: "Custom",
    description: "Start from scratch",
    prompt: "",
    schedule: null,
  },
];

export function CreateAutomationForm({
  onCreated,
  onCancel,
  initialTemplate,
}: {
  onCreated: (name: string) => void;
  onCancel: () => void;
  initialTemplate?: (typeof TEMPLATES)[0] | null;
}) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const createTool = useCallTool<string>("create");
  const runTool = useCallTool<string>("run");
  const updateTool = useCallTool<string>("update");

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState<ScheduleSpec | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxIterations, setMaxIterations] = useState(5);
  const [maxRunDurationSec, setMaxRunDurationSec] = useState(120);
  const [model, setModel] = useState("");
  const [budgetEnabled, setBudgetEnabled] = useState(false);
  const [budgetMaxInput, setBudgetMaxInput] = useState(500_000);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialTemplate) {
      setName(initialTemplate.name);
      setPrompt(initialTemplate.prompt);
      setSchedule(initialTemplate.schedule);
      if (initialTemplate.prompt) {
        requestAnimationFrame(() => {
          const el = promptRef.current;
          if (!el) return;
          const start = initialTemplate.prompt.indexOf("[");
          const end = initialTemplate.prompt.indexOf("]", start);
          if (start >= 0 && end > start) {
            el.focus();
            el.setSelectionRange(start, end + 1);
          }
        });
      }
    }
  }, [initialTemplate]);

  async function doCreate(enabled: boolean): Promise<string | null> {
    if (!name.trim() || !prompt.trim() || !schedule) {
      setError("Name, prompt, and schedule are required.");
      return null;
    }
    setError(null);
    const args: Record<string, unknown> = {
      name: name.trim(),
      prompt: prompt.trim(),
      schedule,
      enabled,
      maxIterations,
      maxRunDurationMs: maxRunDurationSec * 1000,
    };
    if (model.trim()) args.model = model.trim();
    if (budgetEnabled) {
      args.tokenBudget = { maxInputTokens: budgetMaxInput, period: "daily" as const };
    }

    try {
      const result = await createTool.call(args);
      const data = asDict(result.data);
      return ((data.automation as Record<string, unknown>)?.name as string) ?? name;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create automation");
      return null;
    }
  }

  async function handleCreate() {
    setCreating(true);
    const created = await doCreate(true);
    setCreating(false);
    if (created) onCreated(created);
  }

  async function handleTestRun() {
    setTesting(true);
    setTestResult(null);
    setError(null);
    // Create disabled first
    const created = await doCreate(false);
    if (!created) {
      setTesting(false);
      return;
    }
    // Run it
    try {
      const result = await runTool.call({ name: created });
      const data = asDict(result.data);
      setTestResult((data.run as Record<string, unknown>) ?? data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test run failed");
    }
    setTesting(false);
  }

  const canSubmit = name.trim() && prompt.trim() && schedule && !creating && !testing;

  return (
    <div className="app">
      <div className="header">
        <div className="detail-header">
          <button type="button" className="back-btn" onClick={onCancel}>
            <BackArrowIcon />
          </button>
          <div className="detail-name">Create Automation</div>
        </div>
      </div>
      <div className="content">
        {error && <div className="error-banner">{error}</div>}

        {/* Templates */}
        {!name && !prompt && (
          <div className="detail-section">
            <div className="detail-section-title">Start from a template</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {TEMPLATES.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className="btn"
                  style={{
                    textAlign: "left",
                    padding: "8px 12px",
                    flex: "1 1 140px",
                    minWidth: 140,
                    ...(t.id === "custom" ? { borderStyle: "dashed" } : {}),
                  }}
                  onClick={() => {
                    setName(t.id === "custom" ? "" : t.name);
                    setPrompt(t.prompt);
                    setSchedule(t.schedule);
                    if (t.prompt) {
                      requestAnimationFrame(() => {
                        const el = promptRef.current;
                        if (!el) return;
                        const start = t.prompt.indexOf("[");
                        const end = t.prompt.indexOf("]", start);
                        if (start >= 0 && end > start) {
                          el.focus();
                          el.setSelectionRange(start, end + 1);
                        }
                      });
                    }
                  }}
                >
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{t.name}</div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--color-text-secondary, #737373)",
                      marginTop: 2,
                    }}
                  >
                    {t.description}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="detail-section">
          <div className="detail-section-title">Name</div>
          <input
            className="inline-edit-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Daily Briefing"
            // biome-ignore lint/a11y/noAutofocus: intentional focus on form open
            autoFocus
          />
        </div>

        <div className="detail-section">
          <div className="detail-section-title">What should it do?</div>
          <textarea
            ref={promptRef}
            className="inline-edit-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Generate a briefing of today's activity, upcoming events, and priorities."
            rows={3}
          />
        </div>

        <div className="detail-section">
          <div className="detail-section-title">Schedule</div>
          <SchedulePicker value={schedule} onChange={setSchedule} />
          {schedule &&
            (() => {
              const runsPerDay =
                schedule.type === "interval" && schedule.intervalMs
                  ? 86_400_000 / schedule.intervalMs
                  : 1;
              // Sonnet default: $3/M input, $15/M output. ~20K input + ~500 output per run.
              const costPerRun = (20_000 * 3 + 500 * 15) / 1_000_000;
              const costPerDay = runsPerDay * costPerRun;
              return (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--color-text-secondary, #737373)",
                    marginTop: 6,
                  }}
                >
                  ~{runsPerDay < 1 ? "<1" : Math.round(runsPerDay)} run{runsPerDay >= 2 ? "s" : ""}
                  /day
                  {costPerDay >= 0.01 &&
                    ` \u00b7 Est. ${formatCost(costPerDay)}/day (${formatCost(costPerDay * 30)}/mo)`}
                </div>
              );
            })()}
        </div>

        {/* Advanced toggle */}
        <div className="detail-section">
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: toggle disclosure */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: toggle disclosure */}
          <div
            className="detail-section-title"
            style={{ cursor: "pointer", userSelect: "none" }}
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? "▾" : "▸"} Advanced
          </div>
          {showAdvanced && (
            <div className="detail-config-grid">
              <div className="detail-config-item">
                <div className="detail-config-label">Model</div>
                <input
                  className="inline-edit-input"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="workspace default"
                />
              </div>
              <div className="detail-config-item">
                <div className="detail-config-label">Max Iterations</div>
                <input
                  className="inline-edit-input"
                  type="number"
                  min={1}
                  max={15}
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(Number(e.target.value))}
                />
              </div>
              <div className="detail-config-item">
                <div className="detail-config-label">Timeout (seconds)</div>
                <input
                  className="inline-edit-input"
                  type="number"
                  min={10}
                  max={600}
                  value={maxRunDurationSec}
                  onChange={(e) => setMaxRunDurationSec(Number(e.target.value))}
                />
              </div>
              <div className="detail-config-item" style={{ gridColumn: "1 / -1" }}>
                <div
                  className="detail-config-label"
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={budgetEnabled}
                      onChange={(e) => setBudgetEnabled(e.target.checked)}
                    />
                    Daily token budget
                  </label>
                </div>
                {budgetEnabled && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: "var(--color-text-secondary, #737373)" }}>
                      Max input tokens/day:
                    </span>
                    <input
                      className="inline-edit-input"
                      type="number"
                      min={10000}
                      step={50000}
                      value={budgetMaxInput}
                      onChange={(e) => setBudgetMaxInput(Number(e.target.value))}
                      style={{ width: 100 }}
                    />
                    <span style={{ fontSize: 11, color: "var(--color-text-secondary, #737373)" }}>
                      ({formatTokens(budgetMaxInput)})
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Test result preview */}
        {testResult && (
          <div className="detail-section">
            <div className="detail-section-title">Test Run Result</div>
            <div
              style={{
                padding: 12,
                borderRadius: 6,
                border: "1px solid var(--color-border, #e5e5e5)",
                fontSize: 13,
              }}
            >
              <div style={{ marginBottom: 8 }}>
                <span className={`dot ${statusDotClass(testResult.status as string, true)}`} />
                <strong>{testResult.status as string}</strong>
                {testResult.inputTokens != null && (
                  <span
                    style={{
                      color: "var(--color-text-secondary, #737373)",
                      marginLeft: 12,
                      fontSize: 11,
                    }}
                  >
                    {formatTokens(testResult.inputTokens as number)} in /{" "}
                    {formatTokens(testResult.outputTokens as number)} out
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
                    {formatDuration(
                      testResult.startedAt as string,
                      testResult.completedAt as string,
                    )}
                  </span>
                )}
              </div>
              {testResult.resultPreview && (
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                  {testResult.resultPreview as string}
                </pre>
              )}
              {testResult.error && (
                <pre style={{ color: "var(--nb-color-danger, #dc2626)", fontSize: 12 }}>
                  {testResult.error as string}
                </pre>
              )}
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button type="button" className="btn" onClick={() => setTestResult(null)}>
                Edit
              </button>
              <button
                type="button"
                className="btn"
                disabled={creating}
                onClick={async () => {
                  setCreating(true);
                  try {
                    await updateTool.call({ name: name.trim(), enabled: true });
                    onCreated(name.trim());
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Failed to enable");
                  } finally {
                    setCreating(false);
                  }
                }}
                style={{
                  borderColor: "var(--color-text-accent, #0055FF)",
                  color: "var(--color-text-accent, #0055FF)",
                }}
              >
                {creating ? "Enabling\u2026" : "Enable Schedule"}
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="detail-actions" style={{ padding: "16px 0" }}>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={!canSubmit} onClick={handleTestRun}>
            {testing ? "Running test\u2026" : "Test Run"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!canSubmit}
            onClick={handleCreate}
            style={{
              borderColor: "var(--color-text-accent, #0055FF)",
              color: "var(--color-text-accent, #0055FF)",
            }}
          >
            {creating ? "Creating\u2026" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
