/**
 * Batches: one task run over many inputs (`run_batch`). A batch asks for its
 * items' runs itself, at most `sharing` (its concurrency, lowered by budget
 * stops) queued or running at once: each is a queued run record `due` lists,
 * and every run's end (`end_run`) settles its item and asks for the next.
 *
 * - **The budget is one spend account** (`task-batch:<batchId>`, usd) every run of the
 *   batch names, holding `budgetUsd` minus what the batch's ended runs cost, shared by
 *   `sharing` runs. The host enforces it; the outcome says which account stopped a run and
 *   why (`spendStop`).
 * - **A stop by an account the batch shares** (its own, or the task's token budget):
 *   `reserved` (other runs held what was left) puts the item back and waits for another run
 *   to end; `exhausted` after a model call by one of several sharing runs halves `sharing`
 *   and puts the item back; `exhausted` by a run that held the whole of what was left and
 *   made a call settles the item `exceeds_share` while another item still fits; otherwise
 *   the budget is spent and the batch pauses. An item that produced nothing goes back to
 *   pending rather than settling.
 * - **Pause withdraws** runs still queued (ended skipped, their items pending); running
 *   ones finish. **Cancel** cancels queued runs, stops running ones (`due`'s `cancel`), and
 *   settles pending items cancelled. A cancelled batch runs nothing again.
 * - **The stop rule** pauses the batch when pass / (pass + fail) falls below `minPassRate`
 *   after `afterItems` assessed runs; a resume or `rerun_failed` after it disarms it.
 */

import { conflict } from "./contract.ts";
import type { Batch, BatchItem, Notice, RunRecord, WorkspaceState } from "./model.ts";
import { newRunId, taskByUid } from "./records.ts";
import { executionOf, isAssessable } from "./runs.ts";
import { BUDGET_ACCOUNT_PREFIX } from "./schedule.ts";
import type { Tx } from "./store.ts";

export const BATCH_ACCOUNT_PREFIX = "task-batch:";

export function batchAccountId(batch: Pick<Batch, "id">): string {
  return `${BATCH_ACCOUNT_PREFIX}${batch.id}`;
}

export function sharingOf(batch: Pick<Batch, "concurrency" | "sharing">): number {
  return Math.max(1, Math.min(batch.concurrency, batch.sharing ?? batch.concurrency));
}

export function costOf(batch: Batch): number {
  return batch.items.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
}

/** The batch's spend account for a run beginning now, when it has a budget. */
export function batchAccount(batch: Batch) {
  if (batch.budgetUsd === undefined) return undefined;
  return {
    id: batchAccountId(batch),
    unit: "usd" as const,
    remaining: Math.max(0, batch.budgetUsd - costOf(batch)),
    sharedBy: sharingOf(batch),
  };
}

export type Bucket =
  | "pending"
  | "queued"
  | "running"
  | "pass"
  | "fail"
  | "uncertain"
  | "not_assessed"
  | "failed"
  | "skipped"
  | "cancelled";

export function bucketOf(item: BatchItem): Bucket {
  if (item.state !== "done") return item.state;
  if (
    item.execution === "failed" ||
    item.execution === "skipped" ||
    item.execution === "cancelled"
  ) {
    return item.execution;
  }
  return item.verdict ?? "not_assessed";
}

export function countsOf(batch: Batch): Record<Bucket, number> {
  const counts: Record<Bucket, number> = {
    pending: 0,
    queued: 0,
    running: 0,
    pass: 0,
    fail: 0,
    uncertain: 0,
    not_assessed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const item of batch.items) counts[bucketOf(item)]++;
  return counts;
}

export function passRateOf(counts: Record<Bucket, number>): number | undefined {
  const judged = counts.pass + counts.fail;
  return judged === 0 ? undefined : counts.pass / judged;
}

/** Whether `rerun_failed` puts the item back. */
export function isRerunnable(item: BatchItem): boolean {
  if (item.state !== "done") return false;
  return (
    item.errorCode !== undefined ||
    item.execution === "failed" ||
    item.execution === "skipped" ||
    item.execution === "cancelled" ||
    item.verdict === "fail"
  );
}

