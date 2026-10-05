import { type ReactNode, useEffect, useState } from "react";
import type { TaskBatch, TaskDetail, TaskRun, TaskStats } from "../types.ts";
import { useTool } from "../useTool.ts";
import {
  asDict,
  formatPercent,
  formatTokens,
  formatUsd,
  formatWhen,
  relativeTime,
  toolErrorText,
} from "../utils.ts";
import { ActivityView } from "./ActivityView.tsx";
import { ScreenHead, Tabs } from "./Chrome.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { RunBadge } from "./RunBadge.tsx";

type TaskTab = "overview" | "runs" | "definition";

const TABS: Array<{ id: TaskTab; text: string }> = [
  { id: "overview", text: "Overview" },
  { id: "runs", text: "Runs" },
  { id: "definition", text: "Definition" },
];

/** Whether a task has a trigger that `enabled` gates: a schedule or an event that can still fire. */
export function hasLiveTrigger(d: Pick<TaskDetail, "schedule" | "onceDone">): boolean {
  return !!d.schedule && !d.onceDone;
}

/** The one-line status under the title: trigger, next run, last run. */
export function statusLine(d: TaskDetail, last?: TaskRun): string {
  const parts = [d.scheduleHuman];
  if (hasLiveTrigger(d) && !d.enabled) parts.push("off");
  else if (d.nextRunAt) {
    const when = formatWhen(d.nextRunAt);
    parts.push(`next ${when.charAt(0).toLowerCase()}${when.slice(1)}`);
  }
  if (last?.label) parts.push(`last run ${last.label} ${relativeTime(last.startedAt)}`);
  return parts.join(" · ");
}

export interface TaskPageActions {
  onRunNow: (d: TaskDetail) => void;
  onRunList: (d: TaskDetail) => void;
  onEdit: (d: TaskDetail) => void;
  onDuplicate: (d: TaskDetail) => void;
  onDelete: (d: TaskDetail) => void;
  onSetEnabled: (d: TaskDetail, enabled: boolean) => Promise<void>;
  onOpenRun: (run: TaskRun) => void;
  onOpenBatch: (batch: TaskBatch) => void;
}

/** The task's ⋯ menu, shared by its page and its Saved row. */
export function taskMenuItems(a: {
  runNow?: () => void;
  runList: () => void;
  edit: () => void;
  duplicate: () => void;
  remove: () => void;
  toggle?: { enabled: boolean; onToggle: () => void };
}): RowMenuItem[] {
  return [
    ...(a.runNow ? [{ label: "Run now", onSelect: a.runNow }] : []),
    { label: "Run on a list…", onSelect: a.runList },
    { label: "Edit", onSelect: a.edit },
    { label: "Duplicate", onSelect: a.duplicate },
    ...(a.toggle
      ? [
          {
            label: a.toggle.enabled ? "Turn trigger off" : "Turn trigger on",
            onSelect: a.toggle.onToggle,
          },
        ]
      : []),
    { label: "Delete…", onSelect: a.remove, danger: true },
  ];
}

/** An on/off switch for the task's trigger. */
function EnabledSwitch({
  enabled,
  busy,
  onChange,
}: {
  enabled: boolean;
  busy: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`switch${enabled ? " on" : ""}`}
      disabled={busy}
      onClick={() => onChange(!enabled)}
      title="Whether its schedule or events run it. Run now works either way."
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      Enabled
    </button>
  );
}

/** A figure with its label, for the overview. */
function Figure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="figure">
      <div className="figure-value">{value}</div>
      <div className="figure-label">{label}</div>
    </div>
  );
}

