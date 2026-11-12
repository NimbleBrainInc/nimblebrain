/**
 * Retention for task run data (ADR-0061): what an ended run leaves on disk is
 * deleted once it is older than `tasks.runRetentionDays`.
 *
 * One number bounds three stores, because each grows by one entry per run and
 * none is bounded by anything else:
 *
 *   runs/<taskId>/archive/<YYYY-MM>/   a whole month, once the month ended more
 *                                      than the window ago. The archive is
 *                                      partitioned by start month, so expiry is
 *                                      a directory removal and no index is
 *                                      rewritten. The hot window (`index.jsonl`
 *                                      and its sidecars) is never touched.
 *   run-tickets/<runId>.json           an ended run's ticket, with the
 *                                      idempotency key that names it, once the
 *                                      run ended more than the window ago.
 *   <taskId>.json + runs/<taskId>/     a `oneoff` task, once it and its newest
 *                                      run are older than the window.
 *
 * What it never deletes: anything in the hot window of a saved task, an open
 * (queued or running) ticket, a ticket or an archive month an unsettled batch
 * may still read ({@link isUnsettledBatch}), a one-off any batch record names
 * (the batch's results are read through it), and a one-off with a run in
 * flight, queued, or marked in flight on its definition.
 *
 * Crash safety is in the order of each removal. A directory is renamed to an
 * `.expired-…` sibling before any file in it is unlinked, so every reader sees
 * the month (or the one-off's runs) whole or not at all, and a sweep that
 * finds such a sibling finishes the removal. A key goes before its ticket and
 * a one-off's runs before its definition, so whatever a crash leaves behind is
 * still expired on the next sweep, which removes it. Running the sweep again
 * over a swept tree removes nothing.
 *
 * Listing, reading, and unlinking are asynchronous, so a first sweep over
 * tens of thousands of files never holds the event loop. Each decision to
 * remove, and the rename or unlink that carries it out, runs synchronously in
 * one turn: the store's writers are synchronous too, so none can interleave.
 * What an asynchronous read returned may be older than the file by the time
 * its turn runs, so it only picks a one-off as a candidate; the decision is
 * made on the definition read again inside the removing turn.
 */

import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../../observability/log.ts";
import { isUnsettledBatch, listBatches } from "./batch-store.ts";
import {
  EXPIRED_PREFIX,
  expiredSiblingPath,
  isRunArchiveMonth,
  ownerRunsRoot,
  taskFilePath,
  taskRunArchiveDir,
  taskRunArchiveRoot,
  taskRunsDir,
  taskRunTicketsDir,
  validateTaskId,
  workspaceTasksDir,
} from "./paths.ts";
import { isOpenRun } from "./scheduler.ts";
import { deleteIdempotencyKey, listTaskOwners, loadTask, monthEndMs, readRuns } from "./store.ts";
import { kindOf, type RunTicket, type Task, type TaskRun } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long after start the first sweep runs, so it stays out of the boot path. */
export const FIRST_SWEEP_DELAY_MS = 30_000;

/** The time between sweeps. */
export const SWEEP_INTERVAL_MS = DAY_MS;

/** What a sweep reads and asks of the scheduler. */
export interface RetentionDeps {
  workDir: string;
  /** `tasks.runRetentionDays`, resolved. */
  retentionDays: number;
  /** The clock, in epoch ms. Default: `Date.now`. */
  now?: () => number;
  /** Whether the scheduler carries a run of the task (in flight, queued, or requested). */
  isTaskBusy: (wsId: string, ownerId: string, taskId: string) => boolean;
  /** Drop a deleted one-off from the scheduler's loaded definitions. */
  forgetTask: (wsId: string, ownerId: string, taskId: string) => void;
  /** Called for each owner whose task list changed (a one-off was deleted). */
  onOwnerChanged?: (ownerId: string) => void;
  /** Polled between removals; true ends the sweep early. */
  stopped?: () => boolean;
}

/** How much one sweep removed. */
export interface RetentionReport {
  archiveMonths: number;
  tickets: number;
  oneoffs: number;
}

/** One owner's sweep: the paths it reads and the clock it judges by. */
interface OwnerSweep {
  deps: RetentionDeps;
  wsId: string;
  ownerId: string;
  /** Anything that ended at or before this instant is expired. */
  cutoffMs: number;
  report: RetentionReport;
}

const stopped = (deps: RetentionDeps): boolean => deps.stopped?.() ?? false;

/** When a run ended, in epoch ms; `NaN` when its record carries no readable time. */
function endedMs(run: Pick<TaskRun, "completedAt" | "startedAt">): number {
  return new Date(run.completedAt ?? run.startedAt).getTime();
}

function isTaskId(name: string): boolean {
  try {
    validateTaskId(name);
    return true;
  } catch {
    return false;
  }
}

/** The names in `dir`; empty when it is absent or unreadable. */
async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Finish removing a directory the sweep already took out of use. */
async function unlinkTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Remove a directory: one synchronous rename out of every reader's sight, then
 * the unlinking, off the event loop.
 */
