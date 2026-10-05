import { type ReactNode, useContext, useEffect, useState } from "react";
import { StatusIcon } from "../icons.tsx";
import { healthOf, type TaskHealth } from "../lib/attention.ts";
import { renderMarkdown } from "../markdown.ts";
import type { TaskDetail, TaskRun, TaskStats, TaskSummary } from "../types.ts";
import { useTool } from "../useTool.ts";
import {
  asDict,
  formatDuration,
  formatPercent,
  formatTokens,
  formatUsd,
  formatWhen,
  relativeTime,
  toolErrorText,
} from "../utils.ts";
import { HostTrailContext } from "./Chrome.tsx";
import { isOpenRun } from "./ResultView.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { labelTone } from "./RunBadge.tsx";

/** Runs listed on the page; the rest are behind "See all runs". */
const RECENT_RUNS = 6;

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
  if (d.consecutiveErrors > 0) {
    parts.push(`${d.consecutiveErrors} failed in a row, retrying with backoff`);
  }
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
  onSeeRuns: (d: TaskDetail) => void;
}

/** The task's ⋯ menu. */
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

/** One labelled value in the setup. */
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

function judgeText(d: TaskDetail): string {
  return `${d.judge?.server ?? "The connected judge"}${d.judge?.id ? ` · ${d.judge.id}` : ""}`;
}