function inFlight(batch: Batch): number {
  return batch.items.filter((i) => i.state === "queued" || i.state === "running").length;
}

function backToPending(item: BatchItem): BatchItem {
  const next: BatchItem = { state: "pending" };
  if (item.costUsd !== undefined) next.costUsd = item.costUsd;
  const previous = [...(item.previousRunIds ?? []), ...(item.runId ? [item.runId] : [])];
  if (previous.length > 0) next.previousRunIds = previous;
  return next;
}

/** Ask for items' runs while the batch is under its sharing; complete it when nothing is left. */
export function pumpBatch(tx: Tx, batch: Batch, at: string): Notice[] {
  if (batch.state !== "running") {
    settleIdle(batch, at);
    return [];
  }
  if (batch.waitForSettle) return [];
  const task = taskByUid(tx.ws.state, batch.taskUid);
  if (!task) return pause(tx, batch, "unavailable", "The batch's task was deleted.", at);
  let running = inFlight(batch);
  for (let index = 0; running < sharingOf(batch) && index < batch.items.length; index++) {
    const item = batch.items[index] as BatchItem;
    if (item.state !== "pending") continue;
    if (batch.budgetUsd !== undefined && batch.budgetUsd - costOf(batch) <= 0) {
      return pause(
        tx,
        batch,
        "budget",
        `The batch's budget has nothing left for another run (${spentOf(batch)}).`,
        at,
      );
    }
    const run: RunRecord = {
      id: newRunId(),
      taskId: task.id,
      taskUid: task.uid,
      ownerId: batch.ownerId,
      trigger: "manual",
      status: "queued",
      requestedAt: at,
      batchId: batch.id,
      batchIndex: index,
      inputTokens: 0,
      outputTokens: 0,
      iterations: 0,
      toolCalls: 0,
    };
    tx.ws.state.open[run.id] = run;
    batch.items[index] = { ...item, state: "queued", runId: run.id };
    running++;
    tx.changed();
  }
  if (running === 0 && !batch.items.some((i) => i.state === "pending")) complete(batch, at);
  return [];
}

function complete(batch: Batch, at: string): void {
  batch.state = "completed";
  batch.completedAt = at;
  batch.updatedAt = at;
  delete batch.pause;
  delete batch.waitForSettle;
}

/** A batch not running, with nothing in flight and nothing pending, is completed. */
function settleIdle(batch: Batch, at: string): void {
  if (batch.state !== "paused" || inFlight(batch) > 0) return;
  if (batch.items.some((i) => i.state === "pending")) return;
  complete(batch, at);
}

function spentOf(batch: Batch): string {
  const budget = batch.budgetUsd === undefined ? "" : ` of $${batch.budgetUsd.toFixed(4)}`;
  return `$${costOf(batch).toFixed(4)} spent${budget}`;
}

/** Pause a running batch, taking back runs still queued. Budget and pass-rate pauses raise a notice. */
export function pause(
  tx: Tx,
  batch: Batch,
  reason: NonNullable<Batch["pause"]>["reason"],
  message: string,
  at: string,
): Notice[] {
  if (batch.state !== "running") return [];
  batch.state = "paused";
  batch.pause = { reason, message, at };
  batch.updatedAt = at;
  delete batch.waitForSettle;
  withdrawQueued(tx, batch, at);
  settleIdle(batch, at);
  return reason === "budget" || reason === "pass_rate" ? [pausedNotice(batch)] : [];
}

/** Runs not yet begun give their places back: ended skipped, their items pending. */
function withdrawQueued(tx: Tx, batch: Batch, at: string): void {
  batch.items.forEach((item, index) => {
    const run = item.runId ? tx.ws.state.open[item.runId] : undefined;
    if (item.state !== "queued" || !run || run.status !== "queued") return;
    tx.endRun({ ...run, status: "skipped", error: "Withdrawn by its batch", completedAt: at });
    batch.items[index] = backToPending(item);
    tx.changed();
  });
}

