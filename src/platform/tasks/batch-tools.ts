/**
 * The batch tools: `tasks__run_batch`, `tasks__batch`, `tasks__batch_control`,
 * and `tasks__batches`. Handlers only; the driver is `batch.ts`, reached
 * through `ToolContext.batches`.
 */

import { MAX_TOOL_RESULT_CHARS } from "../../limits.ts";
import type {
  TaskBatchItemView,
  TaskBatchView,
  TaskRunLabel,
  TasksBatchControlInput,
  TasksBatchControlOutput,
  TasksBatchesInput,
  TasksBatchesOutput,
  TasksBatchInput,
  TasksBatchOutput,
  TasksRunBatchInput,
  TasksRunBatchOutput,
} from "../schemas/tasks.ts";
import { MAX_BATCH_INPUT_BYTES, MAX_BATCH_ITEMS, passRateOf } from "./batch.ts";
import { bucketOf } from "./batch-store.ts";
import { requireTask } from "./domain.ts";
import {
  ensureOneoff,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  runInputProblem,
  type ToolContext,
} from "./server.ts";
import type { Batch, BatchItem, Task } from "./types.ts";

/** How many bad items a refused batch names. */
const BAD_ITEMS_NAMED = 5;

/** Item results per `tasks__batch` page by default. */
const DEFAULT_RESULTS_LIMIT = 50;

/** The longest input preview a result row carries. */
const INPUT_SUMMARY_CHARS = 200;

/** The most structured-output fields a result row carries, and the longest string value. */
const OUTPUT_FIELDS = 12;
const OUTPUT_VALUE_CHARS = 200;

/**
 * The most an `output: "full"` answer's text may be: the tool's result is
 * `JSON.stringify(answer, null, 2)` (`withErrorHandling` in `source.ts`), which is
 * what the model reads and what the engine cuts at `MAX_TOOL_RESULT_CHARS`. A page
 * is budgeted on that text itself, batch view and cursor included, because
 * indentation inflates arrays and deep nesting several times over their compact
 * size. The reserve covers the engine's truncation note.
 */
export const FULL_OUTPUT_PAGE_CHARS = MAX_TOOL_RESULT_CHARS - 2_000;

/** How deep a result row sits in the answer (`results[i]`), in two-space indents. */
const ROW_INDENT = "    ";

/** A row's length in the pretty-printed answer, separator included. */
function rowChars(row: TaskBatchItemView): number {
  const text = JSON.stringify(row, null, 2);
  const lines = text.split("\n").length;
  return text.length + lines * ROW_INDENT.length + ",\n".length;
}

/** The batch tools need the driver; say so plainly where it is not wired. */
function portOf(ctx: ToolContext): NonNullable<ToolContext["batches"]> {
  if (!ctx.batches) throw new Error("Batches are not available in this runtime.");
  return ctx.batches;
}

/** A batch with the figures derived on read. */
export function toBatchView(batch: Batch): TaskBatchView {
  const { pending, queued, running } = batch.counts;
  return {
    ...batch,
    done: batch.items - pending - queued - running,
    passRate: passRateOf(batch.counts),
  };
}

/**
 * Refuse the batch when any item would be refused as a run's input: name the
 * first few bad indices and why, so nothing is created for a batch that
 * cannot run whole.
 */
function checkItems(name: string, inputSchema: Task["inputSchema"], items: unknown[]): void {
  if (items.length > MAX_BATCH_ITEMS) {
    throw new Error(`A batch takes at most ${MAX_BATCH_ITEMS} items; ${items.length} were given.`);
  }
  const total = Buffer.byteLength(JSON.stringify(items) ?? "", "utf-8");
  if (total > MAX_BATCH_INPUT_BYTES) {
    throw new Error(
      `The items are ${total} bytes serialized; a batch's items may be at most ` +
        `${MAX_BATCH_INPUT_BYTES} together. Pass references (file ids or URLs) instead of content.`,
    );
  }
  const bad: string[] = [];
  let badCount = 0;
  items.forEach((input, index) => {
    // `null` stands in for "no input": an item is always a value.
    const problem = runInputProblem(name, inputSchema, input ?? null);
    if (!problem) return;
    badCount++;
    if (bad.length < BAD_ITEMS_NAMED) bad.push(`item ${index}: ${problem}`);
  });
  if (badCount > 0) {
    throw new Error(
      `${badCount} of ${items.length} items would be refused, so the batch was not created ` +
        `(nothing was run). First bad items: ${bad.join(" | ")}`,
    );
  }
}

