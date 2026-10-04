import { useEffect, useRef, useState } from "react";
import { BackArrowIcon } from "../icons.tsx";
import type { AutomationRun } from "../types.ts";
import { useTool } from "../useTool.ts";
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

const hintStyle = { fontSize: 11, color: "var(--color-text-secondary)", marginTop: 4 } as const;

/** Split the comma-separated tools field into patterns, dropping blanks. */
export function parseToolList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The create tool's `manifest` from the form's fields. The server expects
 * `{ manifest, body }`: the manifest carries config, the body the prompt. No
 * schedule (manual only) sends none.
 */
function buildManifest(f: {
  name: string;
  schedule: ScheduleSpec | null;
  enabled: boolean;
  maxIterations: number;
  maxRunDurationSec: number;
  model: string;
  /** null: no budget. */
  budgetMaxInput: number | null;
  allowedTools: string;
}): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: f.name.trim(),
    enabled: f.enabled,
    maxIterations: f.maxIterations,
    maxRunDurationMs: f.maxRunDurationSec * 1000,
  };
  if (f.schedule) manifest.schedule = f.schedule;
  if (f.model.trim()) manifest.model = f.model.trim();
  if (f.budgetMaxInput !== null) {
    manifest.tokenBudget = { maxInputTokens: f.budgetMaxInput, period: "daily" as const };
  }
  const tools = parseToolList(f.allowedTools);
  if (tools.length > 0) manifest.allowedTools = tools;
  return manifest;
}

/** The test-run panel's confirm button: it enables a schedule, or just keeps a manual-only one. */
function enableLabel(creating: boolean, schedule: ScheduleSpec | null): string {
  if (creating) return "Enabling\u2026";
  return schedule ? "Enable Schedule" : "Save";
}

