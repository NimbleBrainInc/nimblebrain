/**
 * A task's health as the home list reads it: one word, a tone, and, when it
 * needs a person, the reason in plain words. Pure, so the order of the rules
 * is tested apart from the views.
 */
import type { TaskStats, TaskSummary, UpcomingRun } from "../types.ts";

export type HealthTone = "danger" | "warning" | "active" | "success" | "muted";

export interface TaskHealth {
  /** The word beside the task: "Failing", "On track", "Paused". */
  word: string;
  tone: HealthTone;
  /** Why it needs you; set only when it does. */
  reason?: string;
  /** The run to open for the reason, when one says it. */
  runId?: string;
  /** Shown under "Needs you" rather than in the list. */
  needsYou: boolean;
  /** Its trigger is off: listed under Paused. */
  paused: boolean;
}

/** Whether a task has a trigger that Pause and Resume act on. */
export function hasTrigger(task: Pick<TaskSummary, "scheduleType" | "onceDone">): boolean {
  return (task.scheduleType ?? "none") !== "none" && !task.onceDone;
}

/**
 * The rules, most urgent first: a run in flight, a trigger the runtime turned
 * off, a failure streak, the last run's label, a trigger the owner turned off,
 * then the quiet states.
 */
export function healthOf(task: TaskSummary, stats?: TaskStats, live?: UpcomingRun): TaskHealth {
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
      needsYou: true,
      paused: false,
    };
  }
  const streak = task.consecutiveErrors ?? 0;
  if (streak > 1) {
    return {
      word: "Failing",
      tone: "danger",
      reason: `The last ${streak} runs failed.`,
      runId: last?.id,
      needsYou: true,
      paused: false,
    };
  }
  if (last?.label === "Failed") {
    return {
      word: "Failed",
      tone: "danger",
      reason: "The last run failed.",
      runId: last.id,
      needsYou: true,
      paused: false,
    };
  }
  if (last?.label === "Poor result") {
    return {
      word: "Poor result",
      tone: "danger",
      reason: "The last run didn't meet its rules.",
      runId: last.id,
      needsYou: true,
      paused: false,
    };
  }
  if (last?.label === "Needs review") {
    return {
      word: "Needs review",
      tone: "warning",
      reason: "The last run needs you to check it.",
      runId: last.id,
      needsYou: true,
      paused: false,
    };
  }
  if (hasTrigger(task) && !task.enabled)
    return { word: "Paused", tone: "muted", needsYou: false, paused: true };
  if (task.onceDone) {
    return {
      word: task.onceDone.outcome === "missed" ? "Missed its time" : "Done",
      tone: "muted",
      ...quiet,
    };
  }
  if (!last) return { word: "No runs yet", tone: "muted", ...quiet };
  return { word: "On track", tone: "success", ...quiet };
}

const URGENCY: Record<HealthTone, number> = {
  danger: 0,
  warning: 1,
  active: 2,
  success: 3,
  muted: 4,
};

/** Tasks that need a person, most urgent first, then by name. */
export function byUrgency<T extends { name: string; health: TaskHealth }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => URGENCY[a.health.tone] - URGENCY[b.health.tone] || a.name.localeCompare(b.name),
  );
}

/** The home list's opening line. */
export function headline(needsYou: number, total: number): string {
  if (total === 0) return "No tasks yet";
  if (needsYou === 0) return "Everything is on track";
  return needsYou === 1 ? "1 task needs you" : `${needsYou} tasks need you`;
}
