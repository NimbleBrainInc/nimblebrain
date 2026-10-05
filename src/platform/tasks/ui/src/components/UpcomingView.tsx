import { useCallback, useEffect, useState } from "react";
import type { TaskBatch, UpcomingData, UpcomingRun } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatWhen, relativeTime, toolErrorText } from "../utils.ts";
import { SkeletonRows } from "./Skeleton.tsx";

/** How often the view re-reads while it is open: the queue moves without a data change. */
const REFRESH_MS = 15_000;

const TRIGGER_TEXT: Record<string, string> = {
  scheduled: "schedule",
  manual: "run now",
  event: "event",
};

/** What a queue entry is: its task, and its batch item or trigger. */
export function queueLine(run: UpcomingRun, batches: Map<string, TaskBatch>): string {
  const name = run.taskName ?? run.taskId;
  if (run.batchId) {
    const total = batches.get(run.batchId)?.items;
    const n = run.batchIndex !== undefined ? run.batchIndex + 1 : undefined;
    const item = n !== undefined ? ` · item ${n}${total ? `/${total}` : ""}` : "";
    return `${name} · batch ${run.batchId.slice(6, 10)}${item}`;
  }
  return run.trigger ? `${name} · ${TRIGGER_TEXT[run.trigger] ?? run.trigger}` : name;
}

export type WindowDays = 7 | 30;

/** A frequent schedule's row text: "every 5 min · 2,016 runs in the next 7 days". */
export function frequentLine(
  f: { schedule: string; count: number; countCapped?: boolean },
  days: number,
): string {
  const count = `${f.count.toLocaleString()}${f.countCapped ? "+" : ""}`;
  return `${f.schedule} · ${count} runs in the next ${days} days`;
}

/** Choose the window: the next 7 or 30 days. */
function WindowToggle({ days, onDays }: { days: WindowDays; onDays: (d: WindowDays) => void }) {
  return (
    <div className="segmented small" role="radiogroup" aria-label="Show the next">
      {([7, 30] as const).map((d) => (
        <label key={d} className={`seg${days === d ? " on" : ""}`}>
          <input type="radio" name="up-window" checked={days === d} onChange={() => onDays(d)} />
          {d} days
        </label>
      ))}
    </div>
  );
}

