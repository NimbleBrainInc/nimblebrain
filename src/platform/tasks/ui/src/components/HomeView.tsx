import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import {
  byUrgency,
  type HealthAction,
  headline,
  healthOf,
  type TaskHealth,
} from "../lib/attention.ts";
import { outcomeOf } from "../lib/outcome.ts";
import { shortSchedule } from "../lib/schedule-label.ts";
import type {
  TaskBatch,
  TaskRun,
  TaskStats,
  TaskSummary,
  UpcomingData,
  UpcomingRun,
} from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatWhen, relativeTime, toolErrorText } from "../utils.ts";
import { PageHeader } from "./Chrome.tsx";
import { RunsView } from "./RunsView.tsx";
import { SkeletonRows } from "./Skeleton.tsx";
import { TEMPLATES, type Template } from "./templates.ts";

/** How often the queue is re-read while open: a run starts without a data change. */
const REFRESH_MS = 15_000;
/**
 * How often the 30-day figures are re-read while open with no data change: the
 * window moves with the clock, so a run leaves it without an announcement.
 */
export const STATS_REFRESH_MS = 60 * 60_000;
/** Runs drawn in each row, oldest to newest. */
export const STRIP_RUNS = 14;

export interface HomeActions {
  onOpenTask: (task: TaskSummary) => void;
  onOpenRun: (taskId: string, runId: string) => void;
  /** Run it now: the way a failure is cleared. */
  onRunNow: (task: TaskSummary) => void;
  /** Turn its trigger on or off. */
  onSetEnabled: (task: TaskSummary, enabled: boolean) => Promise<void>;
  /** Open the form, empty or seeded from an example. */
  onCreate: (template?: Template) => void;
  /** Hand a sentence to the agent in chat; absent where the host takes no message. */
  onDescribe?: (sentence: string) => void;
  onSeeActivity: () => void;
  /** Open a batch from the Runs list. */
  onOpenBatch: (batch: TaskBatch) => void;
  /** Open a one-off's runs from the Runs list. */
  onOpenOneoff: (taskId: string, name: string) => void;
}

/** The page's two lists: what keeps running, and what ran once. */
export type HomeTab = "board" | "runs";