function pausedNotice(batch: Batch): Notice {
  const counts = countsOf(batch);
  const done = batch.items.length - counts.pending - counts.queued - counts.running;
  const why =
    batch.pause?.reason === "pass_rate"
      ? "its pass rate fell below its stop rule"
      : "its budget has too little left for another item";
  return {
    id: `batch-paused:${batch.id}:${batch.pause?.at ?? batch.updatedAt}`,
    title: "A batch of scheduled task runs paused",
    body:
      `Batch ${batch.id} of owner ${batch.ownerId} paused because ${why} (${done} of ` +
      `${batch.items.length} done: ${counts.pass} pass, ${counts.fail} fail). Its owner can resume or cancel it in Scheduled.`,
    level: "attention",
  };
}

/** An item's outcome from its run's ended record. */
function outcomeOf(item: BatchItem, run: RunRecord): BatchItem {
  const out: BatchItem = { state: "done", runId: run.id, execution: executionOf(run) };
  if (item.previousRunIds) out.previousRunIds = item.previousRunIds;
  const verdict = isAssessable(run) ? run.assessment?.verdict : undefined;
  if (verdict) out.verdict = verdict;
  if (run.status === "degraded" || run.unrecoveredToolFailures?.length) out.degraded = true;
  out.costUsd = (item.costUsd ?? 0) + (run.costUsd ?? 0);
  if (run.error) out.error = run.error;
  return out;
}

type BudgetStop = "none" | "again" | "exceeds_share" | "batch_spent" | "budget_spent";

/** What a run's spend stop means for its batch. */
function budgetStopOf(batch: Batch, run: RunRecord, othersCost: number): BudgetStop {
  if (run.stopReason !== "spend_limit" || run.spendAccountId === undefined) return "none";
  const batchStop = run.spendAccountId === batchAccountId(batch);
  if (!batchStop && !run.spendAccountId.startsWith(BUDGET_ACCOUNT_PREFIX)) return "none";
  if (run.spendStop === "reserved") return "again";
  const madeCall = run.inputTokens > 0 || run.outputTokens > 0;
  const sharedBy = run.sharedBy ?? sharingOf(batch);
  if (madeCall && sharedBy > 1) {
    batch.sharing = Math.max(1, Math.min(sharingOf(batch), Math.floor(sharedBy / 2)));
    return "again";
  }
  if (batchStop && madeCall && anotherItemFits(batch, othersCost + (run.costUsd ?? 0))) {
    return "exceeds_share";
  }
  return batchStop ? "batch_spent" : "budget_spent";
}

/** Whether what is left of the budget can pay for another item: more than the cheapest completed one cost. */
function anotherItemFits(batch: Batch, spent: number): boolean {
  if (batch.budgetUsd === undefined) return false;
  let cheapest = 0;
  for (const item of batch.items) {
    if (item.state !== "done" || item.execution !== "completed" || !item.costUsd) continue;
    cheapest = cheapest === 0 ? item.costUsd : Math.min(cheapest, item.costUsd);
  }
  return batch.budgetUsd - spent > cheapest;
}

