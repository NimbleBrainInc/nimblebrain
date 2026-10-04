/**
 * Persistence for batches (`tasks__run_batch`), beside the owner's tasks:
 *
 *   …/tasks/<ownerId>/batches/<batchId>.json         the batch record (definition snapshot, state, counts cache, cost)
 *   …/tasks/<ownerId>/batches/<batchId>.items.jsonl  one line per item with its input, then one appended line per change
 *   …/tasks/<ownerId>/batches/keys/<sha256>.json     an idempotency key and the batch it made
 *
 * The record is replaced atomically on every change. The items file is
 * written whole once (one line per item, carrying its input), and each later
 * change to an item appends one line holding the item's whole state without its
 * input; a reader folds the lines, the last line for an index winning. So a
 * 10,000-item batch costs one append per change instead of a rewrite, and a
 * crash mid-append leaves at most one torn last line, which the fold skips
 * (the item keeps its previous state). `compactBatchItems` rewrites the file
 * folded, at boot and when a batch ends, so no append ever follows a torn line.
 *
 * Paths come only from `paths.ts`.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureWorkspaceDir } from "../../workspace/context.ts";
import { effectiveVerdict } from "./assessment.ts";
import {
  isBatchId,
  taskBatchesDir,
  taskBatchItemsPath,
  taskBatchKeyPath,
  taskBatchPath,
} from "./paths.ts";
import { atomicWrite } from "./store.ts";
import type { Batch, BatchCounts, BatchItem, TaskRun } from "./types.ts";

const WORKSPACES_SEGMENT = "workspaces";
const TASKS_SEGMENT = "tasks";

/** Immediate subdirectory names of `dir`; empty when absent or unreadable. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** Replace a batch's record atomically. */
export function saveBatch(workDir: string, batch: Batch): void {
  const dir = taskBatchesDir(workDir, batch.workspaceId, batch.ownerId);
  ensureWorkspaceDir(dir);
  atomicWrite(
    taskBatchPath(workDir, batch.workspaceId, batch.ownerId, batch.id),
    `${JSON.stringify(batch, null, 2)}\n`,
  );
}

/** One batch, or null when this owner in this workspace has none by that id. */
export function loadBatch(
  workDir: string,
  wsId: string,
  ownerId: string,
  batchId: string,
): Batch | null {
  if (!isBatchId(batchId)) return null;
  const filePath = taskBatchPath(workDir, wsId, ownerId, batchId);
  if (!existsSync(filePath)) return null;
  try {
    const batch = JSON.parse(readFileSync(filePath, "utf-8")) as Batch;
    if (batch?.id !== batchId) return null;
    // The path is the binding.
    batch.workspaceId = wsId;
    batch.ownerId = ownerId;
    return batch;
  } catch {
    return null;
  }
}

