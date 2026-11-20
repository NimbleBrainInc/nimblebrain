/**
 * Work run once (a one-off or a batch, usually from an MCP client) as the Runs
 * list draws it: one row per job, named in words, newest first. Pure, so the
 * naming and grouping are tested apart from the view.
 *
 * A job has an outcome, not health: it ran once, so nothing here is "broken"
 * the way a scheduled task is, and nothing here reaches the board.
 */
import type { TaskBatch, TaskSummary } from "../types.ts";

export type Job =
  | {
      kind: "batch";
      key: string;
      name: string;
      via?: string;
      at: string;
      batch: TaskBatch;
    }
  | {
      kind: "oneoff";
      key: string;
      name: string;
      via?: string;
      at: string;
      /** How many times the one-off ran: a repeat under its idempotency key is the same one-off. */
      runs: number;
      /** Its last run's status. */
      lastStatus: string | null;
      /** The one-off, to open. */
      taskId: string;
    };

/** "fit-pilot-2026-10-18-armA-default" → "Fit pilot armA default": a key the caller chose, read as words. */
export function wordsFromKey(key: string): string {
  const text = key
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/[-_.:/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

/** The first words of a prompt, as a name: "Grade the account's fit for…" → "Grade the account's fit". */
export function wordsFromPrompt(prompt: string | undefined, max = 7): string {
  const words = (prompt ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return "";
  const head = words
    .slice(0, max)
    .join(" ")
    .replace(/[,.;:]+$/, "");
  return words.length > max ? `${head}…` : head;
}

const isGeneratedId = (name: string, id: string) => name === id || name.startsWith("oneoff-");

/** A one-off's name: the caller's, else its prompt's first words, else a plain label. */
export function oneoffName(t: Pick<TaskSummary, "id" | "name" | "promptPreview">): string {
  if (!isGeneratedId(t.name, t.id)) return t.name;
  return wordsFromPrompt(t.promptPreview) || "One-off run";
}

/** A batch's name: the caller's, its saved task's, its key's words, its one-off's, or a plain label. */
export function batchName(batch: TaskBatch, tasks: Map<string, TaskSummary>): string {
  if (batch.name) return batch.name;
  const task = tasks.get(batch.taskId);
  if (task && task.kind !== "oneoff") return task.name;
  if (batch.idempotencyKey) {
    const words = wordsFromKey(batch.idempotencyKey);
    if (words) return words;
  }
  return task ? oneoffName(task) : "Batch";
}

function batchJob(b: TaskBatch, tasks: Map<string, TaskSummary>): Job {
  return {
    kind: "batch",
    key: b.id,
    name: batchName(b, tasks),
    ...(b.startedVia ? { via: b.startedVia } : {}),
    at: b.completedAt ?? b.updatedAt ?? b.createdAt,
    batch: b,
  };
}

function oneoffJob(t: TaskSummary, at: string): Job {
  return {
    kind: "oneoff",
    key: t.id,
    name: oneoffName(t),
    runs: Math.max(1, t.runCount),
    at,
    lastStatus: t.lastRunStatus,
    taskId: t.id,
    ...(t.startedVia ? { via: t.startedVia } : {}),
  };
}

/**
 * Every job, newest first: each batch and each one-off on its own row, so a
 * row opens exactly the runs it stands for. A one-off that a batch runs is
 * that batch's, not a row of its own.
 */
export function jobsOf(oneoffs: TaskSummary[], batches: TaskBatch[], saved: TaskSummary[]): Job[] {
  const tasks = new Map([...saved, ...oneoffs].map((t) => [t.id, t]));
  const batched = new Set(batches.map((b) => b.taskId));
  const rows = oneoffs.flatMap((t) =>
    batched.has(t.id) || !t.lastRunAt ? [] : [oneoffJob(t, t.lastRunAt)],
  );
  return [...batches.map((b) => batchJob(b, tasks)), ...rows].sort((a, b) =>
    b.at.localeCompare(a.at),
  );
}

/** The day a job falls on, as a heading: "Today", "Yesterday", "Oct 18". */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}
