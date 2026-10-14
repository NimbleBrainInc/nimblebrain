/**
 * The batch driver: one task run over many inputs (`tasks__run_batch`,
 * ADR-0045). It lives in the tasks source, not the door: it feeds a batch's
 * items into runs through the scheduler's normal run path, and the door
 * (admission, fair share, spend accounts) never learns there is a batch
 * (ADR-0021).
 *
 * - **Concurrency.** At most `concurrency` of a batch's runs are asked for at
 *   once (queued at the door or running). The door's admission and fair share
 *   still apply on top, so a batch never takes more than the slots the door
 *   grants, and another workspace's run gets the next freed slot.
 * - **Budget.** A batch with `budgetUsd` names one more spend account on each
 *   run, `task-batch:<wsId>/<ownerId>/<batchId>` (usd). The door keeps one live
 *   balance per account id across every run naming it, so concurrent runs
 *   cannot together pass the budget. While the batch is running the driver
 *   holds the account open itself (an anchor hold that never spends), so the
 *   balance lives across the gaps between runs. It is seeded when the driver
 *   opens it (create, resume, boot) from the budget minus the batch's cost, the
 *   sum of its items' costs; boot charges a run lost in a crash from the usage
 *   ledger, so its spend still counts. When the balance is spent, or a run is
 *   stopped by the batch's account (or the task's token budget), no new item
 *   starts and the batch pauses with reason `budget`.
 * - **Pause.** No new item starts, and runs still queued at the door are
 *   withdrawn, their items back to pending; running runs finish.
 * - **Stop rule.** After `stopWhen.afterItems` assessed runs (pass, fail, or
 *   uncertain), a pass rate of pass / (pass + fail) under `minPassRate` pauses
 *   the batch (`pass_rate`) and notifies. Uncertain is excluded, so judge doubt
 *   alone cannot pause a batch. A resume after it disarms the rule.
 * - **Durability.** `start()` reconciles every unfinished batch: an item whose
 *   run was queued when the process stopped is asked for again (its old run is
 *   recorded skipped); one whose run was running is recorded failed (the run
 *   ended with the in-process engine) and is eligible for `rerun_failed`. Counts
 *   and cost are rebuilt from the items, and running batches resume driving.
 */

import { randomBytes } from "node:crypto";
import { log } from "../../observability/log.ts";
import { runDetached } from "../../runtime/request-context.ts";
import type { SpendBalances, SpendHold } from "../../runtime/spend.ts";
import { WorkspaceRootMissingError } from "../../workspace/context.ts";
import { executionOf, isAssessable } from "./assessment.ts";
import {
  appendBatchItem,
  bucketOf,
  compactBatchItems,
  countItems,
  emptyCounts,
  itemVerdictOf,
  listAllBatches,
  loadBatch,
  readBatchItems,
  saveBatch,
  saveBatchKey,
  sumCost,
  writeBatchItems,
} from "./batch-store.ts";
import {
  BATCH_ACCOUNT_PREFIX,
  type BatchRunOptions,
  type BatchRunTicket,
  BUDGET_ACCOUNT_PREFIX,
  isOpenRun,
  type RequestedRun,
  type RunSpendAccount,
} from "./scheduler.ts";
import { readRunTicket } from "./store.ts";
import type {
  Batch,
  BatchItem,
  BatchPauseReason,
  BatchStopRule,
  RunTicket,
  Task,
  TaskRun,
} from "./types.ts";

/** The most items one batch takes. */
export const MAX_BATCH_ITEMS = 10_000;

/** The most a batch's inputs may take together, serialized. Each is also held to a run's input cap. */
export const MAX_BATCH_INPUT_BYTES = 16 * 1024 * 1024;

/** How long a batch waits before asking again when the door's queue was full. */
const QUEUE_FULL_RETRY_MS = 5_000;

/** What the driver needs of the scheduler. */
export interface BatchScheduler {
  requestBatchRun(
    wsId: string,
    ownerId: string,
    taskId: string,
    requested: RequestedRun,
    options: BatchRunOptions,
  ): BatchRunTicket;
  cancelRunById(wsId: string, ownerId: string, runId: string): boolean;
  withdrawQueuedRun(wsId: string, ownerId: string, runId: string): boolean;
  settleLostRun(wsId: string, ownerId: string, ticket: RunTicket): RunTicket;
}

