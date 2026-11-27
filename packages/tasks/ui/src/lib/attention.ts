/**
 * A task's health as the board reads it: a light, a word, and, when it needs
 * a person, the reason in plain words and the one thing to do about it. Pure,
 * so the order of the rules is tested apart from the views.
 *
 * Health is derived from the runs, never stored, so nothing clears it but new
 * evidence: a run that works clears a failure or a result waiting for review,
 * and failures age out of the flaky window. Each action below therefore ends
 * in a run.
 */
import type { LiveRun, TaskRun, TaskStats, TaskSummary } from "../types.ts";
import { attentionOf } from "./needs-you.ts";
import { outcomeOf } from "./outcome.ts";

export type HealthTone = "danger" | "warning" | "active" | "success" | "muted";

/** The one thing to do about a task that needs a person. */
export type HealthAction =
  /** Run it again: a run that works is what clears a failure. */
  | "retry"
  /** Turn its trigger back on, then run it. */
  | "enable-and-retry"
  /** Open the run and read it. */
  | "review"
  /** Open the task to see which runs failed. */
  | "open-task"
  /** Open the task's form to change its instructions. */
  | "edit"
  /** Ask the agent in chat, with the task and its failure. */
  | "chat";

export interface TaskHealth {
  /** The word beside the task: "Failing", "Flaky", "Paused". */
  word: string;
  tone: HealthTone;
  /** Why it needs you; set only when it does. */
  reason?: string;
  /** What to do about it; set only when it needs you. */
  action?: HealthAction;
  /** A second thing to do, beside `action`. */
  secondary?: HealthAction;
  /** The run the reason is about, when one is. */
  runId?: string;
  /** Counted in the board's "need you". */
  needsYou: boolean;
  /** Its trigger is off: drawn as a hollow light, never as a problem. */
  paused: boolean;
}

/** Failures among this many latest runs make a task flaky. */
export const FLAKY_WINDOW = 10;
/** How many failures in the window make it flaky. */
export const FLAKY_FAILURES = 2;

/** Whether a task has a trigger that Pause and Resume act on. */
export function hasTrigger(task: Pick<TaskSummary, "scheduleType" | "onceDone">): boolean {
  return (task.scheduleType ?? "none") !== "none" && !task.onceDone;
}

const failedLabel = (r: TaskRun) => r.label === "Failed" || r.label === "Poor result";

/** How many of a task's latest runs didn't work, and how many were looked at. */
export function recentFailures(recent: TaskRun[]): { failed: number; of: number } {
  const window = [...recent]
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
    .slice(0, FLAKY_WINDOW);
  return { failed: window.filter(failedLabel).length, of: window.length };
}

/**
 * How many of the latest runs failed in a row, newest back. The task list does
 * not carry the task's own streak, so the board counts it from the runs it read.
 */
