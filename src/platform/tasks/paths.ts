/**
 * The single sanctioned construction (and parse) site for workspace-partitioned
 * task paths. Mirrors `src/conversation/paths.ts` and `src/files/paths.ts`:
 * every task directory is built and parsed here, so the on-disk layout has
 * exactly one definition.
 *
 * The workspace owns the directory: a task lives under the workspace it
 * fires against, with the owner as a privacy sub-partition. The path is the
 * binding — `Task.workspaceId` / `Task.ownerId` are denormalised
 * conveniences; the directory is authoritative.
 *
 *   workspaces/<wsId>/tasks/<ownerId>/<taskId>.json              the definition
 *   workspaces/<wsId>/tasks/<ownerId>/runs/<taskId>/index.jsonl  newest run summaries (the hot window)
 *   workspaces/<wsId>/tasks/<ownerId>/runs/<taskId>/<runId>.result.json  a hot run's deliverable
 *   workspaces/<wsId>/tasks/<ownerId>/runs/<taskId>/archive/<YYYY-MM>/index.jsonl  older summaries, by start month (UTC)
 *   workspaces/<wsId>/tasks/<ownerId>/runs/<taskId>/archive/<YYYY-MM>/<runId>.result.json  their deliverables
 *   workspaces/<wsId>/tasks/<ownerId>/runs/<taskId>/keys/<sha256(key)>.json  an idempotency key and the run it started
 *   workspaces/<wsId>/tasks/<ownerId>/run-tickets/<runId>.json  a requested run's current record, found by run id alone
 *   workspaces/<wsId>/tasks/<ownerId>/batches/<batchId>.json  a batch: its definition snapshot and counts
 *   workspaces/<wsId>/tasks/<ownerId>/batches/<batchId>.items.jsonl  its items: inputs, then appended outcomes
 *   workspaces/<wsId>/tasks/<ownerId>/batches/keys/<sha256(key)>.json  an idempotency key and the batch it made
 *
 * A run's summary and its deliverable move to the archive together, so the
 * hot runs dir holds at most the hot window of sidecars plus `index.jsonl`
 * and `archive/`, and listing it stays bounded however long history grows.
 *
 * A task run is NOT a conversation: it leaves a *run result* (the final
 * output, the activity log, and refs to any files it wrote in the workspace file
 * store) under its own `runs/` subtree — never a chat under `conversations/`.
 *
 * This file is the only site `check:task-paths` permits to construct a
 * workspace tasks dir.
 */

import { join, sep } from "node:path";

const TASKS_SEGMENT = "tasks";
const WORKSPACES_SEGMENT = "workspaces";
const RUNS_SEGMENT = "runs";
const TICKETS_SEGMENT = "run-tickets";
const KEYS_SEGMENT = "keys";
const BATCHES_SEGMENT = "batches";

/**
 * Task ids are kebab-case (lowercase alphanumeric segments separated by
 * hyphens), generated from the name. Run ids are `run_<token>`. Both are
 * validated before any path construction to prevent traversal.
 */
const TASK_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RUN_ID_RE = /^run_[A-Za-z0-9_-]+$/;
const BATCH_ID_RE = /^batch_[a-f0-9]{12}$/;

export function validateTaskId(id: string): void {
  if (!TASK_ID_RE.test(id)) {
    throw new Error(
      `Invalid task id: ${JSON.stringify(id)}. Must be non-empty kebab-case (lowercase alphanumeric and hyphens).`,
    );
  }
}

export function validateRunId(id: string): void {
  if (!RUN_ID_RE.test(id)) {
    throw new Error(`Invalid run id: ${JSON.stringify(id)}. Must match ${RUN_ID_RE}.`);
  }
}

export function validateBatchId(id: string): void {
  if (!BATCH_ID_RE.test(id)) {
    throw new Error(`Invalid batch id: ${JSON.stringify(id)}. Must match ${BATCH_ID_RE}.`);
  }
}

/** Whether `id` is a well-formed batch id. */
export function isBatchId(id: string): boolean {
  return BATCH_ID_RE.test(id);
}

/** The directory holding every owner's tasks in one workspace: `{workDir}/workspaces/<wsId>/tasks`. */
export function workspaceTasksRoot(workDir: string, wsId: string): string {
  return join(workDir, WORKSPACES_SEGMENT, wsId, TASKS_SEGMENT);
}

/**
 * Directory holding one owner's tasks in one workspace:
 * `{workDir}/workspaces/<wsId>/tasks/<ownerId>`.
 */
export function workspaceTasksDir(workDir: string, wsId: string, ownerId: string): string {
  return join(workspaceTasksRoot(workDir, wsId), ownerId);
}

/** The definition file: `…/tasks/<ownerId>/<taskId>.json`. */
export function taskFilePath(
  workDir: string,
  wsId: string,
  ownerId: string,
  taskId: string,
): string {
  validateTaskId(taskId);
  return join(workspaceTasksDir(workDir, wsId, ownerId), `${taskId}.json`);
}

/** The runs dir for one task: `…/tasks/<ownerId>/runs/<taskId>`. */
export function taskRunsDir(
  workDir: string,
  wsId: string,
  ownerId: string,
  taskId: string,
): string {
  validateTaskId(taskId);
  return join(workspaceTasksDir(workDir, wsId, ownerId), RUNS_SEGMENT, taskId);
}

/** The append-only run-summary index: `…/runs/<taskId>/index.jsonl`. */
export function taskRunIndexPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  taskId: string,
): string {
  return join(taskRunsDir(workDir, wsId, ownerId, taskId), "index.jsonl");
}

