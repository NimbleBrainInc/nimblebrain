import { type ReactNode, useEffect, useState } from "react";
import { StatusIcon } from "../icons.tsx";
import { healthOf, type TaskHealth } from "../lib/attention.ts";
import { askMessage } from "../lib/needs-you.ts";
import { inputSummary, runTime } from "../lib/plain.ts";
import { readResult } from "../lib/runResult.ts";
import type { TaskDetail, TaskRun, TaskRunResult, TaskStats, TaskSummary } from "../types.ts";
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
import { PageHeader } from "./Chrome.tsx";
import { FixActions } from "./NeedsYou.tsx";
import { STATS_REFRESH_MS } from "./HomeView.tsx";
import { isOpenRun } from "./ResultView.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { RunBadge, StatusBadge } from "./RunBadge.tsx";
import { Section, Sections, SummaryStrip, type Tile } from "./Section.tsx";
import { ResultPreview, readsStructured } from "./StructuredView.tsx";

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
  if (last) parts.push(`last run ${relativeTime(last.startedAt)}`);
  if (d.consecutiveErrors && d.consecutiveErrors > 0) {
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
  /** Resolves whether it saved; a failure is already shown to the viewer. */
  onSetEnabled: (d: TaskDetail, enabled: boolean) => Promise<boolean>;
  onOpenRun: (run: TaskRun) => void;
  onSeeRuns: (d: TaskDetail) => void;
  /** Hand a message to the agent in chat; absent where the host takes no message. */
  onAsk?: (message: string) => void;
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
      title="Whether it runs on its own. Run now works either way."
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      On
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
      {d.skills?.length ? (
        <p>
          Carries out {d.skills.length === 1 ? "the skill" : "the skills"}{" "}
          {d.skills.map((s, i) => (
            <span key={s}>
              {i > 0 && ", "}
              <code>{s}</code>
            </span>
          ))}
          .
        </p>
      ) : null}
      {d.prompt && <p className="prose">{d.prompt}</p>}
      {!d.prompt && !d.skills?.length && <p className="muted">No prompt.</p>}
      {d.inputSchema && (
        <>
          <h3 className="sub-heading">Input</h3>
          <JsonBlock value={d.inputSchema} />
        </>
      )}
    </Disclosure>
  );
}

function GoodSection({ d }: { d: TaskDetail }) {
  return (
    <Disclosure
      title="What good looks like"
      hint={d.outputSchema ? "An output schema" : "Not checked"}
    >
      {!d.outputSchema && <p className="muted">No output schema: runs are not assessed.</p>}
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
    <Disclosure title="About">
      <dl className="def-list">
        <Row label="Tokens used">
          {formatTokens(d.cumulativeInputTokens)} in · {formatTokens(d.cumulativeOutputTokens)} out
        </Row>
        {d.createdAt && <Row label="Created">{new Date(d.createdAt).toLocaleString()}</Row>}
        {d.updatedAt && <Row label="Updated">{new Date(d.updatedAt).toLocaleString()}</Row>}
        <Row label="Id">
          <code>{d.id}</code>
        </Row>
      </dl>
    </Disclosure>
  );
}

/** The task's setup and figures, read-only, each part behind a closed disclosure. */
export function SetupSections({
  d,
  onEdit,
  figures,
}: {
  d: TaskDetail;
  onEdit?: () => void;
  /** The 30-day figures, shown as their own disclosure. */
  figures?: ReactNode;
}) {
  return (
    <Section
      title="Details"
      aside={
        onEdit && (
          <button type="button" className="btn btn-sm" onClick={onEdit}>
            Edit
          </button>
        )
      }
    >
      <div className="setup">
        <DoesSection d={d} />
        <GoodSection d={d} />
        <LimitsSection d={d} />
        {figures && (
          <Disclosure title="Last 30 days" hint="Runs, pass rate and cost">
            {figures}
          </Disclosure>
        )}
        <DetailsSection d={d} />
      </div>
    </Section>
  );
}

/**
 * The latest result's body once read: structured output as values, text as
 * prose, why the run left none, or why it could not be read.
 */
function LatestBody({
  run,
  result,
  error,
  raw,
}: {
  run: TaskRun;
  result: TaskRunResult | null | undefined;
  error?: string;
  raw: boolean;
}) {
  if (error !== undefined) {
    return (
      <div className="error-banner" role="alert">
        {error || "This run's result could not be read."}
      </div>
    );
  }
  if (result === undefined) return <div className="skel skel-card" aria-busy="true" />;
  const text = result?.output ?? "";
  if (result?.structured !== undefined || text) {
    return <ResultPreview structured={result?.structured} text={text} raw={raw} />;
  }
  return <p className="muted">{run.error ?? "This run left no result."}</p>;
}

