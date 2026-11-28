/**
 * Lookups and small mutations over one workspace's records, shared by the
 * public and private tools.
 */

import { randomBytes } from "node:crypto";
import type { Batch, RunRecord, TaskDef, WorkspaceState } from "./model.ts";
import type { Workspace } from "./store.ts";

export function newRunId(): string {
  return `run_${randomBytes(6).toString("hex")}`;
}

export function newBatchId(): string {
  return `batch_${randomBytes(6).toString("hex")}`;
}

export function newUid(): string {
  return randomBytes(8).toString("hex");
}

/** The owner's task by id, or undefined. */
export function findTask(
  state: WorkspaceState,
  ownerId: string,
  taskId: string,
): TaskDef | undefined {
  const tasks = state.tasks[ownerId];
  return tasks && Object.hasOwn(tasks, taskId) ? tasks[taskId] : undefined;
}

export function allTasks(state: WorkspaceState): TaskDef[] {
  return Object.values(state.tasks).flatMap((byId) => Object.values(byId));
}

/** The definition with this uid, whoever owns it. */
export function taskByUid(state: WorkspaceState, uid: string): TaskDef | undefined {
  return allTasks(state).find((t) => t.uid === uid);
}

export function putTask(state: WorkspaceState, task: TaskDef): void {
  const byId = state.tasks[task.ownerId] ?? {};
  byId[task.id] = task;
  state.tasks[task.ownerId] = byId;
}

export function removeTask(state: WorkspaceState, task: TaskDef): void {
  const byId = state.tasks[task.ownerId];
  if (!byId) return;
  delete byId[task.id];
  if (Object.keys(byId).length === 0) delete state.tasks[task.ownerId];
}

/** A run by id, open or ended, in the owner's scope (any owner when `ownerId` is undefined). */
export function findRun(ws: Workspace, runId: string, ownerId?: string): RunRecord | undefined {
  const run = Object.hasOwn(ws.state.open, runId) ? ws.state.open[runId] : ws.ended.get(runId);
  if (!run) return undefined;
  return ownerId === undefined || run.ownerId === ownerId ? run : undefined;
}

export function findBatch(
  state: WorkspaceState,
  ownerId: string,
  batchId: string,
): Batch | undefined {
  const batch = Object.hasOwn(state.batches, batchId) ? state.batches[batchId] : undefined;
  return batch && batch.ownerId === ownerId ? batch : undefined;
}

/** The task's non-batch run that is running now, other than `exceptId`. */
export function runningRunOf(
  state: WorkspaceState,
  uid: string,
  exceptId?: string,
): RunRecord | undefined {
  return Object.values(state.open).find(
    (r) =>
      r.taskUid === uid &&
      r.id !== exceptId &&
      r.batchId === undefined &&
      r.status === "running" &&
      !r.interruptedAt,
  );
}

/**
 * The run that keeps `run` from asking for another of the task: one outside a batch
 * running (whatever started it), or asked for by a person and still queued. An event
 * run waiting out its debounce is not one: a run asked for now goes before it.
 */
export function activeRunOf(state: WorkspaceState, uid: string): RunRecord | undefined {
  return (
    runningRunOf(state, uid) ??
    Object.values(state.open).find(
      (r) =>
        r.taskUid === uid &&
        r.batchId === undefined &&
        r.status === "queued" &&
        r.trigger === "manual",
    )
  );
}

/** Turn a task off with a reason. Returns whether it was on. */
export function disable(task: TaskDef, reason: string, at: string): boolean {
  if (!task.enabled) return false;
  task.enabled = false;
  task.disabledAt = at;
  task.disabledReason = reason;
  return true;
}

/** Clear what a failing stretch or an auto-disable left on a task being turned back on. */
export function clearDisableState(task: TaskDef): void {
  task.consecutiveErrors = 0;
  delete task.transientErrors;
  delete task.failureNoticeRunId;
  delete task.disabledAt;
  delete task.disabledReason;
}

/** The idempotency-key index entry name for an owner's key on one tool. */
export function keyName(ownerId: string, tool: string, key: string): string {
  return `${ownerId}\u0000${tool}\u0000${key}`;
}

export const blobNames = {
  input: (runId: string) => `input-${runId}`,
  answer: (runId: string) => `answer-${runId}`,
  result: (runId: string) => `result-${runId}`,
  batch: (batchId: string) => `batch-${batchId}`,
};