/** Resolve the task a batch runs: a saved one, or a one-off from the inline definition. Items are checked first. */
function resolveTask(args: TasksRunBatchInput, ctx: ToolContext): Task {
  if ((args.taskId === undefined) === (args.definition === undefined)) {
    throw new Error(
      "Give `taskId` (a task to run, from tasks__list) or `definition` (a one-off), not both.",
    );
  }
  if (args.taskId !== undefined) {
    const task = requireTask(ctx.definitions(), args.taskId);
    checkItems(task.name, task.inputSchema, args.items);
    return task;
  }
  return ensureOneoff(
    args.definition ?? {},
    ctx,
    (id, schema) => checkItems(id, schema, args.items),
    args.idempotencyKey !== undefined ? `batch:${args.idempotencyKey}` : undefined,
  );
}

/** The concurrency a batch runs at: the caller's, held to the runtime's limit, which is also the default. */
function concurrencyOf(requested: number | undefined, max: number): number {
  return Math.max(1, Math.min(requested ?? max, max));
}

/** The batch an idempotency key already made, refusing a key reused for a different batch. */
function existingBatch(
  port: NonNullable<ToolContext["batches"]>,
  key: string,
  task: Task,
  items: unknown[],
): Batch | null {
  const existing = port.findByKey(key);
  if (!existing) return null;
  if (existing.taskId !== task.id || existing.items !== items.length) {
    throw new Error(
      "idempotencyKey reused for a different batch: this key already made a batch of " +
        `${existing.items} item(s) for task "${existing.taskId}". Use a new key for a new batch.`,
    );
  }
  return existing;
}