/** Settle the item of a batch run that ended; answers the notices the batch raises. */
export function batchRunEnded(tx: Tx, batch: Batch, run: RunRecord, at: string): Notice[] {
  const index = run.batchIndex ?? -1;
  const item = batch.items[index];
  if (!item || item.runId !== run.id) return [];
  // Any run ending frees what it reserved, so an item another run's reservation refused may run.
  delete batch.waitForSettle;
  const othersCost = costOf(batch) - (item.costUsd ?? 0);
  const stop = budgetStopOf(batch, run, othersCost);
  const settled = outcomeOf(item, run);
  const producedNothing = settled.execution === "failed" || settled.execution === "skipped";
  const again = stop !== "none" && stop !== "exceeds_share" && producedNothing;
  if (stop === "exceeds_share") {
    settled.errorCode = "exceeds_share";
    settled.error =
      "exceeds_share: a run of this item with what was left of the batch's budget to itself " +
      "was stopped by it. rerun_failed with a higher budgetUsd runs it again.";
  }
  if (!again) batch.items[index] = settled;
  else if (batch.state === "cancelled")
    batch.items[index] = { ...backToPending(settled), state: "done", execution: "cancelled" };
  else batch.items[index] = backToPending(settled);
  batch.updatedAt = at;
  const notices: Notice[] = [];
  if (stop === "again" && othersRunning(tx.ws.state, batch)) batch.waitForSettle = true;
  if (stop === "batch_spent") {
    notices.push(
      ...pause(
        tx,
        batch,
        "budget",
        `The batch's budget has too little left for another item (${spentOf(batch)}).`,
        at,
      ),
    );
  } else if (stop === "budget_spent") {
    notices.push(
      ...pause(tx, batch, "budget", "The task's token budget is spent for its window.", at),
    );
  }
  notices.push(...applyStopRule(tx, batch, at));
  notices.push(...pumpBatch(tx, batch, at));
  return notices;
}

function othersRunning(state: WorkspaceState, batch: Batch): boolean {
  return batch.items.some((i) => i.state === "running" && i.runId && state.open[i.runId]);
}

function applyStopRule(tx: Tx, batch: Batch, at: string): Notice[] {
  const rule = batch.stopWhen;
  if (!rule || batch.stopRuleDisarmed || batch.state !== "running") return [];
  const counts = countsOf(batch);
  const assessed = counts.pass + counts.fail + counts.uncertain;
  if (assessed < rule.afterItems) return [];
  const rate = passRateOf(counts);
  if (rate === undefined || rate >= rule.minPassRate) return [];
  return pause(
    tx,
    batch,
    "pass_rate",
    `Pass rate ${(rate * 100).toFixed(1)}% (pass ${counts.pass}, fail ${counts.fail}) fell below ` +
      `${(rule.minPassRate * 100).toFixed(1)}% after ${assessed} assessed runs.`,
    at,
  );
}

/** A batch run refused when claimed: its item goes back to pending and the batch pauses. */
export function batchRunRefused(
  tx: Tx,
  batch: Batch,
  run: RunRecord,
  reason: "budget" | "unavailable",
  message: string,
  at: string,
): Notice[] {
  const index = run.batchIndex ?? -1;
  const item = batch.items[index];
  if (item && item.runId === run.id) batch.items[index] = backToPending(item);
  return pause(tx, batch, reason, message, at);
}

/** A batch run cancelled before it began settles its item cancelled. */
export function batchRunCancelled(tx: Tx, batch: Batch, run: RunRecord, at: string): void {
  const index = run.batchIndex ?? -1;
  const item = batch.items[index];
  if (!item || item.runId !== run.id) return;
  batch.items[index] = { ...outcomeOf(item, run), execution: "cancelled" };
  batch.updatedAt = at;
  pumpBatch(tx, batch, at);
}

// ── batch_control ────────────────────────────────────────────────────────

export type BatchAction = "pause" | "resume" | "cancel" | "rerun_failed";

export function controlBatch(
  tx: Tx,
  batch: Batch,
  action: BatchAction,
  budgetUsd: number | undefined,
  at: string,
): { message: string; affected: number } {
  if (budgetUsd !== undefined && action !== "resume" && action !== "rerun_failed") {
    throw conflict(
      "budgetUsd goes with resume or rerun_failed: it sets the budget the batch runs under.",
    );
  }
  switch (action) {
    case "pause":
      if (batch.state !== "running")
        throw conflict(`batch "${batch.id}" is ${batch.state}; only a running batch pauses.`);
      pause(tx, batch, "manual", "Paused by a person.", at);
      return {
        message: `Batch "${batch.id}" paused: no new item starts; runs already started finish.`,
        affected: 0,
      };
    case "resume":
      return resume(tx, batch, budgetUsd, at);
    case "cancel":
      return cancel(tx, batch, at);
    case "rerun_failed":
      return rerunFailed(tx, batch, budgetUsd, at);
  }
}

