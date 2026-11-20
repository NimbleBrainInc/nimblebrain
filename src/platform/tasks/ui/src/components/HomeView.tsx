import { useCallback, useEffect, useId, useState } from "react";
import { StatusIcon } from "../icons.tsx";
import { byUrgency, headline, healthOf, type TaskHealth } from "../lib/attention.ts";
import { outcomeOf } from "../lib/outcome.ts";
import type { TaskRun, TaskStats, TaskSummary, UpcomingData, UpcomingRun } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatWhen, relativeTime, toolErrorText } from "../utils.ts";
import { PageHeader } from "./Chrome.tsx";
import { Section, Sections } from "./Section.tsx";
import { SkeletonRows } from "./Skeleton.tsx";
import { TEMPLATES, type Template } from "./templates.ts";

/** How often the queue is re-read while open: a run starts without a data change. */
const REFRESH_MS = 15_000;
/**
 * How often the 30-day figures are re-read while open with no data change: the
 * window moves with the clock, so a run leaves it without an announcement.
 */
export const STATS_REFRESH_MS = 60 * 60_000;
/** Runs drawn in each row's strip, oldest to newest. */
export const STRIP_RUNS = 10;
/** Runs read for the strips: enough for STRIP_RUNS each across a typical home. */
const STRIP_READ = 300;

export interface HomeActions {
  onOpenTask: (task: TaskSummary) => void;
  onOpenRun: (taskId: string, runId: string) => void;
  /** Open the form, empty or seeded from an example. */
  onCreate: (template?: Template) => void;
  /** Hand a sentence to the agent in chat; absent where the host takes no message. */
  onDescribe?: (sentence: string) => void;
  onSeeActivity: () => void;
}

/** A task with its health, as the list draws it. */
export interface HomeRow {
  task: TaskSummary;
  name: string;
  health: TaskHealth;
  live?: UpcomingRun;
  /** Its latest runs, oldest first, for the strip. */
  recent: TaskRun[];
}

/** Each task's health from its figures and any run of it in flight, with its latest runs. */
export function homeRows(
  tasks: TaskSummary[],
  stats: Map<string, TaskStats> | null,
  upcoming: UpcomingData | null,
  recent: Map<string, TaskRun[]> | null = null,
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
    recent: recent?.get(task.id) ?? [],
  }));
}

/** Runs grouped by task, newest STRIP_RUNS each, oldest first. */
export function recentByTask(runs: TaskRun[]): Map<string, TaskRun[]> {
  const out = new Map<string, TaskRun[]>();
  const newestFirst = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const r of newestFirst) {
    const list = out.get(r.taskId) ?? [];
    if (list.length < STRIP_RUNS) list.push(r);
    out.set(r.taskId, list);
  }
  for (const list of out.values()) list.reverse();
  return out;
}

/** The row's line in plain words: when it runs, and what happens next or happened last. */
export function rowLine(row: HomeRow, stats?: TaskStats): string {
  const { task, health, live } = row;
  const when = task.scheduleType === "none" ? "Only when you run it" : task.schedule;
  if (live?.state === "running") {
    return `${when} · running now${live.startedAt ? `, started ${relativeTime(live.startedAt)}` : ""}`;
  }
  if (live?.state === "queued") return `${when} · waiting to start`;
  if (health.paused) return `${when} · paused`;
  if (task.nextRunAt && task.enabled) return `${when} · next ${formatWhen(task.nextRunAt)}`;
  if (stats?.lastRun) return `${when} · last ran ${relativeTime(stats.lastRun.startedAt)}`;
  return when;
}

/** The last few runs as ticks, each in its outcome's tone, newest on the right. */
function RunStrip({ runs }: { runs: TaskRun[] }) {
  if (runs.length === 0) return <span className="run-strip" aria-hidden="true" />;
  const words = runs.map((r) => (r.label ? outcomeOf(r.label).word : r.status));
  return (
    <span
      className="run-strip"
      role="img"
      aria-label={`Last ${runs.length} runs: ${words.join(", ")}`}
    >
      {runs.map((r) => (
        <i
          key={r.id}
          className={`tick tone-${r.label ? outcomeOf(r.label).tone : "muted"}`}
          title={`${r.label ? outcomeOf(r.label).word : r.status} · ${relativeTime(r.startedAt)}`}
        />
      ))}
    </span>
  );
}