async function removeDir(dir: string): Promise<void> {
  const gone = expiredSiblingPath(dir, randomBytes(4).toString("hex"));
  renameSync(dir, gone);
  await unlinkTree(gone);
}

/** Remove the `.expired-…` siblings in `dir` that a stopped sweep left. */
async function finishRemovals(dir: string, names: string[]): Promise<void> {
  for (const name of names) {
    if (name.startsWith(EXPIRED_PREFIX)) await unlinkTree(join(dir, name));
  }
}

/**
 * Delete each task's archive months that ended at or before the cutoff. Walks
 * the runs dirs, not the definitions, so the archive of a task whose
 * definition is gone expires too.
 */
async function sweepArchives(sweep: OwnerSweep, heldTaskIds: Set<string>): Promise<void> {
  const { deps, wsId, ownerId, cutoffMs, report } = sweep;
  const runsRoot = ownerRunsRoot(deps.workDir, wsId, ownerId);
  const taskDirs = await namesIn(runsRoot);
  await finishRemovals(runsRoot, taskDirs);
  for (const taskId of taskDirs) {
    if (stopped(deps)) return;
    if (!isTaskId(taskId) || heldTaskIds.has(taskId)) continue;
    const archiveRoot = taskRunArchiveRoot(deps.workDir, wsId, ownerId, taskId);
    const months = await namesIn(archiveRoot);
    await finishRemovals(archiveRoot, months);
    for (const month of months) {
      if (!isRunArchiveMonth(month) || monthEndMs(month) > cutoffMs) continue;
      await removeDir(taskRunArchiveDir(deps.workDir, wsId, ownerId, taskId, month));
      report.archiveMonths++;
    }
  }
}

/** A ticket file's contents, or null when it does not parse as one. */
async function readTicketFile(file: string): Promise<RunTicket | null> {
  try {
    const ticket = JSON.parse(await readFile(file, "utf-8")) as RunTicket;
    return ticket && typeof ticket.runId === "string" && ticket.run ? ticket : null;
  } catch {
    return null;
  }
}

/**
 * Whether an ended ticket is past the window and no unsettled batch needs it.
 * `mtimeMs` stands in for a record with no readable end time.
 */
function ticketExpired(
  ticket: RunTicket,
  mtimeMs: number,
  cutoffMs: number,
  heldBatchIds: Set<string>,
): boolean {
  if (isOpenRun(ticket.run)) return false;
  const ended = endedMs(ticket.run);
  if ((Number.isFinite(ended) ? ended : mtimeMs) > cutoffMs) return false;
  return !(ticket.run.batchId && heldBatchIds.has(ticket.run.batchId));
}

/**
 * Delete each ended run's ticket past the window, and the idempotency key
 * that names the run, key first. A ticket is rewritten when its run ends, so
 * one modified inside the window is skipped unread.
 */
async function sweepTickets(sweep: OwnerSweep, heldBatchIds: Set<string>): Promise<void> {
  const { deps, wsId, ownerId, cutoffMs, report } = sweep;
  const dir = taskRunTicketsDir(deps.workDir, wsId, ownerId);
  for (const name of await namesIn(dir)) {
    if (stopped(deps)) return;
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > cutoffMs) continue;
    // A file that does not parse is one no reader can use, so it goes too.
    const ticket = await readTicketFile(file);
    if (ticket && !ticketExpired(ticket, mtimeMs, cutoffMs, heldBatchIds)) continue;
    const key = ticket?.run.idempotencyKey;
    if (ticket && key !== undefined && isTaskId(ticket.taskId)) {
      deleteIdempotencyKey(deps.workDir, wsId, ownerId, ticket.taskId, key, ticket.runId);
    }
    rmSync(file, { force: true });
    report.tickets++;
  }
}

/** A task definition file's contents, or null when it does not parse as the task `id`. */
async function readTaskFile(file: string, id: string): Promise<Task | null> {
  try {
    const task = JSON.parse(await readFile(file, "utf-8")) as Task;
    return task?.id === id ? task : null;
  } catch {
    return null;
  }
}

/** The latest time a task's definition says it was written or run, in epoch ms. */
function definitionActivityMs(task: Task): number {
  const times = [task.createdAt, task.updatedAt, task.lastRunAt]
    .map((t) => (t ? new Date(t).getTime() : Number.NaN))
    .filter(Number.isFinite);
  // A definition with no readable time is judged by its runs alone.
  return times.length > 0 ? Math.max(...times) : Number.NEGATIVE_INFINITY;
}

/**
 * Whether a one-off is past the window with nothing left to do: no trigger,
 * no run marked in flight, no batch record naming it, and neither its
 * definition nor its newest run touched inside the window.
 */
function oneoffExpired(sweep: OwnerSweep, task: Task, batchTaskIds: Set<string>): boolean {
  const { deps, wsId, ownerId, cutoffMs } = sweep;
  if (kindOf(task) !== "oneoff" || task.schedule || task.scheduledRunInFlight) return false;
  if (batchTaskIds.has(task.id) || definitionActivityMs(task) > cutoffMs) return false;
  const newest = readRuns(deps.workDir, wsId, ownerId, task.id, { limit: 1 })[0];
  // A newest run with no readable time keeps the one-off: it cannot be aged.
  return !newest || endedMs(newest) <= cutoffMs;
}