export interface BatchDriverConfig {
  workDir: string;
  scheduler: BatchScheduler;
  /**
   * The runtime's live spend balances (`Runtime.getSpendBalances`), for the
   * anchor hold on a running batch's account. Absent (tests): each run seeds
   * the account from the batch's recorded cost.
   */
  spend?: SpendBalances;
  /** Called after a batch of `ownerId`'s changed, so that owner's views refresh. */
  onChange?: (ownerId: string) => void;
  /** Tell the workspace a batch paused on its own (budget or stop rule). */
  notifyPaused?: (batch: Batch) => void;
  /** Override the wait after a full queue (tests). */
  retryDelayMs?: number;
  /**
   * What the usage ledger says each of `runIds` cost, in USD, by run id. The
   * ledger records each model call as it completes, so it knows what a run lost
   * in a crash spent before it could be recorded. Read once per batch at boot,
   * for its lost runs only; the cost lands on their items. Absent: a lost run
   * counts nothing.
   */
  ledgerCosts?: (batch: Batch, runIds: ReadonlySet<string>) => ReadonlyMap<string, number>;
}

/** What `create` is given, already validated. */
export interface NewBatch {
  wsId: string;
  ownerId: string;
  task: Task;
  inputs: readonly unknown[];
  concurrency: number;
  budgetUsd?: number;
  stopWhen?: BatchStopRule;
  idempotencyKey?: string;
  createdBy: string;
}

export type BatchAction = "pause" | "resume" | "cancel" | "rerun_failed";

/** What a control did. */
export interface BatchControlResult {
  batch: Batch;
  message: string;
  /** Items the action touched (cancelled, or put back to run). */
  affected: number;
}

/** A batch this process has loaded. */
interface LiveBatch {
  batch: Batch;
  items: BatchItem[];
  /** Indices of pending items, in the order they are asked for. */
  pending: number[];
  /** Indices of items whose run is asked for and has not ended. */
  outstanding: Set<number>;
  anchor?: SpendHold;
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Runs a pause took out of the queue: their items go back to pending. */
  withdrawn: Set<string>;
  /**
   * An item's run was refused by the batch's account only because other runs'
   * reservations held it: ask for nothing more until one of the batch's runs
   * ends and frees its reservation.
   */
  waitForSettle?: boolean;
  /** How many of the batch's runs that made a model call have ended in this process. */
  settled: number;
  /** `settled` when each outstanding run was asked for, by run id. */
  settledAtRequest: Map<string, number>;
}

/** The spend account id of a batch. Opaque to the door. */
export function batchAccountId(batch: Pick<Batch, "workspaceId" | "ownerId" | "id">): string {
  return `${BATCH_ACCOUNT_PREFIX}${batch.workspaceId}/${batch.ownerId}/${batch.id}`;
}

/** pass / (pass + fail), or null before either. Uncertain is excluded. */
export function passRateOf(counts: Pick<Batch["counts"], "pass" | "fail">): number | null {
  const judged = counts.pass + counts.fail;
  return judged === 0 ? null : counts.pass / judged;
}

/** Whether an item's outcome is one `rerun_failed` puts back: no deliverable, or a failing one. */
export function isRerunnable(item: BatchItem): boolean {
  if (item.state !== "done") return false;
  return (
    item.execution === "failed" ||
    item.execution === "skipped" ||
    item.execution === "cancelled" ||
    item.verdict === "fail"
  );
}

function newBatchId(): string {
  return `batch_${randomBytes(6).toString("hex")}`;
}

function newRunId(): string {
  return `run_${randomBytes(6).toString("hex")}`;
}

/** An item as asked for again: its current run moves to `previousRunIds`, its outcome is cleared. */
function backToPending(item: BatchItem): BatchItem {
  const next: BatchItem = {
    index: item.index,
    input: item.input,
    state: "pending",
    ...(item.costUsd !== undefined ? { costUsd: item.costUsd } : {}),
  };
  const previous = [...(item.previousRunIds ?? []), ...(item.runId ? [item.runId] : [])];
  if (previous.length > 0) next.previousRunIds = previous;
  return next;
}

export class BatchDriver {
  private readonly live = new Map<string, LiveBatch>();
  private stopping = false;

  constructor(private readonly config: BatchDriverConfig) {}