/** An archive month, `YYYY-MM`. */
const ARCHIVE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const ARCHIVE_SEGMENT = "archive";

/** Whether `name` is an archive month directory name (`YYYY-MM`). */
export function isRunArchiveMonth(name: string): boolean {
  return ARCHIVE_MONTH_RE.test(name);
}

/** The archive root for one task: `…/runs/<taskId>/archive`. */
export function taskRunArchiveRoot(
  workDir: string,
  wsId: string,
  ownerId: string,
  taskId: string,
): string {
  return join(taskRunsDir(workDir, wsId, ownerId, taskId), ARCHIVE_SEGMENT);
}

/**
 * One archive month: `…/runs/<taskId>/archive/<YYYY-MM>`, holding the
 * summaries (`index.jsonl`) and deliverables of the runs that started that
 * month (UTC) and rolled out of the hot index.
 */
export function taskRunArchiveDir(
  workDir: string,
  wsId: string,
  ownerId: string,
  taskId: string,
  month: string,
): string {
  if (!isRunArchiveMonth(month)) {
    throw new Error(`Invalid run archive month: ${JSON.stringify(month)}. Must be YYYY-MM.`);
  }
  return join(taskRunArchiveRoot(workDir, wsId, ownerId, taskId), month);
}

/** An archive month's run index: `…/archive/<YYYY-MM>/index.jsonl`. */
export function taskRunSegmentPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  taskId: string,
  month: string,
): string {
  return join(taskRunArchiveDir(workDir, wsId, ownerId, taskId, month), "index.jsonl");
}

/** An archived run's result sidecar: `…/archive/<YYYY-MM>/<runId>.result.json`. */
export function taskArchivedRunResultPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  taskId: string,
  month: string,
  runId: string,
): string {
  validateRunId(runId);
  return join(taskRunArchiveDir(workDir, wsId, ownerId, taskId, month), `${runId}.result.json`);
}

/** A single run's result sidecar: `…/runs/<taskId>/<runId>.result.json`. */
export function taskRunResultPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  taskId: string,
  runId: string,
): string {
  validateRunId(runId);
  return join(taskRunsDir(workDir, wsId, ownerId, taskId), `${runId}.result.json`);
}

/**
 * A requested run's ticket: `…/tasks/<ownerId>/run-tickets/<runId>.json`.
 * Keyed by run id alone, under the owner, so a task handle (which names only
 * the run) finds its run without knowing the task, and the owner
 * partition in the path is the ownership check.
 */
export function taskRunTicketPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  runId: string,
): string {
  validateRunId(runId);
  return join(workspaceTasksDir(workDir, wsId, ownerId), TICKETS_SEGMENT, `${runId}.json`);
}

/** A SHA-256 hex digest: the file name an idempotency key is stored under. */
const KEY_DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * Where an idempotency key used on one task is recorded:
 * `…/runs/<taskId>/keys/<digest>.json`. `digest` is the key's SHA-256,
 * so a caller's key never becomes a path segment.
 */
export function taskIdempotencyKeyPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  taskId: string,
  digest: string,
): string {
  if (!KEY_DIGEST_RE.test(digest)) {
    throw new Error(`Invalid idempotency key digest: ${JSON.stringify(digest)}.`);
  }
  return join(taskRunsDir(workDir, wsId, ownerId, taskId), KEYS_SEGMENT, `${digest}.json`);
}

/** One owner's batches: `…/tasks/<ownerId>/batches`. */
export function taskBatchesDir(workDir: string, wsId: string, ownerId: string): string {
  return join(workspaceTasksDir(workDir, wsId, ownerId), BATCHES_SEGMENT);
}

/** A batch record: `…/batches/<batchId>.json`. */
export function taskBatchPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  batchId: string,
): string {
  validateBatchId(batchId);
  return join(taskBatchesDir(workDir, wsId, ownerId), `${batchId}.json`);
}

/** A batch's items: `…/batches/<batchId>.items.jsonl`. */
export function taskBatchItemsPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  batchId: string,
): string {
  validateBatchId(batchId);
  return join(taskBatchesDir(workDir, wsId, ownerId), `${batchId}.items.jsonl`);
}

/**
 * Where an idempotency key used on `tasks__run_batch` is recorded:
 * `…/batches/keys/<digest>.json`, `digest` being the key's SHA-256.
 */
export function taskBatchKeyPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  digest: string,
): string {
  if (!KEY_DIGEST_RE.test(digest)) {
    throw new Error(`Invalid idempotency key digest: ${JSON.stringify(digest)}.`);
  }
  return join(taskBatchesDir(workDir, wsId, ownerId), KEYS_SEGMENT, `${digest}.json`);
}

/** What a parsed task path resolves to. */
export interface ParsedTaskPath {
  wsId: string;
  ownerId: string;
}

/**
 * Inverse of the builders: recover `{ wsId, ownerId }` from any path under a
 * `workspaces/<wsId>/tasks/<ownerId>/...` subtree. Returns `null` for a
 * path that isn't one (e.g. an identity-scoped `users/<id>/...` path). The
 * path is the authority; this lets the scheduler recover a task's
 * workspace + owner without trusting the record's fields.
 */
export function parseTaskPath(absPath: string): ParsedTaskPath | null {
  const segments = absPath.split(sep);
  const wsIdx = segments.lastIndexOf(WORKSPACES_SEGMENT);
  if (wsIdx === -1) return null;
  const wsId = segments[wsIdx + 1];
  const tasksSeg = segments[wsIdx + 2];
  const ownerId = segments[wsIdx + 3];
  if (!wsId || tasksSeg !== TASKS_SEGMENT || !ownerId) return null;
  return { wsId, ownerId };
}