/**
 * Delete one one-off unless the scheduler carries a run of it or the
 * definition on disk now is not expired: its runs dir (renamed out of use),
 * then its definition. The definition is read here, not taken from the
 * caller, because a task update can replace the file after the sweep's
 * asynchronous read of it. Synchronous from the checks to the last removal, so
 * no run can be asked for and no definition written in between. Returns
 * whether it was deleted, and the renamed runs dir still to be unlinked.
 */
function deleteOneoff(
  sweep: OwnerSweep,
  id: string,
  batchTaskIds: Set<string>,
): { deleted: boolean; gone?: string } {
  const { deps, wsId, ownerId } = sweep;
  if (deps.isTaskBusy(wsId, ownerId, id)) return { deleted: false };
  const current = loadTask(deps.workDir, wsId, ownerId, id);
  if (current?.id !== id || !oneoffExpired(sweep, current, batchTaskIds)) return { deleted: false };
  const runsDir = taskRunsDir(deps.workDir, wsId, ownerId, id);
  const gone = existsSync(runsDir)
    ? expiredSiblingPath(runsDir, randomBytes(4).toString("hex"))
    : undefined;
  if (gone) renameSync(runsDir, gone);
  rmSync(taskFilePath(deps.workDir, wsId, ownerId, id), { force: true });
  deps.forgetTask(wsId, ownerId, id);
  return gone ? { deleted: true, gone } : { deleted: true };
}

/** Delete each expired one-off of one owner, and say so to the owner's views. */
async function sweepOneoffs(sweep: OwnerSweep, batchTaskIds: Set<string>): Promise<void> {
  const { deps, wsId, ownerId, report } = sweep;
  const dir = workspaceTasksDir(deps.workDir, wsId, ownerId);
  const before = report.oneoffs;
  for (const name of await namesIn(dir)) {
    if (stopped(deps)) break;
    const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    if (!isTaskId(id)) continue;
    const task = await readTaskFile(join(dir, name), id);
    if (!task || !oneoffExpired(sweep, task, batchTaskIds)) continue;
    const { deleted, gone } = deleteOneoff(sweep, id, batchTaskIds);
    if (deleted) report.oneoffs++;
    if (gone) await unlinkTree(gone);
  }
  if (report.oneoffs > before) deps.onOwnerChanged?.(ownerId);
}

/**
 * One pass over every workspace and owner. A failure in one owner's tree is
 * logged and the pass goes on to the next.
 */
export async function sweepRetention(deps: RetentionDeps): Promise<RetentionReport> {
  const report: RetentionReport = { archiveMonths: 0, tickets: 0, oneoffs: 0 };
  const cutoffMs = (deps.now?.() ?? Date.now()) - deps.retentionDays * DAY_MS;
  for (const { wsId, ownerId } of listTaskOwners(deps.workDir)) {
    if (stopped(deps)) break;
    try {
      // Read once per owner: a batch started during the pass names runs far
      // inside the window, which nothing below can reach.
      const batches = listBatches(deps.workDir, wsId, ownerId);
      const unsettled = batches.filter(isUnsettledBatch);
      const sweep: OwnerSweep = { deps, wsId, ownerId, cutoffMs, report };
      await sweepArchives(sweep, new Set(unsettled.map((b) => b.taskId)));
      await sweepTickets(sweep, new Set(unsettled.map((b) => b.id)));
      await sweepOneoffs(sweep, new Set(batches.map((b) => b.taskId)));
    } catch (err) {
      log.warn("[tasks] retention sweep failed for one owner", {
        workspaceId: wsId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

/** A running retention schedule. */
export interface RetentionSchedule {
  stop(): void;
}

/**
 * Sweep shortly after start and then once a day, until stopped. The tasks
 * source starts it beside the scheduler, so retention is something the
 * runtime does, never something an operator or a tool has to ask for. A sweep
 * still running when the next is due is left to finish.
 */
export function startRetentionSweep(
  deps: Omit<RetentionDeps, "stopped">,
  timing: { firstDelayMs?: number; intervalMs?: number } = {},
): RetentionSchedule {
  let isStopped = false;
  let sweeping = false;
  const run = async () => {
    if (isStopped || sweeping) return;
    sweeping = true;
    const started = Date.now();
    try {
      const report = await sweepRetention({ ...deps, stopped: () => isStopped });
      log.info("[tasks] retention sweep", { ...report, ms: Date.now() - started });
    } catch (err) {
      log.warn("[tasks] retention sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      sweeping = false;
    }
  };
  const first = setTimeout(() => void run(), timing.firstDelayMs ?? FIRST_SWEEP_DELAY_MS);
  const every = setInterval(() => void run(), timing.intervalMs ?? SWEEP_INTERVAL_MS);
  first.unref?.();
  every.unref?.();
  return {
    stop() {
      isStopped = true;
      clearTimeout(first);
      clearInterval(every);
    },
  };
}
