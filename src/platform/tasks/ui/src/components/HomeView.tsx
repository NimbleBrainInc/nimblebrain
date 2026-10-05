import { useCallback, useEffect, useState } from "react";
import { StatusIcon } from "../icons.tsx";
import { byUrgency, headline, healthOf, type TaskHealth } from "../lib/attention.ts";
import type { TaskStats, TaskSummary, UpcomingData, UpcomingFire, UpcomingRun } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatWhen, relativeTime, toolErrorText } from "../utils.ts";
import { SkeletonRows } from "./Skeleton.tsx";
import { TEMPLATES, type Template } from "./templates.ts";

/** How often the list re-reads while open: runs start and end without a data change. */
const REFRESH_MS = 15_000;
/** Scheduled runs shown under "Coming up"; the rest are a link away. */
const COMING_UP = 4;

export interface HomeActions {
  onOpenTask: (task: TaskSummary) => void;
  onOpenRun: (taskId: string, runId: string) => void;
  onCreate: (template?: Template) => void;
  onSeeUpcoming: () => void;
  onSeeActivity: () => void;
}

/** A task with its health, as the list draws it. */
export interface HomeRow {
  task: TaskSummary;
  name: string;
  health: TaskHealth;
  live?: UpcomingRun;
}

/** Each task's health from its figures and any run of it in flight. */
export function homeRows(
  tasks: TaskSummary[],
  stats: Map<string, TaskStats> | null,
  upcoming: UpcomingData | null,
): HomeRow[] {
  const live = new Map<string, UpcomingRun>();
  // A batch's runs are the batch's, not the task's own state.
  for (const r of [...(upcoming?.queued ?? []), ...(upcoming?.running ?? [])]) {
    if (!r.batchId) live.set(r.taskId, r);
  }
  return tasks.map((task) => ({
    task,
    name: task.name,
    live: live.get(task.id),
    health: healthOf(task, stats?.get(task.id), live.get(task.id)),
  }));
}

/** The right-hand note on a list row: when it runs next, or when it last ran. */
function whenNote(row: HomeRow, stats?: TaskStats): string {
  const { task, health } = row;
  if (health.word === "Running" && row.live?.startedAt) {
    return `Started ${relativeTime(row.live.startedAt)}`;
  }
  if (health.paused) return "Paused";
  if (task.nextRunAt && task.enabled) return `Next ${formatWhen(task.nextRunAt)}`;
  if (stats?.lastRun) return `Last ran ${relativeTime(stats.lastRun.startedAt)}`;
  return task.scheduleType === "none" ? "Runs when you start it" : "";
}

function AttentionCard({ row, actions }: { row: HomeRow; actions: HomeActions }) {
  const { task, health } = row;
  const runId = health.runId;
  return (
    <li className={`attn-card tone-${health.tone}`}>
      <span className="attn-icon">
        <StatusIcon tone={health.tone} />
      </span>
      <div className="attn-text">
        <button type="button" className="attn-name" onClick={() => actions.onOpenTask(task)}>
          {task.name}
        </button>
        <span className="attn-why">{health.reason}</span>
      </div>
      {runId ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => actions.onOpenRun(task.id, runId)}
        >
          Open the run
        </button>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => actions.onOpenTask(task)}>
          Open task
        </button>
      )}
    </li>
  );
}

function LiveRow({ row, actions }: { row: HomeRow; actions: HomeActions }) {
  const { task, live, health } = row;
  return (
    <li className={`live-row tone-${health.tone}`}>
      <StatusIcon tone={health.tone} />
      <span className="live-text">
        <button type="button" className="attn-name" onClick={() => actions.onOpenTask(task)}>
          {task.name}
        </button>{" "}
        <span className="muted">
          {live?.state === "queued"
            ? `is waiting for a run slot${live.position ? ` (${live.position} in line)` : ""}.`
            : `is running${live?.startedAt ? `, started ${relativeTime(live.startedAt)}` : ""}.`}
        </span>
      </span>
      {live?.runId && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => live.runId && actions.onOpenRun(task.id, live.runId)}
        >
          Watch
        </button>
      )}
    </li>
  );
}