/** A closed section: its heading, a short hint of what is inside, and the body on open. */
function Disclosure({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <details className="disclosure">
      <summary>
        <span className="disclosure-title">{title}</span>
        {hint && <span className="disclosure-hint">{hint}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/** How the task is set up, read-only and closed by default; editing is in the editor. */
function DoesSection({ d }: { d: TaskDetail }) {
  return (
    <Disclosure title="What it does" hint={d.scheduleHuman}>
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
    </Disclosure>
  );
}

function goodHint(d: TaskDetail): string {
  const n = d.criteria?.length ?? 0;
  if (n > 0) return `${n} ${n === 1 ? "rule" : "rules"}`;
  return d.outputSchema ? "An output schema" : "Not checked";
}

function GoodSection({ d }: { d: TaskDetail }) {
  const criteria = d.criteria ?? [];
  return (
    <Disclosure title="What good looks like" hint={goodHint(d)}>
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
    </Disclosure>
  );
}

function LimitsSection({ d }: { d: TaskDetail }) {
  return (
    <Disclosure title="Limits and tools" hint={d.model || "Workspace default model"}>
      <dl className="def-list">
        <Row label="Runs">{d.scheduleHuman}</Row>
        <Row label="Per run">{limitsText(d)}</Row>
        <Row label="Token budget">{budgetText(d.tokenBudget)}</Row>
        <Row label="Model">{d.model || "Workspace default"}</Row>
        <Row label="Tools">
          {d.allowedTools?.length ? <code>{d.allowedTools.join(", ")}</code> : "All tools"}
        </Row>
      </dl>
    </Disclosure>
  );
}

function DetailsSection({ d }: { d: TaskDetail }) {
  return (
    <Disclosure title="Details">
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
    </Disclosure>
  );
}

/** The task's setup, read-only, each part behind a closed disclosure. */
export function SetupSections({ d, onEdit }: { d: TaskDetail; onEdit: () => void }) {
  return (
    <div className="setup">
      <DoesSection d={d} />
      <GoodSection d={d} />
      <LimitsSection d={d} />
      <DetailsSection d={d} />
      <div className="setup-edit">
        <button type="button" className="btn" onClick={onEdit}>
          Edit task
        </button>
      </div>
    </div>
  );
}

/** The newest run: still going, or its result's opening lines and a way into it. */
function LatestRun({ run, onOpenRun }: { run?: TaskRun; onOpenRun: (run: TaskRun) => void }) {
  if (!run) {
    return (
      <section className="task-section" aria-label="Latest result">
        <h3 className="section-heading">Latest result</h3>
        <p className="muted">No runs yet. Run it now to see what it makes.</p>
      </section>
    );
  }
  if (isOpenRun(run)) {
    return (
      <section className="task-section tone-active latest-open" aria-label="Running now">
        <StatusIcon tone="active" />
        <span>
          {run.status === "queued" ? "Waiting for a run slot" : "Running now"}
          <span className="muted">, started {relativeTime(run.startedAt)}</span>
        </span>
      </section>
    );
  }
  return (
    <section className="task-section" aria-label="Latest result">
      <div className="section-row">
        <h3 className="section-heading">Latest result</h3>
        <span className={`tone-${labelTone(run.label ?? "")} latest-label`}>
          <StatusIcon tone={labelTone(run.label ?? "")} />
          {run.label} · {relativeTime(run.startedAt)}
        </span>
      </div>
      {run.resultPreview ? (
        <div
          className="out-md latest-preview"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify in renderMarkdown
          dangerouslySetInnerHTML={{ __html: renderMarkdown(run.resultPreview) }}
        />
      ) : (
        <p className="muted">{run.error ?? "This run left no result."}</p>
      )}
      <button type="button" className="btn btn-sm" onClick={() => onOpenRun(run)}>
        Open the result
      </button>
    </section>
  );
}

/** The last few runs, each opening its result; the full history is a link away. */
function RecentRuns({
  runs,
  runsError,
  stats,
  onOpenRun,
  onSeeAll,
}: {
  runs: TaskRun[] | null;
  runsError: string | null;
  stats: TaskStats | null;
  onOpenRun: (run: TaskRun) => void;
  onSeeAll: () => void;
}) {
  return (
    <section className="task-section" aria-labelledby="task-runs">
      <div className="section-row">
        <h3 className="section-heading" id="task-runs">
          Recent runs
        </h3>
        {stats && stats.runs > 0 && (
          <span className="muted">
            {formatPercent(stats.passRate)} passed · {formatUsd(stats.costUsd)} in 30 days
          </span>
        )}
      </div>
      {runsError && <div className="error-banner">{runsError}</div>}
      {!runs && !runsError && <div className="skel skel-row" aria-busy="true" />}
      {runs && runs.length === 0 && <p className="muted">No runs yet.</p>}
      {runs && runs.length > 0 && (
        <ul className="task-runs">
          {runs.slice(0, RECENT_RUNS).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className={`task-run tone-${labelTone(r.label ?? "")}`}
                onClick={() => onOpenRun(r)}
              >
                <StatusIcon tone={labelTone(r.label ?? "")} />
                <span className="task-run-label">{r.label ?? r.status}</span>
                <span className="muted">{formatWhen(r.startedAt)}</span>
                <span className="muted num">
                  {r.completedAt ? formatDuration(r.startedAt, r.completedAt) : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {runs && runs.length > 0 && (
        <button type="button" className="link-btn" onClick={onSeeAll}>
          See all runs
        </button>
      )}
    </section>
  );
}

/** What the page shows below its head, from what was read. */
export function TaskPageBody({
  detail,
  health,
  stats,
  runs,
  runsError,
  actions,
}: {
  detail: TaskDetail;
  health: TaskHealth;
  stats: TaskStats | null;
  runs: TaskRun[] | null;
  runsError: string | null;
  actions: TaskPageActions;
}) {
  const latest = runs?.[0];
  const reasonRun = health.runId ? runs?.find((r) => r.id === health.runId) : undefined;
  return (
    <>
      {health.needsYou && (
        <div className={`callout tone-${health.tone}`} role="status">
          <StatusIcon tone={health.tone} />
          <span>{health.reason}</span>
          {reasonRun && reasonRun.id !== latest?.id && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => actions.onOpenRun(reasonRun)}
            >
              Open the run
            </button>
          )}
        </div>
      )}
      <LatestRun run={latest} onOpenRun={actions.onOpenRun} />
      <RecentRuns
        runs={runs}
        runsError={runsError}
        stats={stats}
        onOpenRun={actions.onOpenRun}
        onSeeAll={() => actions.onSeeRuns(detail)}
      />
      <SetupSections d={detail} onEdit={() => actions.onEdit(detail)} />
    </>
  );
}

type ToolCall = (args: Record<string, unknown>) => Promise<{ data?: unknown }>;

/** A task's figures and recent runs; each is optional, so a failure of one leaves the other. */
async function readRecent(
  stats: ToolCall,
  runs: ToolCall,
  taskId: string,
): Promise<{ stats: TaskStats | null; runs: TaskRun[] | null; runsError: string | null }> {
  const [s, r] = await Promise.allSettled([
    stats({ taskId }),
    runs({ taskId, limit: 20, excludeBatchRuns: true }),
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

/** The page's health: the list's rules, with a run in flight read from the task's own runs. */
export function taskHealth(
  summary: TaskSummary | undefined,
  detail: TaskDetail,
  stats: TaskStats | null,
  runs: TaskRun[] | null,
): TaskHealth {
  const latest = runs?.[0];
  const live =
    latest && isOpenRun(latest)
      ? {
          taskId: detail.id,
          runId: latest.id,
          startedAt: latest.startedAt,
          state: latest.status === "queued" ? ("queued" as const) : ("running" as const),
        }
      : undefined;
  const task: TaskSummary = summary ?? {
    id: detail.id,
    name: detail.name,
    schedule: detail.scheduleHuman,
    scheduleType: hasLiveTrigger(detail) ? "cron" : "none",
    enabled: detail.enabled,
    source: detail.source,
    runCount: detail.runCount,
    lastRunStatus: detail.lastRunStatus,
    lastRunAt: detail.lastRunAt,
    nextRunAt: detail.nextRunAt,
    consecutiveErrors: detail.consecutiveErrors,
    disabledReason: detail.disabledReason,
    onceDone: detail.onceDone,
  };
  return healthOf(task, stats ?? undefined, live);
}

/**
 * A task's page: what needs doing, its latest result and recent runs, then
 * its setup behind disclosures.
 */
export function TaskPage({
  taskName,
  summary,
  refreshKey,
  busy,
  actions,
  onBack,
}: {
  taskName: string;
  /** The task's row from the list, when it has one. */
  summary?: TaskSummary;
  refreshKey: number;
  busy?: string;
  actions: TaskPageActions;
  onBack: () => void;
}) {
  const hostShowsTrail = useContext(HostTrailContext);
  const statusTool = useTool<string>("status");
  const statsTool = useTool<string>("stats");
  const runsTool = useTool<string>("runs");
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
        const o = await readRecent(statsTool.call, runsTool.call, d.id);
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

  // A run in flight changes the page when it ends; poll until it does.
  const live = runs?.[0] && isOpenRun(runs[0]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tool calls are stable
  useEffect(() => {
    if (!live || !detail) return;
    const timer = setInterval(() => {
      void readRecent(statsTool.call, runsTool.call, detail.id).then((o) => {
        setStats(o.stats);
        setRuns(o.runs);
        setRunsError(o.runsError);
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [live, detail]);

  const d = detail;
  async function setEnabled(v: boolean) {
    if (!d) return;
    setToggling(true);
    try {
      await actions.onSetEnabled(d, v);
      setDetail({ ...d, enabled: v });
    } finally {
      setToggling(false);
    }
  }
  const health = d ? taskHealth(summary, d, stats, runs) : null;
  const latest = runs?.[0];

  return (
    <div className="app">
      <header className="task-head">
        {!hostShowsTrail && (
          <div className="task-title-row">
            <button type="button" className="back-btn" onClick={onBack} aria-label="Back">
              ←
            </button>
            <h1 className="page-title">{d?.name ?? taskName}</h1>
          </div>
        )}
        {d && health && (
          <>
            <div className="screen-sub">
              <span className={`health-pill tone-${health.tone}`}>
                <StatusIcon tone={health.tone} />
                {health.word}
              </span>
              <span>{statusLine(d, latest)}</span>
            </div>
            <div className="task-actions">
              {latest && isOpenRun(latest) ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => actions.onOpenRun(latest)}
                >
                  Watch
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!!busy}
                  onClick={() => actions.onRunNow(d)}
                >
                  {busy === "running" ? "Starting…" : "Run now"}
                </button>
              )}
              {hasLiveTrigger(d) && (
                <EnabledSwitch
                  enabled={d.enabled}
                  busy={toggling}
                  onChange={(v) => void setEnabled(v)}
                />
              )}
              <RowMenu
                label={`More actions for ${d.name}`}
                items={taskMenuItems({
                  runList: () => actions.onRunList(d),
                  edit: () => actions.onEdit(d),
                  duplicate: () => actions.onDuplicate(d),
                  remove: () => actions.onDelete(d),
                })}
              />
            </div>
          </>
        )}
      </header>
      <main className="content task-body">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {!d && !error && (
          <div className="loading-list" aria-busy="true">
            <div className="skel skel-row" />
            <div className="skel skel-card" />
          </div>
        )}
        {d && health && (
          <TaskPageBody
            detail={d}
            health={health}
            stats={stats}
            runs={runs}
            runsError={runsError}
            actions={actions}
          />
        )}
      </main>
    </div>
  );
}