function setBudget(tx: Tx, batch: Batch, budgetUsd: number): void {
  const spent = costOf(batch);
  if (!(budgetUsd > spent)) {
    throw conflict(
      `budgetUsd must be more than the $${spent.toFixed(4)} the batch has already spent.`,
    );
  }
  if (othersRunning(tx.ws.state, batch)) {
    throw conflict(
      `batch "${batch.id}" has runs in flight sharing its current budget. Resume with the new budget once they end.`,
    );
  }
  batch.budgetUsd = budgetUsd;
  delete batch.sharing;
}

function rearm(batch: Batch, at: string): void {
  if (batch.pause?.reason === "pass_rate") batch.stopRuleDisarmed = true;
  batch.state = "running";
  delete batch.pause;
  delete batch.completedAt;
  delete batch.waitForSettle;
  batch.updatedAt = at;
}

function resume(tx: Tx, batch: Batch, budgetUsd: number | undefined, at: string) {
  if (batch.state === "cancelled") throw conflict(`batch "${batch.id}" is cancelled.`);
  if (batch.state === "completed") {
    throw conflict(
      `batch "${batch.id}" is completed; use rerun_failed to run its failed items again.`,
    );
  }
  if (batch.state === "running") {
    if (budgetUsd !== undefined)
      throw conflict(`batch "${batch.id}" is running: pause it first to change its budget.`);
    return { message: `Batch "${batch.id}" is already running.`, affected: 0 };
  }
  if (budgetUsd !== undefined) setBudget(tx, batch, budgetUsd);
  rearm(batch, at);
  pumpBatch(tx, batch, at);
  tx.changed();
  return { message: `Batch "${batch.id}" resumed.`, affected: 0 };
}

function cancel(tx: Tx, batch: Batch, at: string) {
  if (batch.state === "cancelled")
    return { message: `Batch "${batch.id}" is already cancelled.`, affected: 0 };
  if (batch.state === "completed") throw conflict(`batch "${batch.id}" is already completed.`);
  batch.state = "cancelled";
  delete batch.pause;
  delete batch.waitForSettle;
  batch.updatedAt = at;
  let affected = 0;
  batch.items.forEach((item, index) => {
    const run = item.runId ? tx.ws.state.open[item.runId] : undefined;
    if (item.state === "pending") {
      batch.items[index] = { ...item, state: "done", execution: "cancelled" };
      affected++;
    } else if (run && run.status === "queued") {
      tx.endRun({
        ...run,
        status: "cancelled",
        error: "Cancelled with its batch",
        completedAt: at,
      });
      batch.items[index] = { ...item, state: "done", execution: "cancelled" };
      affected++;
    } else if (run && !run.interruptedAt) {
      run.cancelRequested = true;
      affected++;
    }
  });
  tx.changed();
  return {
    message: `Batch "${batch.id}" cancelled: ${affected} item(s) stopped or never to start.`,
    affected,
  };
}

function rerunFailed(tx: Tx, batch: Batch, budgetUsd: number | undefined, at: string) {
  if (batch.state === "cancelled") throw conflict(`batch "${batch.id}" is cancelled.`);
  if (budgetUsd !== undefined && batch.state === "running") {
    throw conflict(`batch "${batch.id}" is running: pause it first to change its budget.`);
  }
  const again = batch.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isRerunnable(item));
  if (again.length === 0)
    return { message: `Batch "${batch.id}" has no failed items to run again.`, affected: 0 };
  if (budgetUsd !== undefined) setBudget(tx, batch, budgetUsd);
  for (const { item, index } of again) batch.items[index] = backToPending(item);
  rearm(batch, at);
  pumpBatch(tx, batch, at);
  tx.changed();
  return {
    message: `Batch "${batch.id}": ${again.length} failed item(s) queued to run again, each as a new run.`,
    affected: again.length,
  };
}