/** What runs next: the queue, then scheduled fires in time order, then event-fired tasks. */
export function UpcomingBody({
  data,
  loading,
  error,
  batches,
  days,
  onDays,
  onOpenRun,
  onOpenTask,
}: {
  data: UpcomingData | null;
  loading: boolean;
  error: string | null;
  batches: Map<string, TaskBatch>;
  days: WindowDays;
  onDays: (d: WindowDays) => void;
  onOpenRun: (run: UpcomingRun) => void;
  onOpenTask: (taskName: string) => void;
}) {
  if (!data && loading) {
    return (
      <div className="view-pad" aria-busy="true">
        <SkeletonRows count={4} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="view-pad">
        <div className="error-banner" role="alert">
          {error ?? "What runs next could not be read."}
        </div>
      </div>
    );
  }
  const { running, queued, scheduled, frequent, events } = data;
  const nothing =
    running.length === 0 &&
    queued.length === 0 &&
    scheduled.length === 0 &&
    frequent.length === 0 &&
    events.length === 0;
  return (
    <div className="view-pad upcoming">
      {error && <div className="error-banner">{error}</div>}
      {nothing && (
        <div className="empty-block">
          <h2 className="empty-state-title">Nothing is lined up</h2>
          <p className="empty-state-desc">
            No run is going or waiting, and no task has a schedule or an event trigger. Give a task
            a schedule in its editor, or run one now from Saved.
          </p>
        </div>
      )}

      {(running.length > 0 || queued.length > 0) && (
        <section aria-labelledby="up-queue">
          <h2 className="section-heading" id="up-queue">
            Queue{" "}
            <span className="muted">
              {running.length} running · {queued.length} waiting
            </span>
          </h2>
          <ul className="up-list">
            {running.map((r) => (
              <li key={`r-${r.runId ?? r.taskId}`} className="up-row">
                <span className="up-when">
                  <span className="dot dot-running" /> Running
                </span>
                <span className="up-what">{queueLine(r, batches)}</span>
                <span className="up-meta">
                  {r.startedAt ? `started ${relativeTime(r.startedAt)}` : ""}
                </span>
                {r.runId && (
                  <button type="button" className="link-btn" onClick={() => onOpenRun(r)}>
                    Open
                  </button>
                )}
              </li>
            ))}
            {queued.map((r) => (
              <li key={`q-${r.runId ?? r.taskId}-${r.position}`} className="up-row">
                <span className="up-when">Waiting · {r.position ?? "?"}</span>
                <span className="up-what">{queueLine(r, batches)}</span>
                <span className="up-meta">
                  {r.queuedAt ? `asked ${relativeTime(r.queuedAt)}` : ""}
                </span>
                {r.runId && (
                  <button type="button" className="link-btn" onClick={() => onOpenRun(r)}>
                    Open
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!nothing && (
        <section aria-labelledby="up-sched">
          <div className="section-row">
            <h2 className="section-heading" id="up-sched">
              Scheduled
            </h2>
            <WindowToggle days={days} onDays={onDays} />
          </div>
          {scheduled.length === 0 && frequent.length === 0 && (
            <p className="muted">No scheduled runs.</p>
          )}
          {frequent.length > 0 && (
            <ul className="up-list">
              {frequent.map((f) => (
                <li key={`f-${f.taskId}`} className="up-row">
                  <time className="up-when" dateTime={f.first}>
                    {formatWhen(f.first)}
                  </time>
                  <button
                    type="button"
                    className="task-link up-what"
                    onClick={() => onOpenTask(f.taskName)}
                  >
                    {f.taskName}
                  </button>
                  <span className="up-meta">{frequentLine(f, data.days)}</span>
                </li>
              ))}
            </ul>
          )}
          {scheduled.length > 0 && (
            <ul className="up-list">
              {scheduled.map((f) => (
                <li
                  key={`${f.taskId}-${f.at}`}
                  className={`up-row${f.beyondWindow ? " beyond" : ""}`}
                >
                  <time className="up-when" dateTime={f.at}>
                    {formatWhen(f.at)}
                  </time>
                  <button
                    type="button"
                    className="task-link up-what"
                    onClick={() => onOpenTask(f.taskName)}
                  >
                    {f.taskName}
                  </button>
                  <span className="up-meta">
                    {f.schedule}
                    {f.beyondWindow ? ` · after the next ${data.days} days` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {events.length > 0 && (
        <section aria-labelledby="up-events">
          <h2 className="section-heading" id="up-events">
            On events
          </h2>
          <ul className="up-list">
            {events.map((e) => (
              <li key={e.taskId} className="up-row">
                <button
                  type="button"
                  className="task-link up-when"
                  onClick={() => onOpenTask(e.taskName)}
                >
                  {e.taskName}
                </button>
                <span className="up-what">
                  {e.schedule} (at most {e.maxFiresPerHour}/hr)
                </span>
                <span className="up-meta">
                  {e.enabled ? `${e.firesLastHour} in the last hour` : "Paused"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The Upcoming view: reads `tasks__upcoming` and the batches it names, and refreshes while open. */
export function UpcomingView({
  refreshKey,
  onOpenRun,
  onOpenTask,
}: {
  refreshKey: number;
  onOpenRun: (run: UpcomingRun) => void;
  onOpenTask: (taskName: string) => void;
}) {
  const upcomingTool = useTool<string>("upcoming");
  const batchesTool = useTool<string>("batches");
  const [data, setData] = useState<UpcomingData | null>(null);
  const [batches, setBatches] = useState<Map<string, TaskBatch>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<WindowDays>(7);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tool calls are stable
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await upcomingTool.call({ days });
      const next = asDict(res.data) as unknown as UpcomingData;
      setData(next);
      setError(null);
      if ([...next.running, ...next.queued].some((r) => r.batchId)) {
        const b = await batchesTool.call({ state: "running", limit: 100 });
        const list = (asDict(b.data).batches as TaskBatch[]) ?? [];
        setBatches(new Map(list.map((x) => [x.id, x])));
      }
    } catch (err) {
      setError(toolErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [days]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the signal
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, refreshKey]);

  return (
    <UpcomingBody
      data={data}
      loading={loading}
      error={error}
      batches={batches}
      days={days}
      onDays={setDays}
      onOpenRun={onOpenRun}
      onOpenTask={onOpenTask}
    />
  );
}
