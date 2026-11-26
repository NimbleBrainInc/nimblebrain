import { useCallback, useEffect, useState } from "react";
import { dayLabel, type Job, jobsOf } from "../lib/jobs.ts";
import type { TaskBatch, TaskSummary } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatUsd, toolErrorText } from "../utils.ts";
import { SkeletonRows } from "./Skeleton.tsx";

/** Most batches read for the list: the newest, which is what the list is for. */
const BATCHES_READ = 100;
/** One-offs read per page, and how many pages before the list stops. */
const ONEOFF_PAGE = 500;
const ONEOFF_PAGES = 4;

/**
 * A one-off's last run label in the board's words. A label this screen does
 * not know is shown verbatim (CONTRACT.md §4).
 */
function statusWord(label: string | undefined): { word: string; tone: string } {
  switch (label) {
    case undefined:
    case "Queued":
    case "Running":
      return { word: "Running", tone: "active" };
    case "Succeeded":
      return { word: "Done", tone: "success" };
    case "Needs review":
    case "Poor result":
      return { word: "Needs you", tone: "warning" };
    case "Cancelled":
      return { word: "Stopped", tone: "muted" };
    case "Skipped":
      return { word: "Didn't run", tone: "muted" };
    case "Failed":
      return { word: "Didn't work", tone: "danger" };
    default:
      return { word: label, tone: "muted" };
  }
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A one-off row's outcome: its last run's label. */
function OneoffStatus({ job }: { job: Extract<Job, { kind: "oneoff" }> }) {
  const s = statusWord(job.lastLabel);
  return <span className={`job-status tone-${s.tone}`}>{s.word}</span>;
}

/** A batch's progress: a bar of passed and failed items, and its counts in words. */
function BatchProgress({ batch }: { batch: TaskBatch }) {
  const c = batch.counts;
  const passed = c.pass + c.not_assessed;
  const failed = c.fail + c.failed;
  const other = c.uncertain + c.skipped + c.cancelled;
  const items = batch.items ?? Object.values(c).reduce((a, b) => a + b, 0);
  const pct = (n: number) => `${(n / Math.max(1, items)) * 100}%`;
  const parts = [
    `${items} item${items === 1 ? "" : "s"}`,
    passed ? `${passed} passed` : "",
    failed ? `${failed} failed` : "",
    c.uncertain ? `${c.uncertain} to review` : "",
    batch.state === "running" && batch.done !== undefined ? `${batch.done} done` : "",
    batch.state === "paused" ? "paused" : "",
    batch.state === "cancelled" ? "cancelled" : "",
  ].filter(Boolean);
  return (
    <div className="job-progress">
      <div className="job-bar" aria-hidden="true">
        <i className="tone-success" style={{ width: pct(passed) }} />
        <i className="tone-danger" style={{ width: pct(failed) }} />
        <i className="tone-warning" style={{ width: pct(other) }} />
      </div>
      <div className="job-counts">{parts.join(" · ")}</div>
    </div>
  );
}

function JobRow({
  job,
  onOpenBatch,
  onOpenOneoff,
}: {
  job: Job;
  onOpenBatch: (batch: TaskBatch) => void;
  onOpenOneoff: (taskId: string, name: string) => void;
}) {
  const meta = [job.kind === "batch" ? "Batch" : "One-off", time(job.at)]
    .filter(Boolean)
    .join(" · ");
  const open = () =>
    job.kind === "batch" ? onOpenBatch(job.batch) : onOpenOneoff(job.taskId, job.name);
  return (
    <li>
      <button type="button" className="job-row" onClick={open}>
        <span className="job-who">
          <span className="job-name">
            {job.name}
            {job.kind === "oneoff" && job.runs > 1 && (
              <span className="job-times">×{job.runs}</span>
            )}
          </span>
          <span className="job-meta">{meta}</span>
        </span>
        {job.kind === "batch" ? <BatchProgress batch={job.batch} /> : <OneoffStatus job={job} />}
        <span className="job-cost">{job.kind === "batch" ? formatUsd(job.batch.costUsd) : ""}</span>
      </button>
    </li>
  );
}

/** The Runs list from what was read: jobs grouped by day, newest first. */
export function RunsBody({
  jobs,
  loading,
  error,
  partial = false,
  onOpenBatch,
  onOpenOneoff,
  onSeeActivity,
}: {
  jobs: Job[];
  loading: boolean;
  error: string | null;
  /** More one-offs exist than were read; the server pages by id, not time, so some newer ones may be missing. */
  partial?: boolean;
  onOpenBatch: (batch: TaskBatch) => void;
  onOpenOneoff: (taskId: string, name: string) => void;
  onSeeActivity: () => void;
}) {
  if (loading && jobs.length === 0) return <SkeletonRows count={5} />;
  const days: { label: string; jobs: Job[] }[] = [];
  for (const job of jobs) {
    const label = dayLabel(job.at);
    const last = days[days.length - 1];
    if (last?.label === label) last.jobs.push(job);
    else days.push({ label, jobs: [job] });
  }
  return (
    <div className="runs">
      <p className="hint">
        Work run once, from chat or an MCP client: one-offs and batches. Each scheduled task's runs
        are on its row in Scheduled.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {partial && (
        <p className="muted">
          Showing the first {ONEOFF_PAGE * ONEOFF_PAGES} one-offs read, not the newest: some recent
          ones may be missing here.
        </p>
      )}
      {!error && jobs.length === 0 && (
        <p className="muted">
          Nothing run once yet. Runs an MCP client asks for with an inline definition, and batches,
          show here.
        </p>
      )}
      {days.map((d) => (
        <section key={d.label} className="runs-day" aria-label={d.label}>
          <h2 className="runs-day-label">{d.label}</h2>
          <ul className="job-list">
            {d.jobs.map((j) => (
              <JobRow key={j.key} job={j} onOpenBatch={onOpenBatch} onOpenOneoff={onOpenOneoff} />
            ))}
          </ul>
        </section>
      ))}
      <div className="home-foot">
        <button type="button" className="link-btn" onClick={onSeeActivity}>
          Every run, scheduled ones included
        </button>
      </div>
    </div>
  );
}

/**
 * Read the one-offs by following `nextCursor`, up to a page budget. `partial`
 * says the budget ran out with more to read.
 */
async function readOneoffs(
  call: (args: Record<string, unknown>) => Promise<{ data?: unknown }>,
): Promise<{ tasks: TaskSummary[]; partial: boolean }> {
  const tasks: TaskSummary[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < ONEOFF_PAGES; i++) {
    const res = await call({ kind: "oneoff", limit: ONEOFF_PAGE, ...(cursor ? { cursor } : {}) });
    const data = asDict(res.data);
    tasks.push(...((data.tasks as TaskSummary[]) ?? []));
    cursor = (data.nextCursor as string | null | undefined) ?? undefined;
    if (!cursor) break;
  }
  return { tasks, partial: cursor !== undefined };
}

/** The Runs list's container: reads one-offs and batches when the panel's data changes. */
export function RunsView({
  saved,
  refreshKey,
  onOpenBatch,
  onOpenOneoff,
  onSeeActivity,
}: {
  /** The saved tasks, to name a batch of one by. */
  saved: TaskSummary[];
  refreshKey: number;
  onOpenBatch: (batch: TaskBatch) => void;
  onOpenOneoff: (taskId: string, name: string) => void;
  onSeeActivity: () => void;
}) {
  const listTool = useTool<string>("list");
  const batchesTool = useTool<string>("batches");
  const [oneoffs, setOneoffs] = useState<TaskSummary[]>([]);
  const [partial, setPartial] = useState(false);
  const [batches, setBatches] = useState<TaskBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, b] = await Promise.all([
        readOneoffs(listTool.call),
        batchesTool.call({ limit: BATCHES_READ }),
      ]);
      setOneoffs(o.tasks);
      setPartial(o.partial);
      setBatches((asDict(b.data).batches as TaskBatch[]) ?? []);
      setError(null);
    } catch (err) {
      setError(toolErrorText(err, "The runs could not be read."));
    } finally {
      setLoading(false);
    }
  }, [listTool, batchesTool]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` moves when the panel's data changes, which is when the list is re-read
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <RunsBody
      jobs={jobsOf(oneoffs, batches, saved)}
      loading={loading}
      error={error}
      partial={partial}
      onOpenBatch={onOpenBatch}
      onOpenOneoff={onOpenOneoff}
      onSeeActivity={onSeeActivity}
    />
  );
}