/** Overview: pass rate, cost, next run, the last runs, and runs waiting on a person. */
export function OverviewBody({
  detail,
  stats,
  runs,
  runsError,
  onOpenRun,
}: {
  detail: TaskDetail;
  stats: TaskStats | null;
  runs: TaskRun[] | null;
  runsError: string | null;
  onOpenRun: (run: TaskRun) => void;
}) {
  const review = (runs ?? []).filter((r) => r.label === "Needs review").slice(0, 5);
  const next = hasLiveTrigger(detail) && detail.enabled && detail.nextRunAt;
  return (
    <div className="view-pad">
      <div className="figures">
        <Figure label="Pass rate, 30 days" value={stats ? formatPercent(stats.passRate) : "…"} />
        <Figure label="Cost, 30 days" value={stats ? formatUsd(stats.costUsd) : "…"} />
        <Figure label="Next run" value={next ? formatWhen(next) : "Not scheduled"} />
      </div>
      <section className="section">
        <h2 className="section-heading">Last runs</h2>
        {runsError && <div className="error-banner">{runsError}</div>}
        {!runs && !runsError && <div className="skel skel-row" aria-busy="true" />}
        {runs && runs.length === 0 && <p className="muted">No runs yet.</p>}
        {runs && runs.length > 0 && (
          <ul className="run-chips">
            {runs.slice(0, 5).map((r) => (
              <li key={r.id}>
                <button type="button" className="run-chip" onClick={() => onOpenRun(r)}>
                  <RunBadge label={r.label} />
                  <span className="muted">{relativeTime(r.startedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {review.length > 0 && (
        <section className="section">
          <h2 className="section-heading">Needs your review</h2>
          <ul className="plain-list">
            {review.map((r) => (
              <li key={r.id}>
                <button type="button" className="link-btn" onClick={() => onOpenRun(r)}>
                  Run from {formatWhen(r.startedAt)}
                </button>
                {r.assessment?.reason && (
                  <span className="muted"> — {r.assessment.reason.message}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One labelled value in the definition. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="def-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="code-block">{JSON.stringify(value, null, 2)}</pre>;
}

function passText(c: NonNullable<TaskDetail["criteria"]>[number]): string {
  if (c.type === "boolean") return c.pass === false ? "passes when no" : "passes when yes";
  if (c.type === "score") {
    const levels = c.levels ?? [];
    return typeof c.pass === "number"
      ? `passes at ${levels[c.pass] ?? c.pass} or above`
      : "passes in the upper half";
  }
  const pass = Array.isArray(c.pass) ? c.pass : c.pass ? [c.pass] : [];
  return `passes on ${pass.join(", ")}`;
}

const POOR_TEXT = {
  record: "Record it only",
  notify: "Notify",
  retry_once: "Retry once with the failed rules as guidance",
};

function limitsText(d: TaskDetail): string {
  const parts: string[] = [];
  if (d.maxIterations) parts.push(`${d.maxIterations} steps`);
  if (d.maxRunDurationMs) parts.push(`${Math.round(d.maxRunDurationMs / 1000)} s`);
  if (d.maxInputTokens) parts.push(`${formatTokens(d.maxInputTokens)} input tokens`);
  return parts.length > 0 ? `${parts.join(" · ")} per run` : "Runtime defaults";
}

function budgetText(b: TaskDetail["tokenBudget"]): string {
  if (!b) return "None";
  const caps = [
    b.maxInputTokens ? `${formatTokens(b.maxInputTokens)} input` : "",
    b.maxOutputTokens ? `${formatTokens(b.maxOutputTokens)} output` : "",
  ].filter(Boolean);
  return `${caps.join(", ")} tokens ${b.period ?? "in total"}`;
}

function WhatItDoes({ d }: { d: TaskDetail }) {
  return (
    <section className="section">
      <h2 className="section-heading">What it does</h2>
      {d.skill && (
        <p>
          Carries out the skill <code>{d.skill}</code>.
        </p>
      )}
      {d.prompt && <p className="prose">{d.prompt}</p>}
      {!d.prompt && !d.skill && <p className="muted">No prompt.</p>}
      {d.inputSchema && (
        <>
          <h3 className="sub-heading">Input</h3>
          <JsonBlock value={d.inputSchema} />
        </>
      )}
    </section>
  );
}

function judgeText(d: TaskDetail): string {
  return `${d.judge?.server ?? "The connected judge"}${d.judge?.id ? ` · ${d.judge.id}` : ""}`;
}

function WhatGood({ d }: { d: TaskDetail }) {
  const criteria = d.criteria ?? [];
  return (
    <section className="section">
      <h2 className="section-heading">What good looks like</h2>
      {criteria.length === 0 && !d.outputSchema && (
        <p className="muted">No criteria or output schema: runs are not assessed.</p>
      )}
      {criteria.length > 0 && (
        <ol className="criteria-read">
          {criteria.map((c) => (
            <li key={c.id}>
              {c.rule} <span className="muted">({passText(c)})</span>
            </li>
          ))}
        </ol>
      )}
      <dl className="def-list">
        {criteria.length > 0 && <Row label="Judge">{judgeText(d)}</Row>}
        {d.confidenceThreshold !== undefined && (
          <Row label="Confidence needed">{d.confidenceThreshold}</Row>
        )}
        <Row label="On a poor result">{POOR_TEXT[d.onPoorResult ?? "notify"]}</Row>
      </dl>
      {d.outputSchema && (
        <>
          <h3 className="sub-heading">Output schema</h3>
          <JsonBlock value={d.outputSchema} />
        </>
      )}
    </section>
  );
}

function WhenAndLimits({ d }: { d: TaskDetail }) {
  return (
    <section className="section">
      <h2 className="section-heading">When and limits</h2>
      <dl className="def-list">
        <Row label="Runs">{d.scheduleHuman}</Row>
        <Row label="Per run">{limitsText(d)}</Row>
        <Row label="Token budget">{budgetText(d.tokenBudget)}</Row>
        <Row label="Model">{d.model || "Workspace default"}</Row>
        <Row label="Tools">
          {d.allowedTools?.length ? <code>{d.allowedTools.join(", ")}</code> : "All tools"}
        </Row>
      </dl>
    </section>
  );
}

function Details({ d }: { d: TaskDetail }) {
  return (
    <details className="section details">
      <summary className="section-heading">Details</summary>
      <dl className="def-list">
        <Row label="Tokens used">
          {formatTokens(d.cumulativeInputTokens)} in · {formatTokens(d.cumulativeOutputTokens)} out
        </Row>
        <Row label="Made by">{d.source === "agent" ? "The agent" : "A person"}</Row>
        <Row label="Created">{new Date(d.createdAt).toLocaleString()}</Row>
        <Row label="Updated">{new Date(d.updatedAt).toLocaleString()}</Row>
        <Row label="Id">
          <code>{d.id}</code>
        </Row>
      </dl>
    </details>
  );
}

/** Definition: what the task is, read-only; editing is in the editor. */
export function DefinitionBody({ d, onEdit }: { d: TaskDetail; onEdit: () => void }) {
  return (
    <div className="view-pad definition">
      <div className="def-actions">
        <button type="button" className="btn" onClick={onEdit}>
          Edit
        </button>
      </div>
      <WhatItDoes d={d} />
      <WhatGood d={d} />
      <WhenAndLimits d={d} />
      <Details d={d} />
    </div>
  );
}

type ToolCall = (args: Record<string, unknown>) => Promise<{ data?: unknown }>;

/** A task's figures and recent runs; each is optional, so a failure of one leaves the other. */
async function readOverview(
  stats: ToolCall,
  runs: ToolCall,
  taskId: string,
): Promise<{ stats: TaskStats | null; runs: TaskRun[] | null; runsError: string | null }> {
  const [s, r] = await Promise.allSettled([
    stats({ taskId }),
    runs({ taskId, limit: 50, excludeBatchRuns: true }),
  ]);
  return {
    stats:
      s.status === "fulfilled"
        ? (((asDict(s.value.data).tasks as TaskStats[]) ?? [])[0] ?? null)
        : null,
    runs: r.status === "fulfilled" ? ((asDict(r.value.data).runs as TaskRun[]) ?? []) : null,
    runsError: r.status === "rejected" ? toolErrorText(r.reason) : null,
  };
}

/** A task's page: a status line and actions, then Overview, Runs, and Definition. */
export function TaskPage({
  taskName,
  refreshKey,
  busy,
  actions,
  onBack,
}: {
  taskName: string;
  refreshKey: number;
  busy?: string;
  actions: TaskPageActions;
  onBack: () => void;
}) {
  const statusTool = useTool<string>("status");
  const statsTool = useTool<string>("stats");
  const runsTool = useTool<string>("runs");
  const [tab, setTab] = useState<TaskTab>("overview");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tool calls are stable; refreshKey is the signal
  useEffect(() => {
    let cancelled = false;
    statusTool
      .call({ name: taskName, limit: 1 })
      .then(async (res) => {
        const d = asDict(res.data).task as TaskDetail | undefined;
        if (!d) throw new Error(`Task not found: ${taskName}`);
        if (cancelled) return;
        setDetail(d);
        setError(null);
        const o = await readOverview(statsTool.call, runsTool.call, d.id);
        if (cancelled) return;
        setStats(o.stats);
        setRuns(o.runs);
        setRunsError(o.runsError);
      })
      .catch((err) => {
        if (!cancelled) setError(toolErrorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [taskName, refreshKey]);

  if (!detail) {
    return (
      <div className="app">
        <ScreenHead title={taskName} onBack={onBack} />
        <div className="content view-pad">
          {error ? (
            <div className="error-banner" role="alert">
              {error}
            </div>
          ) : (
            <div className="loading-list" aria-busy="true">
              <div className="skel skel-row" />
              <div className="skel skel-card" />
            </div>
          )}
        </div>
      </div>
    );
  }

  const d = detail;
  async function setEnabled(v: boolean) {
    setToggling(true);
    try {
      await actions.onSetEnabled(d, v);
      setDetail({ ...d, enabled: v });
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="app">
      <ScreenHead
        title={d.name}
        onBack={onBack}
        sub={
          <>
            <span>{statusLine(d, runs?.[0])}</span>
            {d.disabledReason && !d.onceDone && (
              <span className="warn-text">{d.disabledReason}</span>
            )}
          </>
        }
        actions={
          <>
            {hasLiveTrigger(d) && (
              <EnabledSwitch
                enabled={d.enabled}
                busy={toggling}
                onChange={(v) => void setEnabled(v)}
              />
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={!!busy}
              onClick={() => actions.onRunNow(d)}
            >
              {busy === "running" ? "Starting…" : "Run now"}
            </button>
            <RowMenu
              label={`More actions for ${d.name}`}
              items={taskMenuItems({
                runList: () => actions.onRunList(d),
                edit: () => actions.onEdit(d),
                duplicate: () => actions.onDuplicate(d),
                remove: () => actions.onDelete(d),
              })}
            />
          </>
        }
      />
      <div className="tabs-bar">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Task" idPrefix="task" />
      </div>
      <main className="content" id="task-panel" role="tabpanel" aria-labelledby={`task-tab-${tab}`}>
        {tab === "overview" && (
          <OverviewBody
            detail={d}
            stats={stats}
            runs={runs}
            runsError={runsError}
            onOpenRun={actions.onOpenRun}
          />
        )}
        {tab === "runs" && (
          <ActivityView
            tasks={[]}
            taskId={d.id}
            refreshKey={refreshKey}
            onOpenRun={actions.onOpenRun}
            onOpenBatch={actions.onOpenBatch}
          />
        )}
        {tab === "definition" && <DefinitionBody d={d} onEdit={() => actions.onEdit(d)} />}
      </main>
    </div>
  );
}
