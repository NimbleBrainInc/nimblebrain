/**
 * A task's row after a save, from the task the save returned. A switch click
 * changes one task, so the panel updates that row from the save's own answer
 * instead of reloading every task, its stats, and the queue; the server's
 * change announcement, where the host relays it, re-reads the rest.
 */
import type { TaskSummary } from "../types.ts";

/** The saved task's state fields, as `tasks__update` returns them. */
export interface SavedTaskState {
  id: string;
  enabled: boolean;
  nextRunAt?: string;
  consecutiveErrors?: number;
  disabledAt?: string;
  disabledReason?: string;
  onceDone?: TaskSummary["onceDone"];
}

/** The list with that task's row carrying the saved state; other rows are returned as they are. */
export function withSavedTask(tasks: TaskSummary[], saved: SavedTaskState): TaskSummary[] {
  return tasks.map((t) =>
    t.id === saved.id
      ? {
          ...t,
          enabled: saved.enabled,
          nextRunAt: saved.nextRunAt ?? null,
          consecutiveErrors: saved.consecutiveErrors ?? t.consecutiveErrors,
          disabledAt: saved.disabledAt ?? null,
          disabledReason: saved.disabledReason ?? null,
          onceDone: saved.onceDone,
        }
      : t,
  );
}

/** The saved task in a `tasks__update` answer, when it carries one. */
export function savedTaskOf(data: unknown): SavedTaskState | null {
  if (!data || typeof data !== "object") return null;
  const task = (data as { task?: unknown }).task;
  if (!task || typeof task !== "object") return null;
  const t = task as Partial<SavedTaskState>;
  return typeof t.id === "string" && typeof t.enabled === "boolean" ? (t as SavedTaskState) : null;
}