/** Every batch of one owner in one workspace, newest first. */
export function listBatches(workDir: string, wsId: string, ownerId: string): Batch[] {
  let names: string[];
  try {
    names = readdirSync(taskBatchesDir(workDir, wsId, ownerId));
  } catch {
    return [];
  }
  const out: Batch[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const batch = loadBatch(workDir, wsId, ownerId, name.slice(0, -".json".length));
    if (batch) out.push(batch);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Every batch in every workspace and owner (the boot reconcile's scan). */
export function listAllBatches(workDir: string): Batch[] {
  const out: Batch[] = [];
  const wsRoot = join(workDir, WORKSPACES_SEGMENT);
  for (const wsId of subdirs(wsRoot)) {
    for (const ownerId of subdirs(join(wsRoot, wsId, TASKS_SEGMENT))) {
      out.push(...listBatches(workDir, wsId, ownerId));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The items
// ---------------------------------------------------------------------------

/** Write a batch's items whole (one line each, inputs included), atomically. */
export function writeBatchItems(
  workDir: string,
  wsId: string,
  ownerId: string,
  batchId: string,
  items: readonly BatchItem[],
): void {
  ensureWorkspaceDir(taskBatchesDir(workDir, wsId, ownerId));
  const body = items.map((item) => JSON.stringify(item)).join("\n");
  atomicWrite(
    taskBatchItemsPath(workDir, wsId, ownerId, batchId),
    body.length > 0 ? `${body}\n` : "",
  );
}

/** Append an item's new state (everything but its input) to the batch's items file. */
export function appendBatchItem(
  workDir: string,
  wsId: string,
  ownerId: string,
  batchId: string,
  item: BatchItem,
): void {
  const { input: _input, ...state } = item;
  appendFileSync(taskBatchItemsPath(workDir, wsId, ownerId, batchId), `${JSON.stringify(state)}\n`);
}

/**
 * A batch's items, folded: one per index in index order. A line carrying
 * `input` is an item's first line; a later line without it replaces the item's
 * state and keeps the input. Malformed lines are skipped.
 */
export function readBatchItems(
  workDir: string,
  wsId: string,
  ownerId: string,
  batchId: string,
): BatchItem[] {
  const filePath = taskBatchItemsPath(workDir, wsId, ownerId, batchId);
  if (!existsSync(filePath)) return [];
  const byIndex = new Map<number, BatchItem>();
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line) continue;
    // A first line is a whole item; a later one is an item without its input.
    let parsed: Omit<BatchItem, "input"> & { input?: unknown };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed.index !== "number") continue;
    if ("input" in parsed) {
      byIndex.set(parsed.index, { ...parsed, input: parsed.input });
      continue;
    }
    const base = byIndex.get(parsed.index);
    if (base) byIndex.set(parsed.index, { ...parsed, input: base.input });
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/** Rewrite a batch's items file folded (one line per item); returns the items. */
export function compactBatchItems(
  workDir: string,
  wsId: string,
  ownerId: string,
  batchId: string,
): BatchItem[] {
  const items = readBatchItems(workDir, wsId, ownerId, batchId);
  writeBatchItems(workDir, wsId, ownerId, batchId, items);
  return items;
}

// ---------------------------------------------------------------------------
// Counts and cost, derived from the items
// ---------------------------------------------------------------------------

/** No items anywhere. */
export function emptyCounts(): BatchCounts {
  return {
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
}

/** Which count an item falls in. A done run with a deliverable counts by its verdict. */
export function bucketOf(
  item: Pick<BatchItem, "state" | "execution" | "verdict">,
): keyof BatchCounts {
  if (item.state !== "done") return item.state;
  switch (item.execution) {
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    default:
      return item.verdict ?? "not_assessed";
  }
}

/** The counts of `items`, by {@link bucketOf}. */
export function countItems(items: readonly BatchItem[]): BatchCounts {
  const counts = emptyCounts();
  for (const item of items) counts[bucketOf(item)]++;
  return counts;
}

/** What `items` have cost, summed. */
export function sumCost(items: readonly BatchItem[]): number {
  return items.reduce((total, item) => total + (item.costUsd ?? 0), 0);
}

/** An item's verdict from its run's assessment: the person's when set, else the judge's. */
export function itemVerdictOf(run: TaskRun): BatchItem["verdict"] {
  return run.assessment ? effectiveVerdict(run.assessment) : undefined;
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

function keyDigest(key: string): string {
  return createHash("sha256").update(key, "utf-8").digest("hex");
}

/** Record that `key` made `batchId` for this owner in this workspace. */
export function saveBatchKey(
  workDir: string,
  wsId: string,
  ownerId: string,
  key: string,
  batchId: string,
): void {
  const filePath = taskBatchKeyPath(workDir, wsId, ownerId, keyDigest(key));
  ensureWorkspaceDir(dirname(filePath));
  atomicWrite(filePath, `${JSON.stringify({ key, batchId })}\n`);
}

/** The batch `key` made for this owner in this workspace, or null when none. */
export function readBatchKey(
  workDir: string,
  wsId: string,
  ownerId: string,
  key: string,
): string | null {
  const filePath = taskBatchKeyPath(workDir, wsId, ownerId, keyDigest(key));
  if (!existsSync(filePath)) return null;
  try {
    const entry = JSON.parse(readFileSync(filePath, "utf-8")) as {
      key?: unknown;
      batchId?: unknown;
    };
    return entry.key === key && typeof entry.batchId === "string" ? entry.batchId : null;
  } catch {
    return null;
  }
}
