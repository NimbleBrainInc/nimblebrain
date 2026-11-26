/**
 * The records as public outputs carry them (CONTRACT.md §4). Every view is
 * built field by field from what the contract's output schemas name, so no
 * stored field reaches a caller by accident: the run grant above all never
 * does (§9).
 */

import { bucketOf, costOf, countsOf, passRateOf, sharingOf } from "./batches.ts";
import type { Batch, BatchItem, TaskDef } from "./model.ts";
import { scheduleHuman, scheduleTypeOf, usageAt, windowEnd } from "./schedule.ts";

/** Copy the defined values of `fields` onto `out`. */
function withDefined(
  out: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

/** A stored task, as create, update and status return it. `at` renders the budget window. */
export function taskRecord(
  task: TaskDef,
  workspaceId: string,
  at: number,
): Record<string, unknown> {
  const used = usageAt(task, at);
  return withDefined(
    { id: task.id, name: task.name, enabled: task.enabled, prompt: task.prompt },
    {
      description: task.description,
      schedule: task.schedule,
      scheduleHuman: scheduleHuman(task),
      kind: task.kind,
      onceDone: task.onceDone,
      skills: task.skills,
      allowedTools: task.allowedTools,
      inputSchema: task.inputSchema,
      outputSchema: task.outputSchema,
      maxIterations: task.maxIterations,
      maxInputTokens: task.maxInputTokens,
      maxRunDurationMs: task.maxRunDurationMs,
      model: task.model,
      thinkingEffort: task.thinkingEffort,
      tokenBudget: task.tokenBudget,
      budgetResetAt: task.tokenBudget ? windowEnd(used.window) : undefined,
      cumulativeInputTokens: used.input,
      cumulativeOutputTokens: used.output,
      ownerId: task.ownerId,
      workspaceId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      runCount: task.runCount,
      consecutiveErrors: task.consecutiveErrors,
      lastRunAt: task.lastRunAt,
      lastRunLabel: task.lastRunLabel,
      nextRunAt: task.enabled ? task.nextRunAt : undefined,
      disabledAt: task.disabledAt,
      disabledReason: task.disabledReason,
    },
  );
}

/** How much of a one-off's prompt `list` returns to recognize it by. */
const PROMPT_PREVIEW_CHARS = 140;

/** One row of `list`. */
export function taskSummary(task: TaskDef): Record<string, unknown> {
  return withDefined(
    { id: task.id, name: task.name, enabled: task.enabled },
    {
      description: task.description,
      scheduleHuman: scheduleHuman(task),
      scheduleType: scheduleTypeOf(task.schedule),
      kind: task.kind,
      onceDone: task.onceDone,
      runCount: task.runCount,
      lastRunAt: task.lastRunAt,
      lastRunLabel: task.lastRunLabel,
      nextRunAt: task.enabled ? task.nextRunAt : undefined,
      disabledAt: task.disabledAt,
      disabledReason: task.disabledReason,
      inputSchema: task.inputSchema,
      promptPreview:
        task.kind === "oneoff" ? task.prompt.slice(0, PROMPT_PREVIEW_CHARS) : undefined,
    },
  );
}

export function batchView(batch: Batch): Record<string, unknown> {
  const counts = countsOf(batch);
  return withDefined(
    { id: batch.id, taskId: batch.taskId, state: batch.state, counts },
    {
      name: batch.name,
      items: batch.items.length,
      done: batch.items.length - counts.pending - counts.queued - counts.running,
      passRate: passRateOf(counts),
      concurrency: batch.concurrency,
      sharing: sharingOf(batch),
      budgetUsd: batch.budgetUsd,
      costUsd: costOf(batch),
      stopWhen: batch.stopWhen,
      stopRuleDisarmed: batch.stopRuleDisarmed,
      pause: batch.pause,
      idempotencyKey: batch.idempotencyKey,
      ownerId: batch.ownerId,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      completedAt: batch.completedAt,
    },
  );
}

const INPUT_SUMMARY_CHARS = 200;
const OUTPUT_FIELDS = 12;
const OUTPUT_VALUE_CHARS = 200;

function summarize(input: unknown): string {
  const text = JSON.stringify(input) ?? "null";
  return text.length > INPUT_SUMMARY_CHARS ? `${text.slice(0, INPUT_SUMMARY_CHARS)}…` : text;
}

/** A structured output's top-level scalar fields, for a results table. */
function scalarFields(
  structured: unknown,
): Record<string, string | number | boolean | null> | undefined {
  if (structured === null || typeof structured !== "object" || Array.isArray(structured))
    return undefined;
  const out: Record<string, string | number | boolean | null> = {};
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

/** The label an item's run reads as. */
function itemLabel(item: BatchItem): string | undefined {
  const fixed: Record<string, string> = { queued: "Queued", running: "Running" };
  if (item.state !== "done") return fixed[item.state];
  const byExecution: Record<string, string> = {
    failed: "Failed",
    skipped: "Skipped",
    cancelled: "Cancelled",
  };
  if (item.execution && byExecution[item.execution]) return byExecution[item.execution];
  if (item.verdict === "fail") return "Poor result";
  if (item.execution === "incomplete" || item.degraded) return "Needs review";
  return "Succeeded";
}

export type ResultFilter =
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
  return filter === "failing" ? bucket === "fail" || bucket === "failed" : bucket === filter;
}

/** The most an `output: "full"` page's pretty-printed text may be. */
const FULL_OUTPUT_PAGE_CHARS = 48_000;

/**
 * One page of item results from index `start`: rows in index order, at most
 * `limit`, and with `full` rows also closed when the pretty-printed answer would
 * pass the page budget (a row too large alone carries `structuredOmitted`).
 */
export function resultsPage(
  batch: Batch,
  inputs: unknown[],
  opts: { filter?: ResultFilter; start: number; limit: number; full: boolean },
  structuredOf: (runId: string) => unknown,
): { results: Record<string, unknown>[]; nextCursor?: number } {
  const results: Record<string, unknown>[] = [];
  let used = 0;
  for (let index = opts.start; index < batch.items.length; index++) {
    const item = batch.items[index] as BatchItem;
    if (!matchesFilter(item, opts.filter)) continue;
    if (results.length === opts.limit) return { results, nextCursor: index };
    const structured = item.state === "done" && item.runId ? structuredOf(item.runId) : undefined;
    const row = itemRow(item, index, inputs[index]);
    if (!opts.full) {
      results.push(withDefined(row, { output: scalarFields(structured) }));
      continue;
    }
    const full = fullRow(row, structured);
    if (results.length > 0 && used + full.chars > FULL_OUTPUT_PAGE_CHARS) {
      return { results, nextCursor: index };
    }
    results.push(full.row);
    used += full.chars;
  }
  return { results };
}

/** A full row: the whole structured output, or `structuredOmitted` when it alone passes the budget. */
function fullRow(row: Record<string, unknown>, structured: unknown) {
  const full = structured === undefined ? row : { ...row, structured };
  const chars = JSON.stringify(full, null, 2).length;
  if (chars <= FULL_OUTPUT_PAGE_CHARS) return { row: full, chars };
  const omitted = { ...row, structuredOmitted: true };
  return { row: omitted, chars: JSON.stringify(omitted, null, 2).length };
}

function itemRow(item: BatchItem, index: number, input: unknown): Record<string, unknown> {
  return withDefined(
    { index, state: item.state },
    {
      runId: item.runId,
      previousRunIds: item.previousRunIds,
      execution: item.execution,
      verdict: item.verdict,
      label: itemLabel(item),
      inputSummary: summarize(input),
      costUsd: item.costUsd,
      error: item.error,
      errorCode: item.errorCode,
    },
  );
}