export function trailingFailures(recent: TaskRun[]): number {
  const newestFirst = [...recent].sort((a, b) =>
    (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
  );
  const i = newestFirst.findIndex((r) => !failedLabel(r));
  return i === -1 ? newestFirst.length : i;
}

/** The newest run's error, as one clause after a colon, or nothing. */
function errorClause(recent: TaskRun[]): string {
  const newest = [...recent].sort((a, b) =>
    (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
  )[0];
  return newest?.error ? `: ${newest.error}` : ".";
}

/**
 * The rules, most urgent first: a run in flight; a trigger the runtime turned
 * off; a trigger the owner turned off (quiet, whatever its last run did: off
 * is a decision); a failure streak; the last run's label; failures spread
 * through the latest runs; then the quiet states.
 */
export function healthOf(
  task: TaskSummary,
  stats?: TaskStats,
  live?: LiveRun,
  recent: TaskRun[] = [],
  /** The task's `allowedTools`, when its definition was read. */
  allowedTools?: string[],
): TaskHealth {
  const last = stats?.lastRun;
  const quiet = { needsYou: false, paused: false };
  if (live?.state === "running")
    return { word: "Running", tone: "active", runId: live.runId, ...quiet };
  if (live?.state === "queued") {
    return { word: "Waiting to start", tone: "muted", runId: live.runId, ...quiet };
  }
  if (hasTrigger(task) && !task.enabled && task.disabledReason) {
    return {
      word: "Turned off",
      tone: "danger",
      reason: task.disabledReason,
      action: "enable-and-retry",
      needsYou: true,
      paused: false,
    };
  }
  // Off is a decision, so a failure stays quiet; a result waiting for review
  // is still the person's to read, trigger or not.
  if (hasTrigger(task) && !task.enabled) {
    if (last?.label === "Needs review") return needsYou(last, recent, allowedTools);
    return { word: "Paused", tone: "muted", needsYou: false, paused: true };
  }
  const trouble = troubleOf(last, recent, allowedTools);
  if (trouble) return trouble;
  if (task.onceDone) {
    return {
      word: task.onceDone.outcome === "missed" ? "Missed its time" : "Done",
      tone: "muted",
      ...quiet,
    };
  }
  if (!last) return { word: "No runs yet", tone: "muted", ...quiet };
  return { word: "Healthy", tone: "success", ...quiet };
}

/**
 * A last run that asks for the person (Needs review, or a result that did not
 * match its shape): why, in one sentence from its recorded failures, and the two
 * things that fix it. With nothing to name, the run itself is the place to look.
 */
function needsYou(
  last: NonNullable<TaskStats["lastRun"]>,
  recent: TaskRun[],
  allowedTools?: string[],
): TaskHealth {
  const outcome = outcomeOf(last.label);
  const run = recent.find((r) => r.id === last.id) ?? { ...last, taskId: "", execution: "" };
  const reason = attentionOf(run, { allowedTools });
  const base = { word: outcome.word, runId: last.id, needsYou: true, paused: false };
  const tone = outcome.tone === "danger" ? "danger" : "warning";
  if (!reason) {
    return { ...base, tone, reason: "Open the last run to see what it needs.", action: "review" };
  }
  return { ...base, tone, reason, action: "edit", secondary: "chat" };
}

/** What is wrong with a task that is on, from its last run and its latest runs; null when nothing is. */
function troubleOf(
  last: TaskStats["lastRun"],
  recent: TaskRun[],
  allowedTools?: string[],
): TaskHealth | null {
  const streak = trailingFailures(recent);
  if (streak > 1) {
    return {
      word: "Failing",
      tone: "danger",
      reason: `Failed ${streak} times in a row${errorClause(recent)}`,
      action: "retry",
      runId: last?.id,
      needsYou: true,
      paused: false,
    };
  }
  if (last?.label === "Failed") {
    return {
      word: outcomeOf(last.label).word,
      tone: "danger",
      reason: `Last run failed${errorClause(recent)}`,
      action: "retry",
      runId: last.id,
      needsYou: true,
      paused: false,
    };
  }
  if (last?.label === "Poor result" || last?.label === "Needs review") {
    return needsYou(last, recent, allowedTools);
  }
  const { failed, of } = recentFailures(recent);
  if (failed >= FLAKY_FAILURES) {
    return {
      word: "Flaky",
      tone: "warning",
      reason: `${failed} of the last ${of} runs didn't work.`,
      action: "open-task",
      needsYou: true,
      paused: false,
    };
  }
  return null;
}

const URGENCY: Record<HealthTone, number> = {
  danger: 0,
  warning: 1,
  active: 2,
  success: 3,
  muted: 4,
};

/** Tasks most urgent first, paused last, then by name. */
export function byUrgency<T extends { name: string; health: TaskHealth }>(rows: T[]): T[] {
  const rank = (h: TaskHealth) => (h.paused ? 5 : URGENCY[h.tone]);
  return [...rows].sort((a, b) => rank(a.health) - rank(b.health) || a.name.localeCompare(b.name));
}

/** The board's opening line. */
export function headline(needsYou: number, total: number): string {
  if (total === 0) return "Nothing scheduled yet";
  if (needsYou === 0) return "Everything is on track";
  return needsYou === 1 ? "1 needs you" : `${needsYou} need you`;
}