export function handleRunBatch(args: TasksRunBatchInput, ctx: ToolContext): TasksRunBatchOutput {
  const port = portOf(ctx);
  const key = args.idempotencyKey;
  if (key !== undefined && (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
    throw new Error(`idempotencyKey must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
  }
  if (!Array.isArray(args.items) || args.items.length === 0) {
    throw new Error("items must hold at least one input.");
  }
  // The scheduler must know a task just written (an inline one-off).
  ctx.reloadScheduler();
  const task = resolveTask(args, ctx);
  ctx.reloadScheduler();

  const existing = key !== undefined ? existingBatch(port, key, task, args.items) : null;
  if (existing) {
    return {
      batch: toBatchView(existing),
      existing: true,
      message: `An earlier call with this idempotencyKey made batch "${existing.id}"; this is it.`,
    };
  }

  if (args.stopWhen && !task.criteria?.length && !task.outputSchema) {
    throw new Error(
      `stopWhen needs runs that are assessed, but "${task.name}" has no criteria and no ` +
        "outputSchema, so every run would be not_assessed and the rule could never apply.",
    );
  }

  const concurrency = concurrencyOf(args.concurrency, port.maxConcurrentRuns);
  const batch = port.create({
    task,
    inputs: args.items,
    concurrency,
    ...(args.budgetUsd !== undefined ? { budgetUsd: args.budgetUsd } : {}),
    ...(args.stopWhen ? { stopWhen: args.stopWhen } : {}),
    ...(key !== undefined ? { idempotencyKey: key } : {}),
  });
  const clamped =
    args.concurrency !== undefined && args.concurrency > concurrency
      ? ` Concurrency is held to ${concurrency}, the runtime's concurrent-run limit.`
      : "";
  return {
    batch: toBatchView(batch),
    existing: false,
    message:
      `Batch "${batch.id}" started: ${batch.items} item(s) of "${task.name}", at most ` +
      `${concurrency} at once.${clamped} Follow it with tasks__batch (batchId "${batch.id}"); ` +
      "pause, resume, cancel, or re-run failed items with tasks__batch_control.",
  };
}

/** What `tasks__batch` `filter` narrows results to. */
type ResultFilter =
  | "pass"
  | "fail"
  | "uncertain"
  | "not_assessed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "pending"
  | "failing";

function matchesFilter(item: BatchItem, filter: ResultFilter | undefined): boolean {
  if (!filter) return true;
  if (filter === "pending") return item.state !== "done";
  const bucket = bucketOf(item);
  if (filter === "failing") return bucket === "fail" || bucket === "failed";
  return bucket === filter;
}

/** The label an item's run reads as, from its execution and verdict (as `labelOf` derives it). */
export function itemLabelOf(item: BatchItem): TaskRunLabel | undefined {
  if (item.state === "pending") return undefined;
  if (item.state === "queued") return "Queued";
  if (item.state === "running") return "Running";
  switch (item.execution) {
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "cancelled":
      return "Cancelled";
    default:
      break;
  }
  if (item.verdict === "fail") return "Poor result";
  if (item.verdict === "uncertain" || item.execution === "incomplete") return "Needs review";
  if (item.degraded) return "Needs review";
  return "Succeeded";
}

/** A short JSON preview of an item's input. */
function summarize(input: unknown): string {
  const text = JSON.stringify(input) ?? "null";
  return text.length > INPUT_SUMMARY_CHARS ? `${text.slice(0, INPUT_SUMMARY_CHARS)}…` : text;
}

/** The top-level scalar fields of a structured output, for a results table. */
function scalarFields(structured: unknown): TaskBatchItemView["output"] {
  if (structured === null || typeof structured !== "object" || Array.isArray(structured)) {
    return undefined;
  }
  const out: NonNullable<TaskBatchItemView["output"]> = {};
  for (const [field, value] of Object.entries(structured)) {
    if (Object.keys(out).length >= OUTPUT_FIELDS) break;
    if (typeof value === "string") {
      out[field] =
        value.length > OUTPUT_VALUE_CHARS ? `${value.slice(0, OUTPUT_VALUE_CHARS)}…` : value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[field] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toItemView(item: BatchItem, output: TaskBatchItemView["output"]): TaskBatchItemView {
  const label = itemLabelOf(item);
  return {
    index: item.index,
    inputSummary: summarize(item.input),
    state: item.state,
    ...(item.runId ? { runId: item.runId } : {}),
    ...(item.previousRunIds ? { previousRunIds: item.previousRunIds } : {}),
    ...(item.execution ? { execution: item.execution } : {}),
    ...(item.verdict ? { verdict: item.verdict } : {}),
    ...(label ? { label } : {}),
    ...(item.costUsd !== undefined ? { costUsd: item.costUsd } : {}),
    ...(item.error ? { error: item.error } : {}),
    ...(output ? { output } : {}),
  };
}

/** In a full row: the longest `error` kept, and how many of the newest earlier run ids. */
const FULL_ROW_ERROR_CHARS = 1_000;
const FULL_ROW_PREVIOUS_RUNS = 20;

/**
 * A full row's metadata, bounded, so the row without its output always fits an
 * answer: an item retried many times, or a run that failed with a long message,
 * cannot push the page past the budget or hide its cursor.
 */
function boundedRow(item: BatchItem): TaskBatchItemView {
  const row = toItemView(item, undefined);
  if (row.error && row.error.length > FULL_ROW_ERROR_CHARS) {
    row.error = `${row.error.slice(0, FULL_ROW_ERROR_CHARS)}…`;
  }
  if (row.previousRunIds && row.previousRunIds.length > FULL_ROW_PREVIOUS_RUNS) {
    row.previousRunIds = row.previousRunIds.slice(-FULL_ROW_PREVIOUS_RUNS);
  }
  return row;
}

/**
 * A row carrying its run's whole structured output. One that alone would not fit
 * an answer says so instead of carrying it, so the page stays readable and the
 * row points at tasks__run_result.
 */
function fullRow(item: BatchItem, structured: unknown, room: number): TaskBatchItemView {
  const base = boundedRow(item);
  if (structured === undefined) return base;
  const row = { ...base, structured };
  return rowChars(row) > room ? { ...base, structuredOmitted: true } : row;
}

/** What a results page is asked for. */
interface PageRequest {
  filter: ResultFilter | undefined;
  start: number;
  pageSize: number;
  full: boolean;
  /** For full rows: the answer's characters before any row (batch view, cursor). */
  baseChars: number;
}

/**
 * One page of item results: rows in index order from `start`, closed by
 * `pageSize`, and for full rows also when the pretty-printed answer would pass
 * {@link FULL_OUTPUT_PAGE_CHARS}.
 */
function resultsPage(
  items: BatchItem[],
  req: PageRequest,
  readStructured: (runId: string) => unknown,
): { page: TaskBatchItemView[]; nextCursor?: number } {
  const page: TaskBatchItemView[] = [];
  const room = FULL_OUTPUT_PAGE_CHARS - req.baseChars;
  let used = 0;
  for (const item of items) {
    if (item.index < req.start || !matchesFilter(item, req.filter)) continue;
    if (page.length === req.pageSize) return { page, nextCursor: item.index };
    const structured = item.state === "done" && item.runId ? readStructured(item.runId) : undefined;
    if (!req.full) {
      page.push(toItemView(item, scalarFields(structured)));
      continue;
    }
    const row = fullRow(item, structured, room);
    const chars = rowChars(row);
    if (page.length > 0 && used + chars > room) return { page, nextCursor: item.index };
    page.push(row);
    used += chars;
  }
  return { page };
}

export function handleBatch(args: TasksBatchInput, ctx: ToolContext): TasksBatchOutput {
  const { batchId, results, filter, cursor, limit, output } = args;
  const found = portOf(ctx).get(batchId);
  if (!found) throw new Error(`Batch not found: "${batchId}".`);
  const { batch, items } = found;
  const view = toBatchView(batch);
  // A filter, a page, or an output choice asks for results even without `results: true`.
  const wantResults =
    results === true ||
    filter !== undefined ||
    cursor !== undefined ||
    limit !== undefined ||
    output !== undefined;
  if (!wantResults) return { batch: view };
  // The answer's text with no rows and the largest cursor it could carry, plus
  // the two characters a non-empty `results` array adds over `[]`.
  const baseChars =
    JSON.stringify({ batch: view, results: [], nextCursor: items.length }, null, 2).length + 2;
  const { page, nextCursor } = resultsPage(
    items,
    {
      filter,
      start: cursor ?? 0,
      pageSize: limit ?? DEFAULT_RESULTS_LIMIT,
      full: output === "full",
      baseChars,
    },
    (runId) => ctx.readRunResult(batch.taskId, runId)?.structured,
  );
  return {
    batch: view,
    results: page,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

export function handleBatchControl(
  args: TasksBatchControlInput,
  ctx: ToolContext,
): TasksBatchControlOutput {
  const { batchId, action, budgetUsd } = args;
  // The scheduler must know the task, for a resume or a re-run.
  ctx.reloadScheduler();
  const result = portOf(ctx).control(batchId, action, budgetUsd);
  return { batch: toBatchView(result.batch), message: result.message, affected: result.affected };
}

export function handleBatches(args: TasksBatchesInput, ctx: ToolContext): TasksBatchesOutput {
  const { taskId, state, limit } = args;
  const batches = portOf(ctx)
    .list()
    .filter((b) => (taskId === undefined || b.taskId === taskId) && (!state || b.state === state))
    .slice(0, limit ?? 20);
  return { batches: batches.map(toBatchView) };
}