  private static keyOf(wsId: string, ownerId: string, batchId: string): string {
    return `${wsId}/${ownerId}/${batchId}`;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Reconcile every unfinished batch on disk and resume the running ones. Call after the scheduler starts. */
  start(): void {
    this.stopping = false;
    for (const stored of listAllBatches(this.config.workDir)) {
      const unsettled = stored.counts.queued + stored.counts.running > 0;
      if (stored.state !== "running" && stored.state !== "paused" && !unsettled) continue;
      try {
        const lb = this.reconcile(stored);
        this.live.set(BatchDriver.keyOf(stored.workspaceId, stored.ownerId, stored.id), lb);
        if (lb.batch.state === "running") this.activate(lb);
        else this.settleIdle(lb);
      } catch (err) {
        log.warn("[tasks] could not reconcile a batch", {
          batchId: stored.id,
          workspaceId: stored.workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Stop driving: no new item is asked for. Runs in flight end with the
   * scheduler; one that never started (dropped from the queue) puts its item
   * back to pending, so the next boot asks for it again.
   */
  stop(): void {
    this.stopping = true;
    for (const lb of this.live.values()) {
      if (lb.retryTimer) clearTimeout(lb.retryTimer);
      lb.retryTimer = undefined;
      this.releaseAnchor(lb);
    }
  }

  /** Forget the batches of a deleted workspace. */
  dropWorkspace(wsId: string): number {
    let dropped = 0;
    for (const [key, lb] of this.live) {
      if (!key.startsWith(`${wsId}/`)) continue;
      if (lb.retryTimer) clearTimeout(lb.retryTimer);
      this.releaseAnchor(lb);
      this.live.delete(key);
      dropped++;
    }
    return dropped;
  }

  /**
   * Rebuild a batch from its items after the process stopped: settle the runs
   * its items were waiting on, put never-started ones back to pending, and
   * recount.
   */
  private reconcile(stored: Batch): LiveBatch {
    const { workDir } = this.config;
    const { workspaceId: wsId, ownerId, id } = stored;
    const items = compactBatchItems(workDir, wsId, ownerId, id);
    let changed = false;
    const lost = new Map<string, number>();
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.state !== "queued" && item.state !== "running") continue;
      const settled = this.settleLostItem(stored, item);
      items[i] = settled.item;
      if (settled.lostRunId) lost.set(settled.lostRunId, i);
      changed = true;
    }
    this.chargeLostRuns(stored, items, lost);
    if (changed) writeBatchItems(workDir, wsId, ownerId, id, items);
    const batch: Batch = {
      ...stored,
      counts: countItems(items),
      costUsd: sumCost(items),
      updatedAt: changed ? new Date().toISOString() : stored.updatedAt,
    };
    saveBatch(workDir, batch);
    return {
      batch,
      items,
      pending: items.filter((it) => it.state === "pending").map((it) => it.index),
      outstanding: new Set(),
      withdrawn: new Set(),
      settled: 0,
      settledAtRequest: new Map(),
    };
  }

  /**
   * The outcome of an item whose run this process did not carry to its end: the
   * run's ticket, settled first when it was left open (queued becomes skipped,
   * running becomes failed). A run that never started is asked for again,
   * unless the batch was cancelled.
   */
  private settleLostItem(stored: Batch, item: BatchItem): { item: BatchItem; lostRunId?: string } {
    const { workDir, scheduler } = this.config;
    const { workspaceId: wsId, ownerId } = stored;
    let ticket = item.runId ? readRunTicket(workDir, wsId, ownerId, item.runId) : null;
    // A run still recorded running had no end record: it was lost with the process.
    const lostRunId = ticket?.run.status === "running" ? ticket.runId : undefined;
    if (ticket && isOpenRun(ticket.run)) ticket = scheduler.settleLostRun(wsId, ownerId, ticket);
    const run = ticket?.run;
    if (run?.trigger) {
      return { item: this.outcomeOf(item, run), ...(lostRunId ? { lostRunId } : {}) };
    }
    const again = backToPending(item);
    return {
      item:
        stored.state === "cancelled" ? { ...again, state: "done", execution: "cancelled" } : again,
    };
  }

  /**
   * Put what each lost run spent, by the usage ledger, on its item, so the
   * batch's budget counts it. One ledger read per batch, for its lost runs only.
   */
  private chargeLostRuns(stored: Batch, items: BatchItem[], lost: Map<string, number>): void {
    if (lost.size === 0 || !this.config.ledgerCosts) return;
    const costs = this.config.ledgerCosts(stored, new Set(lost.keys()));
    for (const [runId, index] of lost) {
      const spent = costs.get(runId) ?? 0;
      const item = items[index];
      if (item && spent > 0) items[index] = { ...item, costUsd: (item.costUsd ?? 0) + spent };
    }
  }

  // -------------------------------------------------------------------------
  // Create and read
  // -------------------------------------------------------------------------

  /** Write a new batch (items, then record, then its key) and start driving it. */
  create(spec: NewBatch): Batch {
    const { workDir } = this.config;
    const now = new Date().toISOString();
    const items: BatchItem[] = spec.inputs.map((input, index) => ({
      index,
      input,
      state: "pending",
    }));
    const batch: Batch = {
      id: newBatchId(),
      taskId: spec.task.id,
      workspaceId: spec.wsId,
      ownerId: spec.ownerId,
      items: items.length,
      concurrency: spec.concurrency,
      ...(spec.budgetUsd !== undefined ? { budgetUsd: spec.budgetUsd } : {}),
      ...(spec.stopWhen ? { stopWhen: spec.stopWhen } : {}),
      state: "running",
      counts: { ...emptyCounts(), pending: items.length },
      costUsd: 0,
      ...(spec.idempotencyKey !== undefined ? { idempotencyKey: spec.idempotencyKey } : {}),
      createdAt: now,
      updatedAt: now,
      createdBy: spec.createdBy,
    };
    writeBatchItems(workDir, spec.wsId, spec.ownerId, batch.id, items);
    saveBatch(workDir, batch);
    if (spec.idempotencyKey !== undefined) {
      saveBatchKey(workDir, spec.wsId, spec.ownerId, spec.idempotencyKey, batch.id);
    }
    const lb: LiveBatch = {
      batch,
      items,
      pending: items.map((it) => it.index),
      outstanding: new Set(),
      withdrawn: new Set(),
      settled: 0,
      settledAtRequest: new Map(),
    };
    this.live.set(BatchDriver.keyOf(spec.wsId, spec.ownerId, batch.id), lb);
    this.activate(lb);
    return { ...lb.batch };
  }

  /** A batch and its items, or null when this owner in this workspace has none by that id. */
  get(wsId: string, ownerId: string, batchId: string): { batch: Batch; items: BatchItem[] } | null {
    const lb = this.live.get(BatchDriver.keyOf(wsId, ownerId, batchId));
    if (lb) return { batch: { ...lb.batch }, items: lb.items };
    const batch = loadBatch(this.config.workDir, wsId, ownerId, batchId);
    if (!batch) return null;
    return { batch, items: readBatchItems(this.config.workDir, wsId, ownerId, batchId) };
  }

  /** A loaded batch, loading it from disk (without driving it) when this process has not. */
  private load(wsId: string, ownerId: string, batchId: string): LiveBatch | null {
    const key = BatchDriver.keyOf(wsId, ownerId, batchId);
    const existing = this.live.get(key);
    if (existing) return existing;
    const batch = loadBatch(this.config.workDir, wsId, ownerId, batchId);
    if (!batch) return null;
    const items = readBatchItems(this.config.workDir, wsId, ownerId, batchId);
    const lb: LiveBatch = {
      batch,
      items,
      pending: items.filter((it) => it.state === "pending").map((it) => it.index),
      outstanding: new Set(),
      withdrawn: new Set(),
      settled: 0,
      settledAtRequest: new Map(),
    };
    this.live.set(key, lb);
    return lb;
  }

  /**
   * A run of a batch item was re-assessed or given a person's verdict: carry
   * its verdict onto the item when it is the item's current run.
   */
  syncRun(wsId: string, ownerId: string, run: TaskRun): void {
    if (!run.batchId || run.batchIndex === undefined) return;
    const lb = this.load(wsId, ownerId, run.batchId);
    const item = lb?.items[run.batchIndex];
    if (!lb || !item || item.runId !== run.id || item.state !== "done") return;
    const verdict = isAssessable(run) ? itemVerdictOf(run) : undefined;
    if (verdict === item.verdict) return;
    const next: BatchItem = { ...item };
    if (verdict) next.verdict = verdict;
    else delete next.verdict;
    this.setItem(lb, next);
    this.persistBatch(lb);
    this.settleIdle(lb);
  }

  /** Whether this process holds the batch in memory (for inspection/testing). */
  isResident(wsId: string, ownerId: string, batchId: string): boolean {
    return this.live.has(BatchDriver.keyOf(wsId, ownerId, batchId));
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  /** Pause, resume, cancel, or re-run the failed items of a batch. Throws on an action its state refuses. */
  control(
    wsId: string,
    ownerId: string,
    batchId: string,
    action: BatchAction,
    budgetUsd?: number,
  ): BatchControlResult {
    const lb = this.load(wsId, ownerId, batchId);
    if (!lb) throw new Error(`Batch not found: "${batchId}".`);
    try {
      if (budgetUsd !== undefined && action !== "resume") {
        throw new Error(
          "budgetUsd goes with `resume`: it sets the budget the batch resumes under.",
        );
      }
      switch (action) {
        case "pause":
          return this.controlPause(lb);
        case "resume":
          return this.controlResume(lb, budgetUsd);
        case "cancel":
          return this.controlCancel(lb);
        case "rerun_failed":
          return this.controlRerun(lb);
      }
    } finally {
      // A batch loaded only to answer this, or left idle by it, goes back to disk.
      this.settleIdle(lb);
    }
  }

  private answer(lb: LiveBatch, message: string, affected = 0): BatchControlResult {
    return { batch: { ...lb.batch }, message, affected };
  }

  private controlPause(lb: LiveBatch): BatchControlResult {
    if (lb.batch.state !== "running") {
      throw new Error(`Batch "${lb.batch.id}" is ${lb.batch.state}; only a running batch pauses.`);
    }
    this.pause(lb, "manual", "Paused by a person.");
    return this.answer(
      lb,
      `Batch "${lb.batch.id}" paused: no new item starts. ${lb.outstanding.size} run(s) already ` +
        "asked for finish.",
    );
  }

  private controlResume(lb: LiveBatch, budgetUsd: number | undefined): BatchControlResult {
    const { batch } = lb;
    if (batch.state === "cancelled") throw new Error(`Batch "${batch.id}" is cancelled.`);
    if (batch.state === "completed") {
      throw new Error(
        `Batch "${batch.id}" is completed; use rerun_failed to run its failed items again.`,
      );
    }
    if (batch.state === "running") {
      if (budgetUsd !== undefined) {
        throw new Error(
          `Batch "${batch.id}" is running: pause the batch first to change its budget, then ` +
            "resume it with the new budget.",
        );
      }
      return this.answer(lb, `Batch "${batch.id}" is already running.`);
    }
    if (budgetUsd !== undefined) this.setBudget(lb, budgetUsd);
    if (batch.pause?.reason === "pass_rate") batch.stopRuleDisarmed = true;
    batch.state = "running";
    delete batch.pause;
    this.persistBatch(lb);
    this.activate(lb);
    return this.answer(
      lb,
      `Batch "${batch.id}" resumed.${batch.stopRuleDisarmed ? " Its stop rule is no longer applied." : ""}`,
    );
  }

  /**
   * Set a new budget. Refused while runs that hold the batch's account are in
   * flight and the driver does not hold it: the live balance they share was
   * seeded from the old budget, and the door has no way to raise it.
   */
  private setBudget(lb: LiveBatch, budgetUsd: number): void {
    const { batch } = lb;
    const spent = batch.costUsd;
    if (!(budgetUsd > spent)) {
      throw new Error(
        `budgetUsd must be more than the $${spent.toFixed(4)} the batch has already spent.`,
      );
    }
    if (batch.budgetUsd === budgetUsd) return;
    const liveBalance = this.config.spend?.balance(batchAccountId(batch));
    if (liveBalance !== undefined) {
      throw new Error(
        `Batch "${batch.id}" has ${lb.outstanding.size} run(s) in flight sharing its current budget. ` +
          "Pause it, and resume with the new budget once they end.",
      );
    }
    batch.budgetUsd = budgetUsd;
  }

  private controlCancel(lb: LiveBatch): BatchControlResult {
    const { batch } = lb;
    if (batch.state === "cancelled")
      return this.answer(lb, `Batch "${batch.id}" is already cancelled.`);
    if (batch.state === "completed") throw new Error(`Batch "${batch.id}" is already completed.`);
    batch.state = "cancelled";
    delete batch.pause;
    if (lb.retryTimer) clearTimeout(lb.retryTimer);
    lb.retryTimer = undefined;
    let affected = 0;
    for (const item of lb.items) {
      if (item.state !== "pending") continue;
      this.setItem(lb, { ...item, state: "done", execution: "cancelled" });
      affected++;
    }
    lb.pending = [];
    // Queued runs leave the queue recorded cancelled; running ones abort. Each
    // item is settled when its run's record lands (`itemEnded`).
    for (const index of [...lb.outstanding]) {
      const runId = lb.items[index]?.runId;
      if (runId && this.config.scheduler.cancelRunById(batch.workspaceId, batch.ownerId, runId)) {
        affected++;
      }
    }
    this.releaseAnchor(lb);
    this.persistBatch(lb);
    return this.answer(
      lb,
      `Batch "${batch.id}" cancelled: ${affected} item(s) stopped or never to start.`,
      affected,
    );
  }

  private controlRerun(lb: LiveBatch): BatchControlResult {
    const { batch } = lb;
    if (batch.state === "cancelled") throw new Error(`Batch "${batch.id}" is cancelled.`);
    const again = lb.items.filter(isRerunnable);
    if (again.length === 0) {
      return this.answer(lb, `Batch "${batch.id}" has no failed items to run again.`);
    }
    for (const item of again) {
      this.setItem(lb, backToPending(item));
      lb.pending.push(item.index);
    }
    if (batch.state !== "running") {
      if (batch.pause?.reason === "pass_rate") batch.stopRuleDisarmed = true;
      batch.state = "running";
      delete batch.pause;
      delete batch.completedAt;
    }
    this.persistBatch(lb);
    this.activate(lb);
    return this.answer(
      lb,
      `Batch "${batch.id}": ${again.length} failed item(s) queued to run again, each as a new run.`,
      again.length,
    );
  }

  // -------------------------------------------------------------------------
  // Driving
  // -------------------------------------------------------------------------

  /** Hold the batch's account open while it runs, then ask for items. */
  private activate(lb: LiveBatch): void {
    const { batch } = lb;
    lb.waitForSettle = false;
    if (this.config.spend && batch.budgetUsd !== undefined && !lb.anchor) {
      lb.anchor = this.config.spend.open(this.accountsFor(lb), { model: "", rates: null });
    }
    this.pump(lb);
  }

  private releaseAnchor(lb: LiveBatch): void {
    lb.anchor?.release();
    lb.anchor = undefined;
  }

  /** The spend accounts a run of this batch names beyond the task's own. */
  private accountsFor(lb: LiveBatch): RunSpendAccount[] {
    const { batch } = lb;
    if (batch.budgetUsd === undefined) return [];
    return [
      {
        id: batchAccountId(batch),
        unit: "usd",
        remaining: Math.max(0, batch.budgetUsd - lb.batch.costUsd),
      },
    ];
  }

  /** Whether the batch's budget has nothing left for another run. */
  private budgetSpent(lb: LiveBatch): boolean {
    const { batch } = lb;
    if (batch.budgetUsd === undefined) return false;
    const left =
      this.config.spend?.balance(batchAccountId(batch)) ?? batch.budgetUsd - lb.batch.costUsd;
    return left <= 0;
  }

  /** Ask for items while the batch is under its concurrency; complete it when nothing is left. */
  private pump(lb: LiveBatch): void {
    if (lb.batch.state !== "running") {
      this.settleIdle(lb);
      return;
    }
    if (this.stopping || lb.retryTimer || lb.waitForSettle) return;
    while (lb.outstanding.size < lb.batch.concurrency) {
      const index = this.nextPending(lb);
      if (index === undefined) break;
      if (this.budgetSpent(lb)) {
        lb.pending.unshift(index);
        this.pause(lb, "budget", "The batch's budget has nothing left for another run.");
        return;
      }
      if (!this.requestItem(lb, index)) return;
    }
    if (lb.outstanding.size === 0 && lb.pending.length === 0) this.complete(lb);
  }

  /**
   * A batch that is not running and has no run in flight leaves memory: its
   * record and items are on disk, and a later read or control loads them
   * again. A paused one with nothing left to run is completed first.
   */
  private settleIdle(lb: LiveBatch): void {
    const { batch } = lb;
    if (batch.state === "running" || lb.outstanding.size > 0) return;
    if (batch.state === "paused" && !lb.items.some((item) => item.state === "pending")) {
      delete batch.pause;
      this.complete(lb);
    }
    if (lb.retryTimer) clearTimeout(lb.retryTimer);
    lb.retryTimer = undefined;
    this.releaseAnchor(lb);
    const key = BatchDriver.keyOf(batch.workspaceId, batch.ownerId, batch.id);
    if (this.live.get(key) === lb) this.live.delete(key);
  }

  /** The next item still pending, or undefined. */
  private nextPending(lb: LiveBatch): number | undefined {
    while (lb.pending.length > 0) {
      const index = lb.pending.shift()!;
      if (lb.items[index]?.state === "pending") return index;
    }
    return undefined;
  }

  /** Ask for one item's run. False when it was refused and the batch should stop asking for now. */
  private requestItem(lb: LiveBatch, index: number): boolean {
    const { batch } = lb;
    const item = lb.items[index]!;
    const requested: RequestedRun = {
      runId: newRunId(),
      requestedAt: new Date().toISOString(),
      ...(item.input !== undefined ? { input: item.input } : {}),
      batch: { batchId: batch.id, index },
    };
    const ticket = this.config.scheduler.requestBatchRun(
      batch.workspaceId,
      batch.ownerId,
      batch.taskId,
      requested,
      {
        accounts: () => this.accountsFor(lb),
        onStarted: () => this.itemStarted(lb, index, requested.runId),
      },
    );
    if (ticket.state === "refused") {
      lb.pending.unshift(index);
      if (ticket.reason === "queue_full") {
        lb.retryTimer = runDetached(() =>
          setTimeout(() => {
            lb.retryTimer = undefined;
            this.pump(lb);
          }, this.config.retryDelayMs ?? QUEUE_FULL_RETRY_MS),
        );
      } else if (ticket.reason === "budget") {
        this.pause(lb, "budget", ticket.message);
      } else if (ticket.reason === "not_found") {
        this.pause(lb, "unavailable", `The batch's task cannot be run: ${ticket.message}.`);
      }
      return false;
    }
    lb.outstanding.add(index);
    lb.settledAtRequest.set(requested.runId, lb.settled);
    this.setItem(lb, {
      ...item,
      state: ticket.state === "started" ? "running" : "queued",
      runId: requested.runId,
    });
    this.persistBatch(lb);
    ticket.run.then(
      (run) => this.itemEnded(lb, index, requested.runId, run),
      (err) => {
        log.warn("[tasks] a batch run settled with an error", {
          batchId: batch.id,
          runId: requested.runId,
          error: err instanceof Error ? err.message : String(err),
        });
        lb.outstanding.delete(index);
        const current = lb.items[index];
        if (current?.runId === requested.runId) {
          this.setItem(lb, {
            ...current,
            state: "done",
            execution: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
          this.persistBatch(lb);
        }
        this.pump(lb);
      },
    );
    return true;
  }

  /** A queued item's run took its slot. */
  private itemStarted(lb: LiveBatch, index: number, runId: string): void {
    const item = lb.items[index];
    if (item?.runId !== runId || item.state !== "queued") return;
    this.setItem(lb, { ...item, state: "running" });
    this.persistBatch(lb);
  }

  /** An item's outcome from its run's record. */
  private outcomeOf(item: BatchItem, run: TaskRun): BatchItem {
    const execution = executionOf(run);
    const verdict = isAssessable(run) ? itemVerdictOf(run) : undefined;
    return {
      index: item.index,
      input: item.input,
      state: "done",
      runId: run.id,
      ...(item.previousRunIds ? { previousRunIds: item.previousRunIds } : {}),
      execution,
      ...(verdict ? { verdict } : {}),
      ...(run.status === "degraded" || run.unrecoveredToolFailures?.length
        ? { degraded: true }
        : {}),
      costUsd: (item.costUsd ?? 0) + (run.costUsd ?? 0),
      ...(run.error ? { error: run.error } : {}),
    };
  }

  /** An item's run ended (recorded, and assessed when it left a deliverable). */
  private itemEnded(lb: LiveBatch, index: number, runId: string, run: TaskRun): void {
    lb.outstanding.delete(index);
    const item = lb.items[index];
    if (!item || item.runId !== runId) return;
    const batchStop =
      run.stopReason === "spend_limit" && run.spendAccountId === batchAccountId(lb.batch);
    // Any run ending frees its reservation, so a reserved-out item may run now.
    lb.waitForSettle = false;
    // A batch run that ended after this one was asked for may have held the
    // reservation that refused it, even though it is gone by now.
    const endedSince = lb.settled > (lb.settledAtRequest.get(runId) ?? lb.settled);
    lb.settledAtRequest.delete(runId);
    // Only a run that made a model call ever held a reservation; counting a
    // refused one would let two refused items keep re-asking for each other.
    if (run.inputTokens > 0 || run.outputTokens > 0) lb.settled++;
    const reservedOut = batchStop && this.reservedOut(lb, endedSince);
    this.settleItem(lb, index, run, batchStop, lb.withdrawn.delete(runId));
    if (reservedOut) {
      // Wait for a reservation still held to free; with none held, ask again now.
      lb.waitForSettle = this.othersRunning(lb);
    } else if (batchStop) {
      this.pause(lb, "budget", "The batch's budget has too little left for another model call.");
    } else if (
      run.stopReason === "spend_limit" &&
      run.spendAccountId?.startsWith(BUDGET_ACCOUNT_PREFIX)
    ) {
      this.pause(lb, "budget", "The task's token budget is spent for its window.");
    }
    this.applyStopRule(lb);
    this.persistBatch(lb);
    this.pump(lb);
  }

  /** Give an item its run's outcome, or put it back to run again when the run did not really have its turn. */
  private settleItem(
    lb: LiveBatch,
    index: number,
    run: TaskRun,
    batchStop: boolean,
    withdrawn: boolean,
  ): void {
    const settled = this.outcomeOf(lb.items[index]!, run);
    const producedNothing = settled.execution === "failed" || settled.execution === "skipped";
    let again = false;
    if (!run.trigger && (this.stopping || withdrawn)) {
      // Dropped from the queue as the runtime stopped (asked again next boot),
      // or taken out of it by a pause (asked again on resume).
      again = true;
    } else if (batchStop && producedNothing) {
      // Stopped by the batch's account before it produced anything: it runs
      // again once a reservation frees, or under a raised budget.
      again = true;
    }
    if (!again) {
      this.setItem(lb, settled);
    } else if (lb.batch.state === "cancelled") {
      // A cancelled batch runs nothing again: the item settles as cancelled.
      this.setItem(lb, { ...backToPending(settled), state: "done", execution: "cancelled" });
    } else {
      this.setItem(lb, backToPending(settled));
      if (!this.stopping) lb.pending.unshift(index);
    }
  }

  /**
   * Whether a stop by the batch's account came from other runs' reservations
   * rather than from spend. Only the batch's own running runs reserve against
   * its account (the driver's anchor never does), so with none of them still
   * running, a refusal means the actual balance cannot pay for one call: spent.
   * With one running, or one that ended since this run was asked for (its
   * reservation may have refused the call before it ended), and actual balance
   * left, the item gets another turn: a second refusal with nothing reserving
   * is spend.
   */
  private reservedOut(lb: LiveBatch, endedSince: boolean): boolean {
    const { batch } = lb;
    if (batch.budgetUsd === undefined) return false;
    if (!endedSince && !this.othersRunning(lb)) return false;
    const actual =
      this.config.spend?.balance(batchAccountId(batch)) ?? batch.budgetUsd - batch.costUsd;
    return actual > 0;
  }

  /** Whether another of the batch's runs is running (and so may hold a reservation). */
  private othersRunning(lb: LiveBatch): boolean {
    return [...lb.outstanding].some((i) => lb.items[i]?.state === "running");
  }

  /** Pause the batch when its pass rate fell below its stop rule. */
  private applyStopRule(lb: LiveBatch): void {
    const { batch } = lb;
    const rule = batch.stopWhen;
    if (!rule || batch.stopRuleDisarmed || batch.state !== "running") return;
    const { pass, fail, uncertain } = batch.counts;
    const assessed = pass + fail + uncertain;
    if (assessed < rule.afterItems) return;
    const rate = passRateOf(batch.counts);
    if (rate === null || rate >= rule.minPassRate) return;
    this.pause(
      lb,
      "pass_rate",
      `Pass rate ${(rate * 100).toFixed(1)}% (pass ${pass}, fail ${fail}; uncertain excluded) ` +
        `fell below ${(rule.minPassRate * 100).toFixed(1)}% after ${assessed} assessed runs.`,
    );
  }

  private pause(lb: LiveBatch, reason: BatchPauseReason, message: string): void {
    const { batch } = lb;
    if (batch.state !== "running") return;
    batch.state = "paused";
    batch.pause = { reason, message, at: new Date().toISOString() };
    if (lb.retryTimer) clearTimeout(lb.retryTimer);
    lb.retryTimer = undefined;
    // Runs still waiting at the door give their places back; running ones finish.
    for (const index of lb.outstanding) {
      const item = lb.items[index];
      if (item?.state !== "queued" || !item.runId) continue;
      lb.withdrawn.add(item.runId);
      if (!this.config.scheduler.withdrawQueuedRun(batch.workspaceId, batch.ownerId, item.runId)) {
        lb.withdrawn.delete(item.runId);
      }
    }
    this.releaseAnchor(lb);
    this.persistBatch(lb);
    if (reason === "budget" || reason === "pass_rate") this.config.notifyPaused?.({ ...batch });
  }

  private complete(lb: LiveBatch): void {
    const { batch } = lb;
    batch.state = "completed";
    batch.completedAt = new Date().toISOString();
    this.guard(lb, () =>
      writeBatchItems(this.config.workDir, batch.workspaceId, batch.ownerId, batch.id, lb.items),
    );
    this.persistBatch(lb);
    this.settleIdle(lb);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Replace an item, keep the counts and cost in step, and append its new state. */
  private setItem(lb: LiveBatch, next: BatchItem): void {
    const prev = lb.items[next.index];
    if (!prev) return;
    lb.batch.counts[bucketOf(prev)]--;
    lb.batch.counts[bucketOf(next)]++;
    lb.batch.costUsd += (next.costUsd ?? 0) - (prev.costUsd ?? 0);
    lb.items[next.index] = next;
    const { batch } = lb;
    this.guard(lb, () =>
      appendBatchItem(this.config.workDir, batch.workspaceId, batch.ownerId, batch.id, next),
    );
  }

  private persistBatch(lb: LiveBatch): void {
    lb.batch.updatedAt = new Date().toISOString();
    this.guard(lb, () => saveBatch(this.config.workDir, lb.batch));
    this.config.onChange?.(lb.batch.ownerId);
  }

  /**
   * Run a write; a write that fails is logged, and a workspace that is gone
   * drops the batch, since nothing it does can be recorded.
   */
  private guard(lb: LiveBatch, write: () => void): void {
    try {
      write();
    } catch (err) {
      log.warn("[tasks] could not write a batch", {
        batchId: lb.batch.id,
        workspaceId: lb.batch.workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof WorkspaceRootMissingError) {
        lb.batch.state = "cancelled";
        this.dropWorkspace(lb.batch.workspaceId);
      }
    }
  }
}