/** A task that needs a person: why, in words, and the one thing to do about it. */
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
          See what happened
        </button>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => actions.onOpenTask(task)}>
          Open
        </button>
      )}
    </li>
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
        <span className="home-row-text">
          <span className="home-row-name">
            {task.name}
            <span className="sr-only">, {health.word}</span>
          </span>
          <span className="home-row-line">{rowLine(row, stats)}</span>
        </span>
        <RunStrip runs={row.recent} />
      </button>
    </li>
  );
}

/**
 * Say what it should do, in a sentence: the agent sets it up in chat and shows
 * what it saved. Where the host takes no message, the sentence seeds the form.
 */
export function DescribeBox({
  onCreate,
  onDescribe,
  showExamples,
}: {
  onCreate: (template?: Template) => void;
  onDescribe?: (sentence: string) => void;
  showExamples: boolean;
}) {
  const id = useId();
  const canChat = !!onDescribe;
  const [text, setText] = useState("");

  function submit() {
    const sentence = text.trim();
    if (!sentence) return;
    if (onDescribe) {
      onDescribe(sentence);
    } else {
      onCreate({ id: "described", sentence, name: "", prompt: sentence, schedule: null });
    }
    setText("");
  }

  return (
    <div className="describe">
      <label className="describe-label" htmlFor={`${id}-say`}>
        What should run, and when?
      </label>
      {/* No <form>: the host's sandbox withholds allow-forms, so a submit is
          blocked before any handler runs. Enter and the button call `submit`. */}
      <div className="describe-box">
        <input
          id={`${id}-say`}
          className="describe-input"
          value={text}
          placeholder="Every weekday at 7am, summarize my unread email and post it in #team"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={submit}>
          Set it up
        </button>
      </div>
      {showExamples && (
        <ul className="describe-examples" aria-label="Examples">
          {TEMPLATES.map((t) => (
            <li key={t.id}>
              <button type="button" className="example-chip" onClick={() => setText(t.sentence)}>
                {t.sentence}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        {canChat ? "The agent sets it up in chat and shows you what it saved. " : ""}
        <button type="button" className="link-btn" onClick={() => onCreate()}>
          Fill in a form instead
        </button>
      </p>
    </div>
  );
}

/** The home with no tasks to list: loading, a read error, or none yet. */
function HomeEmpty({
  loading,
  error,
  onCreate,
  onDescribe,
}: {
  loading: boolean;
  error: string | null;
  onCreate: (template?: Template) => void;
  onDescribe?: (sentence: string) => void;
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
        <div className="empty-block">
          <h2 className="empty-state-title">Nothing scheduled yet</h2>
          <p className="empty-state-desc">
            The agent can do work for you on a schedule, or whenever something happens, and leave
            the result here.
          </p>
          <DescribeBox onCreate={onCreate} onDescribe={onDescribe} showExamples />
        </div>
      )}
    </div>
  );
}

function RowGroup({
  title,
  rows,
  stats,
  onOpen,
}: {
  title: string;
  rows: HomeRow[];
  stats: Map<string, TaskStats> | null;
  onOpen: (r: HomeRow) => () => void;
}) {
  if (rows.length === 0) return null;
  return (
    <Section title={title} aside={<span className="muted">{rows.length}</span>}>
      <ul className="home-rows">
        {rows.map((r) => (
          <TaskRowItem key={r.task.id} row={r} stats={stats?.get(r.task.id)} onOpen={onOpen(r)} />
        ))}
      </ul>
    </Section>
  );
}

/**
 * The home: one list in three groups. What needs you first, each with its
 * reason and one way forward; then what is active, each with when it runs and
 * its last few outcomes; then what is paused.
 */
export function HomeBody({
  tasks,
  loading,
  error,
  stats,
  upcoming,
  recent = null,
  readError,
  actions,
}: {
  tasks: TaskSummary[];
  loading: boolean;
  error: string | null;
  stats: Map<string, TaskStats> | null;
  upcoming: UpcomingData | null;
  /** Each task's latest runs, oldest first. */
  recent?: Map<string, TaskRun[]> | null;
  /** The figures or the queue could not be read. */
  readError: string | null;
  actions: HomeActions;
}) {
  const newTask = (
    <button type="button" className="btn btn-primary" onClick={() => actions.onCreate()}>
      New
    </button>
  );
  if (tasks.length === 0) {
    return (
      <>
        <PageHeader title="Scheduled" actions={newTask} />
        <main className="content">
          <HomeEmpty
            loading={loading}
            error={error}
            onCreate={actions.onCreate}
            onDescribe={actions.onDescribe}
          />
        </main>
      </>
    );
  }

  const rows = homeRows(tasks, stats, upcoming, recent);
  const needsYou = byUrgency(rows.filter((r) => r.health.needsYou));
  const paused = rows.filter((r) => r.health.paused);
  const active = rows.filter((r) => !r.health.needsYou && !r.health.paused);
  const open = (r: HomeRow) => () => actions.onOpenTask(r.task);

  return (
    <>
      <PageHeader title={headline(needsYou.length, rows.length)} actions={newTask} />
      <main className="content">
        <div className="view-pad home">
          <Sections>
            {error && <div className="error-banner">{error}</div>}
            {readError && (
              <div className="note-banner">Some of what's below may be missing: {readError}</div>
            )}

            {needsYou.length > 0 && (
              <Section title="Needs you" aside={<span className="muted">{needsYou.length}</span>}>
                <ul className="attn-list" aria-label="Needs you">
                  {needsYou.map((r) => (
                    <AttentionCard key={r.task.id} row={r} actions={actions} />
                  ))}
                </ul>
              </Section>
            )}

            <RowGroup title="Active" rows={active} stats={stats} onOpen={open} />
            <RowGroup title="Paused" rows={paused} stats={stats} onOpen={open} />

            <DescribeBox
              onCreate={actions.onCreate}
              onDescribe={actions.onDescribe}
              showExamples={false}
            />

            <div className="home-foot">
              <button type="button" className="link-btn" onClick={actions.onSeeActivity}>
                Every run, newest first
              </button>
            </div>
          </Sections>
        </div>
      </main>
    </>
  );
}

/**
 * The home's container: reads the 30-day figures, the queue, and each task's
 * latest runs when the data changes, and the queue and figures on timers.
 */
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
  const runsTool = useTool<string>("runs");
  const [stats, setStats] = useState<Map<string, TaskStats> | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingData | null>(null);
  const [recent, setRecent] = useState<Map<string, TaskRun[]> | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [upcomingError, setUpcomingError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await statsTool.call({});
      const list = (asDict(res.data).tasks as TaskStats[]) ?? [];
      setStats(new Map(list.map((x) => [x.taskId, x])));
      setStatsError(null);
    } catch (err) {
      setStatsError(toolErrorText(err));
    }
  }, [statsTool]);

  const loadUpcoming = useCallback(async () => {
    try {
      const res = await upcomingTool.call({ days: 7 });
      // `tasks__upcoming` answers JSON this package reads as `UpcomingData`, its
      // hand-kept mirror of `TasksUpcomingOutput`; nothing checks it at runtime.
      // biome-ignore lint/plugin/double-cast: tool JSON read as the hand-kept `UpcomingData` mirror
      setUpcoming(asDict(res.data) as unknown as UpcomingData);
      setUpcomingError(null);
    } catch (err) {
      setUpcomingError(toolErrorText(err));
    }
  }, [upcomingTool]);

  // The strips are decoration on rows the list already draws, so a failed
  // read leaves them empty rather than raising a banner.
  const loadRecent = useCallback(async () => {
    try {
      const res = await runsTool.call({ limit: STRIP_READ, excludeBatchRuns: true });
      setRecent(recentByTask((asDict(res.data).runs as TaskRun[]) ?? []));
    } catch {
      setRecent(null);
    }
  }, [runsTool]);

  // The figures count recorded runs, and every record, assessment and verdict
  // announces a data change, so that signal keeps them current. Counting 30
  // days of runs is the panel's costliest read, so the timer is hourly: it only
  // has to drop the runs that aged out of the window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` moves when the panel's data changes, which is when the stats are re-read at once
  useEffect(() => {
    void loadStats();
    const timer = setInterval(() => void loadStats(), STATS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadStats, refreshKey]);

  // A recorded run announces a data change, so that signal alone keeps the strips current.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` moves when the panel's data changes, which is when the runs are re-read
  useEffect(() => {
    void loadRecent();
  }, [loadRecent, refreshKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` moves when the panel's data changes, which is when the queue is re-read at once
  useEffect(() => {
    void loadUpcoming();
    const timer = setInterval(() => void loadUpcoming(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadUpcoming, refreshKey]);

  return (
    <HomeBody
      tasks={tasks}
      loading={loading}
      error={error}
      stats={stats}
      upcoming={upcoming}
      recent={recent}
      readError={statsError ?? upcomingError}
      actions={actions}
    />
  );
}
