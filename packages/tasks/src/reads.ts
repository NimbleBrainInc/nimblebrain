/**
 * `upcoming` and `stats`: reads rendered on this plugin's own clock (the
 * window ahead, the default `since`), which decide nothing (CONTRACT.md §6).
 */

import { Cron } from "croner";
import { taskNotFound } from "./contract.ts";
import { firesSince } from "./flow.ts";
import type { RunRecord, TaskDef } from "./model.ts";
import type { Caller } from "./public.ts";
import { findTask } from "./records.ts";
import { labelOf } from "./runs.ts";
import {
  DEFAULT_EVENT_MAX_FIRES_PER_HOUR,
  FIRE_WINDOW_MS,
  nextOccurrence,
  scheduleHuman,
  scheduleTypeOf,
} from "./schedule.ts";
import type { Tx } from "./store.ts";

// biome-ignore lint/suspicious/noExplicitAny: each input was checked against its contract schema
type Checked = any;

const DAY_MS = 86_400_000;
const DEFAULT_UPCOMING_DAYS = 7;
/** More fires than this in the window and a schedule is one `frequent` row. */
const FREQUENT_THRESHOLD = 24;

function ownerTasks(tx: Tx, caller: Caller): TaskDef[] {
  return Object.values(tx.ws.state.tasks[caller.ownerId] ?? {});
}

function ownerOpen(tx: Tx, caller: Caller): RunRecord[] {
  return Object.values(tx.ws.state.open).filter((r) => r.ownerId === caller.ownerId);
}

export function upcoming(tx: Tx, caller: Caller, args: Checked) {
  const days = args.days ?? DEFAULT_UPCOMING_DAYS;
  const now = Date.now();
  const windowEnd = now + days * DAY_MS;
  const tasks = ownerTasks(tx, caller);
  const nameOf = (uid: string) => tasks.find((t) => t.uid === uid)?.name;
  const open = ownerOpen(tx, caller);
  const running = open
    .filter((r) => r.status === "running" && !r.interruptedAt)
    .map((r) => withName(runRow(r, { startedAt: r.startedAt }), nameOf(r.taskUid)));
  const queued = open
    .filter((r) => r.status === "queued")
    .map((r) => withName(runRow(r, { queuedAt: r.requestedAt }), nameOf(r.taskUid)));
  const scheduled: Record<string, unknown>[] = [];
  const frequent: Record<string, unknown>[] = [];
  for (const task of tasks) {
    if (task.kind !== "saved" || !task.enabled) continue;
    addWindowFires(task, now, windowEnd, scheduled, frequent);
  }
  scheduled.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const events = tasks
    .filter((t) => t.kind === "saved" && scheduleTypeOf(t.schedule) === "event")
    .map((t) => ({
      taskId: t.id,
      taskName: t.name,
      enabled: t.enabled,
      maxFiresPerHour:
        (t.schedule && "match" in t.schedule ? t.schedule.maxFiresPerHour : undefined) ??
        DEFAULT_EVENT_MAX_FIRES_PER_HOUR,
      firesLastHour: firesSince(tx, t, now - FIRE_WINDOW_MS),
    }));
  return {
    running,
    queued,
    scheduled,
    days,
    windowEnd: new Date(windowEnd).toISOString(),
    frequent,
    events,
  };
}

function runRow(run: RunRecord, extra: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = { taskId: run.taskId, runId: run.id, trigger: run.trigger };
  for (const [k, v] of Object.entries({
    ...extra,
    batchId: run.batchId,
    batchIndex: run.batchIndex,
  })) {
    if (v !== undefined) row[k] = v;
  }
  return row;
}

function withName(row: Record<string, unknown>, name: string | undefined) {
  return name ? { ...row, taskName: name } : row;
}

/**
 * A timed task's fires within the window, from its next occurrence (the anchored one, or
 * where the schedule would place one now): each, or one `frequent` row past the threshold,
 * or its next fire marked `beyondWindow` when none falls inside.
 */
function addWindowFires(
  task: TaskDef,
  now: number,
  windowEnd: number,
  scheduled: Record<string, unknown>[],
  frequent: Record<string, unknown>[],
): void {
  const type = scheduleTypeOf(task.schedule);
  if (type !== "cron" && type !== "interval" && type !== "once") return;
  if (task.onceDone) return;
  const first = task.nextRunAt ? Date.parse(task.nextRunAt) : nextOccurrence(task, now);
  if (first === null || Number.isNaN(first)) return;
  const base = {
    taskId: task.id,
    taskName: task.name,
    scheduleHuman: scheduleHuman(task),
    scheduleType: type,
  };
  if (first > windowEnd) {
    scheduled.push({ ...base, at: new Date(first).toISOString(), beyondWindow: true });
    return;
  }
  const fires = firesIn(task, first, windowEnd);
  if (fires.length > FREQUENT_THRESHOLD) frequent.push(frequentRow(task, base, fires, windowEnd));
  else for (const at of fires) scheduled.push({ ...base, at: new Date(at).toISOString() });
}