function ComingUp({
  fires,
  rows,
  actions,
}: {
  fires: UpcomingFire[];
  rows: HomeRow[];
  actions: HomeActions;
}) {
  const byId = new Map(rows.map((r) => [r.task.id, r]));
  return (
    <section className="home-section" aria-labelledby="home-coming">
      <div className="section-row">
        <h2 className="section-heading" id="home-coming">
          Coming up
        </h2>
        <button type="button" className="link-btn" onClick={actions.onSeeUpcoming}>
          See everything coming up
        </button>
      </div>
      <ul className="coming-strip">
        {fires.map((f) => {
          const row = byId.get(f.taskId);
          const atRisk = row?.health.tone === "danger";
          return (
            <li key={`${f.taskId}-${f.at}`}>
              <button
                type="button"
                className="coming-slot"
                onClick={() => row && actions.onOpenTask(row.task)}
              >
                <time className="muted" dateTime={f.at}>
                  {formatWhen(f.at)}
                </time>
                <span className="coming-name">{f.taskName}</span>
                <span className={atRisk ? "coming-risk" : "muted"}>
                  {atRisk ? "Its last run failed" : f.schedule}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TaskRowItem({
  row,
  stats,
  onOpen,
}: {
  row: HomeRow;
  stats?: TaskStats;
  onOpen: () => void;
}) {
  const { task, health } = row;
  return (
    <li>
      <button type="button" className={`home-row tone-${health.tone}`} onClick={onOpen}>
        <StatusIcon tone={health.tone} />
        <span className="home-row-name">
          {task.name}
          <span className="sr-only">, {health.word}</span>
        </span>
        <span className="home-row-sched">{task.schedule}</span>
        <span className="home-row-when">{whenNote(row, stats)}</span>
      </button>
    </li>
  );
}

/** No tasks yet: what a task is, and templates to start from. */
function NoTasks({ onCreate }: { onCreate: (template?: Template) => void }) {
  return (
    <div className="empty-block">
      <h2 className="empty-state-title">No tasks yet</h2>
      <p className="empty-state-desc">
        A task is a prompt the agent carries out on its own: on a schedule, when an event arrives,
        or when you run it. Start from one of these, or from scratch.
      </p>
      <div className="template-grid">
        {TEMPLATES.map((t) => (
          <button
            type="button"
            key={t.id}
            className={`template-card${t.id === "custom" ? " dashed" : ""}`}
            onClick={() => onCreate(t)}
          >
            <span className="template-card-name">{t.name}</span>
            <span className="template-card-desc">{t.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The home with no tasks to list: loading, a read error, or none yet. */
function HomeEmpty({
  loading,
  error,
  onCreate,
}: {
  loading: boolean;
  error: string | null;
  onCreate: (template?: Template) => void;
}) {
  if (loading) {
    return (
      <div className="view-pad" aria-busy="true">
        <SkeletonRows count={4} />
      </div>
    );
  }
  return (
    <div className="view-pad">
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : (
        <NoTasks onCreate={onCreate} />
      )}
    </div>
  );
}

/** Tasks listed quietly: the rest under a heading, paused ones folded. */
function TaskLists({
  rest,
  paused,
  needsYou,
  stats,
  onOpen,
}: {
  rest: HomeRow[];
  paused: HomeRow[];
  needsYou: number;
  stats: Map<string, TaskStats> | null;
  onOpen: (r: HomeRow) => () => void;
}) {
  return (
    <>
      {rest.length > 0 && (
        <section className="home-section" aria-labelledby="home-all">
          <h2 className="section-heading" id="home-all">
            {needsYou > 0 ? "Everything else" : "Your tasks"}
          </h2>
          <ul className="home-rows">
            {rest.map((r) => (
              <TaskRowItem
                key={r.task.id}
                row={r}
                stats={stats?.get(r.task.id)}
                onOpen={onOpen(r)}
              />
            ))}
          </ul>
        </section>
      )}

      {paused.length > 0 && (
        <details className="home-section details">
          <summary className="section-heading">Paused ({paused.length})</summary>
          <ul className="home-rows">
            {paused.map((r) => (
              <TaskRowItem
                key={r.task.id}
                row={r}
                stats={stats?.get(r.task.id)}
                onOpen={onOpen(r)}
              />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * The panel's home: what needs you first, then what is running and coming
 * up, then every other task. Paused tasks and the full history sit one
 * click away.
 */
export function HomeBody({
  tasks,
  loading,
  error,
  stats,
  upcoming,
  readError,
  actions,
}: {
  tasks: TaskSummary[];
  loading: boolean;
  error: string | null;
  stats: Map<string, TaskStats> | null;
  upcoming: UpcomingData | null;
  /** The figures or the queue could not be read. */
  readError: string | null;
  actions: HomeActions;
}) {
  if (tasks.length === 0) {
    return <HomeEmpty loading={loading} error={error} onCreate={actions.onCreate} />;
  }

  const rows = homeRows(tasks, stats, upcoming);
  const needsYou = byUrgency(rows.filter((r) => r.health.needsYou));
  const live = rows.filter((r) => r.live);
  const paused = rows.filter((r) => r.health.paused);
  const rest = rows.filter((r) => !r.health.needsYou && !r.health.paused);
  const fires = (upcoming?.scheduled ?? []).filter((f) => !f.beyondWindow).slice(0, COMING_UP);
  const open = (r: HomeRow) => () => actions.onOpenTask(r.task);

  return (
    <div className="view-pad home">
      {error && <div className="error-banner">{error}</div>}
      {readError && (
        <div className="note-banner">Some of what's below may be missing: {readError}</div>
      )}

      <div className="home-head">
        <div>
          <h2 className="home-headline">{headline(needsYou.length, rows.length)}</h2>
          {needsYou.length > 0 && rest.length > 0 && (
            <p className="muted">
              {rest.length} other {rest.length === 1 ? "task is" : "tasks are"} fine.
            </p>
          )}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => actions.onCreate()}>
          New task
        </button>
      </div>

      {needsYou.length > 0 && (
        <ul className="attn-list" aria-label="Needs you">
          {needsYou.map((r) => (
            <AttentionCard key={r.task.id} row={r} actions={actions} />
          ))}
        </ul>
      )}

      {live.length > 0 && (
        <ul className="live-list" aria-label="Running now">
          {live.map((r) => (
            <LiveRow key={r.task.id} row={r} actions={actions} />
          ))}
        </ul>
      )}

      {fires.length > 0 && <ComingUp fires={fires} rows={rows} actions={actions} />}

      <TaskLists
        rest={rest}
        paused={paused}
        needsYou={needsYou.length}
        stats={stats}
        onOpen={open}
      />

      <div className="home-foot">
        <button type="button" className="link-btn" onClick={actions.onSeeActivity}>
          See every run
        </button>
      </div>
    </div>
  );
}

/** The home list's container: reads the 30-day figures and the queue, and re-reads while open. */
export function HomeView({
  tasks,
  loading,
  error,
  refreshKey,
  actions,
}: {
  tasks: TaskSummary[];
  loading: boolean;
  error: string | null;
  /** Changes when the panel's data changed. */
  refreshKey: number;
  actions: HomeActions;
}) {
  const statsTool = useTool<string>("stats");
  const upcomingTool = useTool<string>("upcoming");
  const [stats, setStats] = useState<Map<string, TaskStats> | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingData | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tool calls are stable
  const load = useCallback(async () => {
    const [s, u] = await Promise.allSettled([statsTool.call({}), upcomingTool.call({ days: 7 })]);
    if (s.status === "fulfilled") {
      const list = (asDict(s.value.data).tasks as TaskStats[]) ?? [];
      setStats(new Map(list.map((x) => [x.taskId, x])));
    }
    if (u.status === "fulfilled") setUpcoming(asDict(u.value.data) as unknown as UpcomingData);
    const failed = [s, u].find((r) => r.status === "rejected");
    setReadError(failed?.status === "rejected" ? toolErrorText(failed.reason) : null);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the signal
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, refreshKey]);

  return (
    <HomeBody
      tasks={tasks}
      loading={loading}
      error={error}
      stats={stats}
      upcoming={upcoming}
      readError={readError}
      actions={actions}
    />
  );
}