/** The switch between the board and the Runs list. */
function TabSwitch({ tab, onTab }: { tab: HomeTab; onTab: (t: HomeTab) => void }) {
  const tabs: { id: HomeTab; label: string }[] = [
    { id: "board", label: "Scheduled" },
    { id: "runs", label: "Runs" },
  ];
  return (
    <div className="tab-switch" role="tablist" aria-label="Show">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          className={tab === t.id ? "on" : ""}
          onClick={() => onTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** What starts a task: the board's filter. */
export type Trigger = "schedule" | "event" | "demand";

export function triggerOf(task: Pick<TaskSummary, "scheduleType">): Trigger {
  if (task.scheduleType === "event") return "event";
  if (!task.scheduleType || task.scheduleType === "none") return "demand";
  return "schedule";
}

/** A task with its health, as the board draws it. */
export interface HomeRow {
  task: TaskSummary;
  name: string;
  health: TaskHealth;
  live?: UpcomingRun;
  /** Its latest runs, oldest first. */
  recent: TaskRun[];
}

/** Each task's health from its figures, any run of it in flight, and its latest runs. */
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
  return tasks.map((task) => {
    const runs = recent?.get(task.id) ?? [];
    return {
      task,
      name: task.name,
      live: live.get(task.id),
      health: healthOf(task, stats?.get(task.id), live.get(task.id), runs),
      recent: runs,
    };
  });
}

/** Each task's newest runs as `tasks__stats` returns them, oldest first, as runs the strip draws. */
export function recentFromStats(list: TaskStats[]): Map<string, TaskRun[]> {
  const runs: TaskRun[] = list.flatMap((t) =>
    (t.recent ?? []).map((r) => ({
      id: r.id,
      taskId: t.taskId,
      status: r.label === "Failed" ? "failure" : "success",
      label: r.label,
      startedAt: r.startedAt,
      ...(r.error ? { error: r.error } : {}),
    })),
  );
  return recentByTask(runs);
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

/** "Tomorrow 9:00 AM" reads mid-sentence as "tomorrow 9:00 AM"; a day or date keeps its capital. */
function lowerFirst(text: string): string {
  return /^(Today|Tomorrow|Yesterday)\b/.test(text)
    ? text.charAt(0).toLowerCase() + text.slice(1)
    : text;
}

/**
 * The row's second line: the schedule in a few words, and the one fact worth
 * adding (running now, paused, next run, or for an on-demand task its last run).
 */
export function rowLine(row: HomeRow): string {
  const { task, health, live } = row;
  const when = shortSchedule(task.schedule);
  if (live?.state === "running") return `${when} · running now`;
  if (live?.state === "queued") return `${when} · waiting to start`;
  if (health.paused) return `${when} · paused`;
  if (task.nextRunAt && task.enabled)
    return `${when} · next ${lowerFirst(formatWhen(task.nextRunAt))}`;
  if (triggerOf(task) === "demand" && task.lastRunAt) {
    return `${when} · last ran ${relativeTime(task.lastRunAt)}`;
  }
  return when;
}

/** The button a problem row carries, by what clears it. */
const ACTION_LABEL: Record<HealthAction, string> = {
  retry: "Try again",
  "enable-and-retry": "Turn on and try again",
  review: "Review",
  "open-task": "See runs",
};

/** The latest runs as squares, oldest to newest, each in its outcome's tone; empty slots first. */
function RunCells({ runs }: { runs: TaskRun[] }) {
  const pad = Math.max(0, STRIP_RUNS - runs.length);
  const words = runs.map((r) => (r.label ? outcomeOf(r.label).word : r.status));
  return (
    <span
      className="run-cells"
      role="img"
      aria-label={runs.length ? `Last ${runs.length} runs: ${words.join(", ")}` : "No runs yet"}
    >
      {Array.from({ length: pad }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: empty slots have no identity but their place
        <i key={`pad-${i}`} className="cell empty" />
      ))}
      {runs.map((r) => (
        <i
          key={r.id}
          className={`cell tone-${r.label ? outcomeOf(r.label).tone : "muted"}`}
          title={`${r.label ? outcomeOf(r.label).word : r.status} · ${relativeTime(r.startedAt)}`}
        />
      ))}
    </span>
  );
}

/** A small on/off switch for a task's trigger. */
function TriggerSwitch({
  on,
  busy,
  name,
  onChange,
}: {
  on: boolean;
  busy: boolean;
  name: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${name} runs on its own`}
      title={on ? "On: it runs on its own" : "Off: it runs only when you run it"}
      className={`mini-switch${on ? " on" : ""}`}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    />
  );
}

function BoardRow({ row, actions }: { row: HomeRow; actions: HomeActions }) {
  const { task, health } = row;
  const [busy, setBusy] = useState(false);
  const trigger = triggerOf(task);
  const problem = health.needsYou && health.reason;

  async function toggle(on: boolean) {
    setBusy(true);
    try {
      await actions.onSetEnabled(task, on);
    } finally {
      setBusy(false);
    }
  }

  function act(action: HealthAction) {
    if (action === "retry") actions.onRunNow(task);
    else if (action === "enable-and-retry")
      void actions.onSetEnabled(task, true).then(() => actions.onRunNow(task));
    else if (action === "review" && health.runId) actions.onOpenRun(task.id, health.runId);
    else actions.onOpenTask(task);
  }

  return (
    <li
      className={`board-row tone-${health.paused ? "muted" : health.tone}${health.paused ? " is-off" : ""}`}
    >
      <span className={`light${health.paused ? " hollow" : ""}`} aria-hidden="true" />
      <div className="board-who">
        <button type="button" className="board-name" onClick={() => actions.onOpenTask(task)}>
          {task.name}
          <span className="sr-only">, {health.word}</span>
        </button>
        {problem ? (
          <span className="board-reason">
            <span className="board-reason-text" title={health.reason}>
              {health.reason}
            </span>
            {health.action && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => health.action && act(health.action)}
              >
                {ACTION_LABEL[health.action]}
              </button>
            )}
          </span>
        ) : (
          <span className="board-when" title={task.schedule}>
            {rowLine(row)}
          </span>
        )}
      </div>
      <RunCells runs={row.recent} />
      <span className="board-ctl">
        {trigger === "demand" ? (
          <button type="button" className="btn btn-sm" onClick={() => actions.onRunNow(task)}>
            Run
          </button>
        ) : (
          <TriggerSwitch on={task.enabled} busy={busy} name={task.name} onChange={toggle} />
        )}
      </span>
    </li>
  );
}

const FILTERS: { id: Trigger | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "schedule", label: "Scheduled" },
  { id: "event", label: "On events" },
  { id: "demand", label: "On demand" },
];

/**
 * Say what it should do, in a sentence: the agent sets it up in chat and shows
 * what it saved. Where the host takes no message, the sentence seeds the form.
 */
export function DescribeBox({
  onCreate,
  onDescribe,
  showExamples,
  compact = false,
}: {
  onCreate: (template?: Template) => void;
  onDescribe?: (sentence: string) => void;
  showExamples: boolean;
  /** Above a board: no heading, and the hint folded into the input's line. */
  compact?: boolean;
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
    <div className={`describe${compact ? " compact" : ""}`}>
      <label className={compact ? "sr-only" : "describe-label"} htmlFor={`${id}-say`}>
        What should run, and when?
      </label>
      {/* No <form>: the host's sandbox withholds allow-forms, so a submit is
          blocked before any handler runs. Enter and the button call `submit`. */}
      <div className="describe-box">
        <input
          id={`${id}-say`}
          className="describe-input"
          value={text}
          placeholder={
            compact
              ? "Schedule something new: “every Monday at 8, review the pipeline and email me”"
              : "Every weekday at 7am, summarize my unread email and post it in #team"
          }
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
      {!compact && (
        <p className="hint">
          {canChat ? "The agent sets it up in chat and shows you what it saved. " : ""}
          <button type="button" className="link-btn" onClick={() => onCreate()}>
            Fill in a form instead
          </button>
        </p>
      )}
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

/**
 * The board: one row per task, worst first. Each row has a light, its name,
 * its schedule in a few words, its latest runs as squares, and its switch
 * (Run for an on-demand task). A row that needs you says why on its second
 * line, with the one action that clears it.
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
  tab = "board",
  onTab = () => {},
  runs,
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
  tab?: HomeTab;
  onTab?: (t: HomeTab) => void;
  /** The Runs list, drawn in place of the board when its tab is on. */
  runs?: ReactNode;
}) {
  const [filter, setFilter] = useState<Trigger | "all">("all");
  const newTask = (
    <button type="button" className="btn btn-primary" onClick={() => actions.onCreate()}>
      New
    </button>
  );
  if (tab === "runs") {
    return (
      <>
        <PageHeader title="Runs" actions={newTask} />
        <main className="content">
          <div className="view-pad home">
            <TabSwitch tab={tab} onTab={onTab} />
            {runs}
          </div>
        </main>
      </>
    );
  }
  if (tasks.length === 0) {
    return (
      <>
        <PageHeader title="Scheduled" actions={newTask} />
        <main className="content">
          {!loading && (
            <div className="view-pad">
              <TabSwitch tab={tab} onTab={onTab} />
            </div>
          )}
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

  const rows = byUrgency(homeRows(tasks, stats, upcoming, recent));
  const needsYou = rows.filter((r) => r.health.needsYou).length;
  const count = (id: Trigger | "all") =>
    id === "all" ? rows.length : rows.filter((r) => triggerOf(r.task) === id).length;
  const shown = filter === "all" ? rows : rows.filter((r) => triggerOf(r.task) === filter);

  return (
    <>
      <PageHeader title={headline(needsYou, rows.length)} actions={newTask} />
      <main className="content">
        <div className="view-pad home">
          {error && <div className="error-banner">{error}</div>}
          {readError && (
            <div className="note-banner">Some of what's below may be missing: {readError}</div>
          )}
          <TabSwitch tab={tab} onTab={onTab} />
          <DescribeBox
            onCreate={actions.onCreate}
            onDescribe={actions.onDescribe}
            showExamples={false}
            compact
          />
          <div className="board-bar">
            <fieldset className="board-filters">
              <legend className="sr-only">Show</legend>
              {FILTERS.filter((f) => f.id === "all" || count(f.id) > 0).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`filter-chip${filter === f.id ? " on" : ""}`}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label} <span className="muted">{count(f.id)}</span>
                </button>
              ))}
            </fieldset>
            <span className="board-legend muted" aria-hidden="true">
              Last {STRIP_RUNS} runs →
            </span>
          </div>
          <ul className="board" aria-label="Scheduled tasks">
            {shown.map((r) => (
              <BoardRow key={r.task.id} row={r} actions={actions} />
            ))}
          </ul>
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
  tab,
  onTab,
}: {
  tasks: TaskSummary[];
  loading: boolean;
  error: string | null;
  /** Changes when the panel's data changed. */
  refreshKey: number;
  actions: HomeActions;
  /** Kept by the panel, so a page opened from Runs comes back to Runs. */
  tab: HomeTab;
  onTab: (t: HomeTab) => void;
}) {
  const statsTool = useTool<string>("stats");
  const upcomingTool = useTool<string>("upcoming");
  const [stats, setStats] = useState<Map<string, TaskStats> | null>(null);
  // The strips come with the figures (`tasks__stats` returns each task's
  // newest runs), so drawing them costs no read of its own.
  const [recent, setRecent] = useState<Map<string, TaskRun[]> | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingData | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [upcomingError, setUpcomingError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await statsTool.call({});
      const list = (asDict(res.data).tasks as TaskStats[]) ?? [];
      setStats(new Map(list.map((x) => [x.taskId, x])));
      setRecent(recentFromStats(list));
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
      tab={tab}
      onTab={onTab}
      runs={
        tab === "runs" ? (
          <RunsView
            saved={tasks}
            refreshKey={refreshKey}
            onOpenBatch={actions.onOpenBatch}
            onOpenOneoff={actions.onOpenOneoff}
            onSeeActivity={actions.onSeeActivity}
          />
        ) : null
      }
    />
  );
}