/** One row for a schedule firing more than the threshold in the window. */
function frequentRow(
  task: TaskDef,
  base: Record<string, unknown>,
  fires: number[],
  windowEnd: number,
): Record<string, unknown> {
  const first = fires[0] as number;
  const step =
    task.schedule && "intervalMs" in task.schedule ? task.schedule.intervalMs : undefined;
  const count = step ? Math.floor((windowEnd - first) / step) + 1 : fires.length;
  const last = step ? first + (count - 1) * step : (fires[fires.length - 1] as number);
  return {
    ...base,
    count,
    first: new Date(first).toISOString(),
    last: new Date(last).toISOString(),
    // A cron is stepped only until it is known to be frequent: its count is a floor.
    ...(step ? {} : { countCapped: true }),
  };
}

/** The fires from `first` to `end`, stepped until one past the frequent threshold (an interval counted). */
function firesIn(task: TaskDef, first: number, end: number): number[] {
  const schedule = task.schedule;
  if (schedule && "intervalMs" in schedule) {
    const count = Math.floor((end - first) / schedule.intervalMs) + 1;
    return Array.from(
      { length: Math.min(count, FREQUENT_THRESHOLD + 2) },
      (_, k) => first + k * schedule.intervalMs,
    );
  }
  if (!schedule || !("cron" in schedule)) return [first];
  const fires = [first];
  try {
    const cron = new Cron(schedule.cron, { timezone: schedule.timezone });
    let next = cron.nextRun(new Date(first));
    while (next && next.getTime() <= end && fires.length <= FREQUENT_THRESHOLD) {
      fires.push(next.getTime());
      next = cron.nextRun(next);
    }
  } catch {
    // a cron that does not parse has no further fires
  }
  return fires;
}

const STATS_DEFAULT_DAYS = 30;
const STATS_RECENT_RUNS = 14;
const STATS_ERROR_CHARS = 240;

export function stats(tx: Tx, caller: Caller, args: Checked) {
  const since = args.since ?? new Date(Date.now() - STATS_DEFAULT_DAYS * DAY_MS).toISOString();
  let tasks: TaskDef[];
  if (args.taskId !== undefined) {
    const task = findTask(tx.ws.state, caller.ownerId, args.taskId);
    if (!task) throw taskNotFound(args.taskId);
    tasks = [task];
  } else {
    tasks = ownerTasks(tx, caller).filter((t) => t.kind === "saved");
  }
  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ended = [...tx.ws.ended.values()].filter((r) => r.ownerId === caller.ownerId);
  return { since, tasks: tasks.map((t) => statsOf(t, ended, Date.parse(since))) };
}

function statsOf(task: TaskDef, ended: RunRecord[], since: number) {
  const mine = ended
    .filter((r) => r.taskUid === task.uid)
    .sort((a, b) =>
      (b.startedAt ?? b.completedAt ?? "").localeCompare(a.startedAt ?? a.completedAt ?? ""),
    );
  const inWindow = mine.filter((r) => Date.parse(r.startedAt ?? r.completedAt ?? "") >= since);
  const pass = inWindow.filter((r) => r.assessment?.verdict === "pass").length;
  const fail = inWindow.filter((r) => r.assessment?.verdict === "fail").length;
  const out: Record<string, unknown> = {
    taskId: task.id,
    runs: inWindow.length,
    pass,
    fail,
    uncertain: 0,
    costUsd: inWindow.reduce((n, r) => n + (r.costUsd ?? 0), 0),
  };
  if (pass + fail > 0) out.passRate = pass / (pass + fail);
  const last = mine[0];
  if (last)
    out.lastRun = {
      id: last.id,
      label: labelOf(last),
      ...(last.startedAt ? { startedAt: last.startedAt } : {}),
    };
  const recent = mine.filter((r) => r.batchId === undefined).slice(0, STATS_RECENT_RUNS);
  if (recent.length > 0) {
    out.recent = recent.map((r) => ({
      id: r.id,
      label: labelOf(r),
      ...(r.startedAt ? { startedAt: r.startedAt } : {}),
      ...(r.error ? { error: r.error.slice(0, STATS_ERROR_CHARS) } : {}),
      ...(r.toolFailures ? { toolFailures: r.toolFailures } : {}),
    }));
  }
  return out;
}
