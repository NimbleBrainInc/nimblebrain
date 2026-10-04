/**
 * The batch tools: `tasks__run_batch`, `tasks__batch`, `tasks__batch_control`,
 * and `tasks__batches`. Handlers only; the driver is `batch.ts`, reached
 * through `ToolContext.batches`.
 */

import type {
  TaskBatchItemView,
  TaskBatchView,
  TaskRunLabel,
  TasksBatchControlOutput,
  TasksBatchesOutput,
  TasksBatchOutput,
  TasksRunBatchOutput,
} from "../schemas/tasks.ts";
import { MAX_BATCH_INPUT_BYTES, MAX_BATCH_ITEMS, passRateOf } from "./batch.ts";
import { bucketOf } from "./batch-store.ts";
import {
  ensureOneoff,
  findByName,
  INLINE_FIELDS,
  type InlineDefinition,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  runInputProblem,
  type ToolContext,
} from "./server.ts";
import type { Batch, BatchItem, BatchStopRule, Task } from "./types.ts";

/** How many bad items a refused batch names. */
const BAD_ITEMS_NAMED = 5;

/** Item results per `tasks__batch` page by default. */
const DEFAULT_RESULTS_LIMIT = 50;

/** The longest input preview a result row carries. */
const INPUT_SUMMARY_CHARS = 200;

/** The most structured-output fields a result row carries, and the longest string value. */
const OUTPUT_FIELDS = 12;
const OUTPUT_VALUE_CHARS = 200;

/** `tasks__run_batch`'s arguments, already shape-checked by its input schema. */
interface RunBatchArgs extends InlineDefinition {
  taskId?: string;
  items: unknown[];
  concurrency?: number;
  budgetUsd?: number;
  stopWhen?: BatchStopRule;
  idempotencyKey?: string;
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
function resolveTask(args: RunBatchArgs, ctx: ToolContext): Task {
  const inline = INLINE_FIELDS.filter((field) => args[field] !== undefined);
  if (args.taskId && inline.length > 0) {
    throw new Error(
      `Give either \`taskId\` (a task to run) or an inline definition, not both ` +
        `(also given: ${inline.join(", ")}).`,
    );
  }
  if (args.taskId) {
    const task = findByName(ctx.definitions(), args.taskId);
    if (!task) throw new Error(`Task not found: "${args.taskId}"`);
    checkItems(task.name, task.inputSchema, args.items);
    return task;
  }
  return ensureOneoff(
    args,
    ctx,
    (id, schema) => checkItems(id, schema, args.items),
    args.idempotencyKey !== undefined ? `batch:${args.idempotencyKey}` : undefined,
    "tasks__run_batch needs `taskId` (a task to run)",
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

export function handleRunBatch(
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
): TasksRunBatchOutput {
  const args = rawArgs as unknown as RunBatchArgs;
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

/** What `tasks__batch` `verdict` filters to. */
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

interface BatchArgs {
  batchId: string;
  results?: boolean;
  verdict?: ResultFilter;
  cursor?: number;
  limit?: number;
}

export function handleBatch(rawArgs: Record<string, unknown>, ctx: ToolContext): TasksBatchOutput {
  const { batchId, results, verdict, cursor, limit } = rawArgs as unknown as BatchArgs;
  const found = portOf(ctx).get(batchId);
  if (!found) throw new Error(`Batch not found: "${batchId}".`);
  const { batch, items } = found;
  const view = toBatchView(batch);
  // A filter or a page asks for results even without `results: true`.
  const wantResults =
    results === true || verdict !== undefined || cursor !== undefined || limit !== undefined;
  if (!wantResults) return { batch: view };
  const pageSize = limit ?? DEFAULT_RESULTS_LIMIT;
  const start = cursor ?? 0;
  const page: TaskBatchItemView[] = [];
  let nextCursor: number | undefined;
  for (const item of items) {
    if (item.index < start || !matchesFilter(item, verdict)) continue;
    if (page.length === pageSize) {
      nextCursor = item.index;
      break;
    }
    const structured =
      item.state === "done" && item.runId
        ? ctx.readRunResult(batch.taskId, item.runId)?.structured
        : undefined;
    page.push(toItemView(item, scalarFields(structured)));
  }
  return {
    batch: view,
    results: page,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

interface BatchControlArgs {
  batchId: string;
  action: "pause" | "resume" | "cancel" | "rerun_failed";
  budgetUsd?: number;
}

export function handleBatchControl(
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
): TasksBatchControlOutput {
  const { batchId, action, budgetUsd } = rawArgs as unknown as BatchControlArgs;
  // The scheduler must know the task, for a resume or a re-run.
  ctx.reloadScheduler();
  const result = portOf(ctx).control(batchId, action, budgetUsd);
  return { batch: toBatchView(result.batch), message: result.message, affected: result.affected };
}

interface BatchesArgs {
  taskId?: string;
  state?: Batch["state"];
  limit?: number;
}

export function handleBatches(
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
): TasksBatchesOutput {
  const { taskId, state, limit } = rawArgs as unknown as BatchesArgs;
  const batches = portOf(ctx)
    .list()
    .filter((b) => (taskId === undefined || b.taskId === taskId) && (!state || b.state === state))
    .slice(0, limit ?? 20);
  return { batches: batches.map(toBatchView) };
}