/** The latest result as a section: its label and time, Show raw and Open the run in the header. */
function LatestRun({
  run,
  result,
  error,
  onOpenRun,
}: {
  run?: TaskRun;
  /** The latest run's full result: undefined while it loads, null when the run left none. */
  result: TaskRunResult | null | undefined;
  /** Why the result could not be read, when it could not. */
  error?: string;
  onOpenRun: (run: TaskRun) => void;
}) {
  const [raw, setRaw] = useState(false);
  if (!run) {
    return (
      <Section title="Latest result">
        <p className="muted">No runs yet. Run it now to see what it makes.</p>
      </Section>
    );
  }
  if (isOpenRun(run)) {
    return (
      <Section
        title="Latest result"
        aside={
          <button type="button" className="btn btn-sm" onClick={() => onOpenRun(run)}>
            Watch
          </button>
        }
      >
        <p className="latest-open">
          <StatusBadge
            tone="active"
            label={run.execution === "queued" ? "Waiting for a run slot" : "Running now"}
          />
          <span className="muted">started {relativeTime(run.startedAt)}</span>
        </p>
      </Section>
    );
  }
  const structured = !!result && readsStructured(result.structured, result.output);
  return (
    <Section
      title="Latest result"
      aside={
        <>
          <RunBadge label={run.label} />
          <span className="muted">{runTime(run.startedAt)}</span>
          {structured && (
            <button
              type="button"
              className="btn btn-sm"
              aria-pressed={raw}
              onClick={() => setRaw(!raw)}
            >
              {raw ? "Show values" : "Show raw"}
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => onOpenRun(run)}>
            Open the run
          </button>
        </>
      }
    >
      <LatestBody run={run} result={result} error={error} raw={raw} />
    </Section>
  );
}

/** The runs before the latest, each with its outcome and the start of what it made; the full history is a link away. */
function RecentRuns({
  runs,
  runsError,
  inputSchema,
  onOpenRun,
  onSeeAll,
}: {
  runs: TaskRun[] | null;
  runsError: string | null;
  /** The task's input schema, to name each run by its input. */
  inputSchema?: Record<string, unknown>;
  onOpenRun: (run: TaskRun) => void;
  onSeeAll: () => void;
}) {
  return (
    <Section
      title="Earlier results"
      aside={
        runs && runs.length > 1 ? (
          <button type="button" className="btn btn-sm" onClick={onSeeAll}>
            Every run
          </button>
        ) : undefined
      }
    >
      {runsError && <div className="error-banner">{runsError}</div>}
      {!runs && !runsError && <div className="skel skel-row" aria-busy="true" />}
      {runs && runs.length <= 1 && <p className="muted">Nothing earlier yet.</p>}
      {runs && runs.length > 1 && (
        <ul className="task-runs">
          {runs.slice(1, RECENT_RUNS + 1).map((r) => {
            const input = inputSummary(r.input, inputSchema);
            const said = r.resultPreview?.trim() || r.error;
            return (
              <li key={r.id}>
                <button type="button" className="task-run" onClick={() => onOpenRun(r)}>
                  <span className="task-run-what">
                    <RunBadge label={r.label} />
                    {input && <span className="task-run-input">{input}</span>}
                    {said && <span className="task-run-said">{said}</span>}
                  </span>
                  <span className="muted">{runTime(r.startedAt)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** When the task runs next, in a word or two. */
function nextRunText(d: TaskDetail): string {
  if (!hasLiveTrigger(d)) return "Manual only";
  if (!d.enabled) return "Off";
  return d.nextRunAt ? formatWhen(d.nextRunAt) : "Not scheduled";
}

/** The 30-day tiles: pass rate and cost. */
function statsTiles(stats: TaskStats | null): Tile[] {
  if (!stats) {
    return [
      { id: "runs", label: "Runs, 30 days", value: "…" },
      { id: "pass", label: "Pass rate, 30 days", value: "…" },
      { id: "cost", label: "Cost, 30 days", value: "…" },
    ];
  }
  const decided = stats.pass + stats.fail;
  return [
    {
      id: "runs",
      label: "Runs, 30 days",
      value: String(stats.runs),
      sub: `${stats.pass} passed · ${stats.fail} failed`,
    },
    {
      id: "pass",
      label: "Pass rate, 30 days",
      value: formatPercent(stats.passRate),
      sub: decided > 0 ? `${stats.pass} of ${decided} checked` : "Nothing checked yet",
    },
    {
      id: "cost",
      label: "Cost, 30 days",
      value: formatUsd(stats.costUsd),
      sub:
        stats.runs > 0 && stats.costUsd !== undefined
          ? `${formatUsd(stats.costUsd / stats.runs)} a run`
          : undefined,
    },
  ];
}

/** The task's report card: runs, pass rate, cost, next run, last run. */
export function TaskSummaryStrip({
  detail,
  stats,
  last,
}: {
  detail: TaskDetail;
  stats: TaskStats | null;
  last?: TaskRun;
}) {
  const tiles: Tile[] = [
    ...statsTiles(stats),
    {
      id: "next",
      label: "Next run",
      value: nextRunText(detail),
      sub: hasLiveTrigger(detail) ? detail.scheduleHuman : undefined,
    },
    {
      id: "last",
      label: "Last run",
      value: last ? runTime(last.startedAt) : "Never",
      sub: last?.label,
    },
  ];
  return <SummaryStrip tiles={tiles} label="Task summary" />;
}

/** What the page shows below its head, from what was read. */
export function TaskPageBody({
  detail,
  health,
  stats,
  runs,
  runsError,
  latestResult,
  latestError,
  actions,
}: {
  detail: TaskDetail;
  health: TaskHealth;
  stats: TaskStats | null;
  runs: TaskRun[] | null;
  runsError: string | null;
  /** The latest run's full result: undefined while it loads, null when the run left none. */
  latestResult?: TaskRunResult | null;
  /** Why the latest run's result could not be read, when it could not. */
  latestError?: string;
  actions: TaskPageActions;
}) {
  const latest = runs?.[0];
  const reasonRun = health.runId ? runs?.find((r) => r.id === health.runId) : undefined;
  return (
    <Sections>
      {health.needsYou && (
        <div className={`callout tone-${health.tone}`} role="status">
          <StatusIcon tone={health.tone} />
          <span>{health.reason}</span>
          {health.action === "edit" && (
            <FixActions
              onEdit={() => actions.onEdit(detail)}
              onAsk={
                actions.onAsk && health.runId && health.reason
                  ? () =>
                      actions.onAsk?.(
                        askMessage(detail, { id: health.runId ?? "" }, health.reason ?? ""),
                      )
                  : undefined
              }
            />
          )}
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
      <LatestRun
        run={latest}
        result={latestResult}
        error={latestError}
        onOpenRun={actions.onOpenRun}
      />
      <RecentRuns
        runs={runs}
        runsError={runsError}
        inputSchema={detail.inputSchema}
        onOpenRun={actions.onOpenRun}
        onSeeAll={() => actions.onSeeRuns(detail)}
      />
      <SetupSections
        d={detail}
        onEdit={() => actions.onEdit(detail)}
        figures={<TaskSummaryStrip detail={detail} stats={stats} last={latest} />}
      />
    </Sections>
  );
}

type ToolCall = (args: Record<string, unknown>) => Promise<{ data?: unknown }>;

/** A task's recent runs, or why they could not be read. */
async function readRecentRuns(
  runs: ToolCall,
  taskId: string,
): Promise<{ runs: TaskRun[] | null; runsError: string | null }> {
  try {
    const res = await runs({ taskId, limit: 20, excludeBatchRuns: true });
    return { runs: (asDict(res.data).runs as TaskRun[]) ?? [], runsError: null };
  } catch (err) {
    return { runs: null, runsError: toolErrorText(err) };
  }
}

/** A task's 30-day figures, or null when they could not be read. */
function readStats(stats: ToolCall, taskId: string): Promise<TaskStats | null> {
  return stats({ taskId }).then(
    (res) => ((asDict(res.data).tasks as TaskStats[]) ?? [])[0] ?? null,
    () => null,
  );
}

/** A task's figures and recent runs; each is optional, so a failure of one leaves the other. */
async function readRecent(
  stats: ToolCall,
  runs: ToolCall,
  taskId: string,
): Promise<{ stats: TaskStats | null; runs: TaskRun[] | null; runsError: string | null }> {
  const [s, r] = await Promise.all([readStats(stats, taskId), readRecentRuns(runs, taskId)]);
  return { stats: s, ...r };
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
          state: latest.execution === "queued" ? ("queued" as const) : ("running" as const),
        }
      : undefined;
  const task: TaskSummary = summary ?? {
    id: detail.id,
    name: detail.name,
    scheduleHuman: detail.scheduleHuman,
    scheduleType: hasLiveTrigger(detail) ? "cron" : "none",
    enabled: detail.enabled,
    runCount: detail.runCount,
    lastRunLabel: detail.lastRunLabel,
    lastRunAt: detail.lastRunAt,
    nextRunAt: detail.nextRunAt,
    disabledReason: detail.disabledReason,
    onceDone: detail.onceDone,
  };
  return healthOf(task, stats ?? undefined, live, runs ?? [], detail.allowedTools);
}

/** The task page's actions: the Enabled switch for a task with a trigger, Run now or Watch, the menu. */
function TaskActions({
  d,
  latest,
  busy,
  toggling,
  actions,
  onSetEnabled,
}: {
  d: TaskDetail;
  latest?: TaskRun;
  busy?: string;
  toggling: boolean;
  actions: TaskPageActions;
  onSetEnabled: (v: boolean) => void;
}) {
  return (
    <>
      {hasLiveTrigger(d) && (
        <EnabledSwitch enabled={d.enabled} busy={toggling} onChange={onSetEnabled} />
      )}
      {latest && isOpenRun(latest) ? (
        <button type="button" className="btn btn-primary" onClick={() => actions.onOpenRun(latest)}>
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
  );
}

/**
 * A scheduled task's page: what needs doing, then what it made (the latest
 * result, then earlier ones), then its setup and figures behind disclosures.
 */
export function TaskPage({
  taskId,
  summary,
  refreshKey,
  busy,
  actions,
  onBack,
}: {
  taskId: string;
  /** The task's row from the list, when it has one. */
  summary?: TaskSummary;
  refreshKey: number;
  busy?: string;
  actions: TaskPageActions;
  onBack: () => void;
}) {
  const resultTool = useTool<string>("run_result");
  /** undefined while it loads; null when the run left none. */
  const [latestResult, setLatestResult] = useState<TaskRunResult | null | undefined>(undefined);
  const [latestError, setLatestError] = useState<string | undefined>(undefined);
  const statusTool = useTool<string>("status");
  const statsTool = useTool<string>("stats");
  const runsTool = useTool<string>("runs");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` moves when the panel's data changes, which is when the task is re-read
  useEffect(() => {
    let cancelled = false;
    statusTool
      .call({ taskId, limit: 1 })
      .then(async (res) => {
        const d = asDict(res.data).task as TaskDetail | undefined;
        if (!d) throw new Error(`No task with id "${taskId}".`);
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
  }, [taskId, statusTool, statsTool, runsTool, refreshKey]);

  // The latest run's full result, for its preview: structured output when it has one.
  const latestId = runs?.[0] && !isOpenRun(runs[0]) ? runs[0].id : null;
  const detailId = detail?.id;
  useEffect(() => {
    setLatestResult(undefined);
    setLatestError(undefined);
    if (!latestId || !detailId) return;
    let cancelled = false;
    void readResult(resultTool.call, latestId).then((read) => {
      if (cancelled) return;
      setLatestResult(read.result);
      setLatestError(read.error);
    });
    return () => {
      cancelled = true;
    };
  }, [latestId, detailId, resultTool]);

  // A run in flight changes the page when it ends; poll its row until it does.
  // The 30-day figures are not part of this poll: a run recorded or assessed
  // announces a data change, which re-reads the page above.
  const live = runs?.[0] && isOpenRun(runs[0]);
  useEffect(() => {
    if (!live || !detailId) return;
    const timer = setInterval(() => {
      void readRecentRuns(runsTool.call, detailId).then((o) => {
        setRuns(o.runs);
        setRunsError(o.runsError);
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [live, detailId, runsTool]);

  // The figures' window moves with the clock, so a run leaves it without a data
  // change; an hourly read drops it.
  useEffect(() => {
    if (!detailId) return;
    const timer = setInterval(() => {
      void readStats(statsTool.call, detailId).then(setStats);
    }, STATS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [detailId, statsTool]);

  const d = detail;
  async function setEnabled(v: boolean) {
    if (!d) return;
    setToggling(true);
    try {
      if (await actions.onSetEnabled(d, v)) setDetail({ ...d, enabled: v });
    } finally {
      setToggling(false);
    }
  }
  const health = d ? taskHealth(summary, d, stats, runs) : null;
  const latest = runs?.[0];

  return (
    <div className="app">
      <PageHeader
        title={d?.name ?? summary?.name ?? taskId}
        onBack={onBack}
        status={
          d && health ? (
            <>
              <StatusBadge tone={health.tone} label={health.word} />
              <span>{statusLine(d, latest)}</span>
            </>
          ) : undefined
        }
        actions={
          d ? (
            <TaskActions
              d={d}
              latest={latest}
              busy={busy}
              toggling={toggling}
              actions={actions}
              onSetEnabled={(v) => void setEnabled(v)}
            />
          ) : undefined
        }
      />
      <main className="content page-body">
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
            latestResult={latestResult}
            latestError={latestError}
            actions={actions}
          />
        )}
      </main>
    </div>
  );
}