/** What the chosen schedule means: how often and roughly what it costs, or that it runs once or on demand. */
function ScheduleSummary({ schedule }: { schedule: ScheduleSpec | null }) {
  if (!schedule) {
    return (
      <div style={hintStyle}>
        Nothing runs it on its own. Run it with Run Now whenever you need it.
      </div>
    );
  }
  if (schedule.type === "once") {
    return (
      <div style={hintStyle}>
        Runs once at that time, then turns off. Set a new time to run it again.
      </div>
    );
  }
  const runsPerDay =
    schedule.type === "interval" && schedule.intervalMs ? 86_400_000 / schedule.intervalMs : 1;
  // Sonnet default: $3/M input, $15/M output. ~20K input + ~500 output per run.
  const costPerRun = (20_000 * 3 + 500 * 15) / 1_000_000;
  const costPerDay = runsPerDay * costPerRun;
  return (
    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 6 }}>
      ~{runsPerDay < 1 ? "<1" : Math.round(runsPerDay)} run{runsPerDay >= 2 ? "s" : ""}
      /day
      {costPerDay >= 0.01 &&
        ` \u00b7 Est. ${formatCost(costPerDay)}/day (${formatCost(costPerDay * 30)}/mo)`}
    </div>
  );
}

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
  const createTool = useTool<string>("create");
  const runTool = useTool<string>("run");
  const updateTool = useTool<string>("update");

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState<ScheduleSpec | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxIterations, setMaxIterations] = useState(25);
  const [maxRunDurationSec, setMaxRunDurationSec] = useState(120);
  const [model, setModel] = useState("");
  const [budgetEnabled, setBudgetEnabled] = useState(false);
  const [budgetMaxInput, setBudgetMaxInput] = useState(500_000);
  const [allowedTools, setAllowedTools] = useState("");
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Partial<AutomationRun> | null>(null);
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
    if (!name.trim() || !prompt.trim()) {
      setError("Name and prompt are required.");
      return null;
    }
    setError(null);
    const manifest = buildManifest({
      name,
      schedule,
      enabled,
      maxIterations,
      maxRunDurationSec,
      model,
      budgetMaxInput: budgetEnabled ? budgetMaxInput : null,
      allowedTools,
    });

    try {
      const result = await createTool.call({ manifest, body: prompt.trim() });
      const data = asDict(result.data);
      return ((data.automation as Record<string, unknown>)?.name as string) ?? name;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task");
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
      // A run that outlasts the tool's sync wait returns a dispatched envelope
      // (status, startedAt), and one waiting for a run slot a queued envelope
      // (status "queued"), in place of `run`; all render through the same fields.
      setTestResult((data.run as AutomationRun | undefined) ?? (data as Partial<AutomationRun>));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test run failed");
    }
    setTesting(false);
  }

  const canSubmit = name.trim() && prompt.trim() && !creating && !testing;

  return (
    <div className="app">
      <div className="header">
        <div className="detail-header">
          <button type="button" className="back-btn" onClick={onCancel}>
            <BackArrowIcon />
          </button>
          <div className="detail-name">Create Task</div>
        </div>
      </div>
      <div className="content">
        {error && <div className="error-banner">{error}</div>}

        {/* Templates — stacked-card layout (.template-card) so the title and
            description wrap properly instead of overlapping inside a
            single-line .btn pill. */}
        {!name && !prompt && (
          <div className="detail-section">
            <div className="detail-section-title">Start from a template</div>
            <div className="template-grid">
              {TEMPLATES.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={`template-card${t.id === "custom" ? " dashed" : ""}`}
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
                  <span className="template-card-name">{t.name}</span>
                  <span className="template-card-desc">{t.description}</span>
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
            placeholder="Weekly Summary"
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
            placeholder="Summarize the week's activity, key decisions, and open items."
            rows={3}
          />
        </div>

        <div className="detail-section">
          <div className="detail-section-title">Schedule</div>
          <SchedulePicker value={schedule} onChange={setSchedule} />
          <ScheduleSummary schedule={schedule} />
        </div>

        <div className="detail-section">
          <div className="detail-section-title">Limits</div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={budgetEnabled}
              onChange={(e) => setBudgetEnabled(e.target.checked)}
            />
            Daily token budget
          </label>
          {budgetEnabled && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 6,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                Max input tokens per day:
              </span>
              <input
                className="inline-edit-input"
                type="number"
                min={10000}
                step={50000}
                value={budgetMaxInput}
                onChange={(e) => setBudgetMaxInput(Number(e.target.value))}
                style={{ width: 110 }}
              />
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                ({formatTokens(budgetMaxInput)})
              </span>
            </div>
          )}
          <div style={hintStyle}>
            Counted in tokens, not dollars. Checked before each step: a run stops when too little of
            the day's budget is left, and the automation turns off until you turn it back on.
          </div>

          <div className="detail-config-label" style={{ marginTop: 12 }}>
            Allowed tools
          </div>
          <input
            className="inline-edit-input"
            type="text"
            value={allowedTools}
            onChange={(e) => setAllowedTools(e.target.value)}
            placeholder="All tools"
          />
          <div style={hintStyle}>
            Comma-separated names or globs, e.g. <code>gmail__*</code>, <code>files__read</code> (a
            personal connection is <code>my_gmail__*</code>). Runs can't use anything else, apart
            from <code>nb__search</code> and <code>nb__manage_tools</code>. Leave empty to allow
            every tool.
          </div>
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
                  max={50}
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
                border: "1px solid var(--color-border-primary)",
                fontSize: 13,
              }}
            >
              <div style={{ marginBottom: 8 }}>
                <span className={`dot ${statusDotClass(testResult.status, true)}`} />
                <strong>{testResult.status}</strong>
                {testResult.inputTokens != null && (
                  <span
                    style={{
                      color: "var(--color-text-secondary)",
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
                      color: "var(--color-text-secondary)",
                      marginLeft: 12,
                      fontSize: 11,
                    }}
                  >
                    {formatDuration(testResult.startedAt, testResult.completedAt)}
                  </span>
                )}
              </div>
              {testResult.resultPreview && (
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                  {testResult.resultPreview}
                </pre>
              )}
              {testResult.error && (
                <pre style={{ color: "var(--nb-color-danger)", fontSize: 12 }}>
                  {testResult.error}
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
                    await updateTool.call({
                      name: name.trim(),
                      manifest: { enabled: true },
                    });
                    onCreated(name.trim());
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Failed to enable");
                  } finally {
                    setCreating(false);
                  }
                }}
                style={{
                  borderColor: "var(--color-text-accent)",
                  color: "var(--color-text-accent)",
                }}
              >
                {enableLabel(creating, schedule)}
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
              borderColor: "var(--color-text-accent)",
              color: "var(--color-text-accent)",
            }}
          >
            {creating ? "Creating\u2026" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
