/**
 * Usage aggregation — the ONE reader of tenant-level spend.
 *
 * Source of truth: the durable usage ledger (`src/usage/ledger.ts`), one line
 * per priced LLM call. It used to be `llm.response` events scanned out of
 * conversation JSONL files, which made usage a function of whether a
 * conversation file happened to exist — so task runs, delegated sub-agents, the
 * background briefing and archived workspaces all spent money this never saw.
 *
 * **There is exactly one reader, deliberately.** The codebase previously had
 * two that disagreed, which is how the undercount survived; a third would
 * repeat it. Per-conversation display still reads `llm.response` from the
 * conversation log, because "what happened in this conversation" is a different
 * question from "what did this tenant spend" — but neither side may sum the
 * other's source.
 *
 * Cost comes from the rates stored on each line, falling back to the live
 * catalog for lines written before a model was priced. A line the catalog still
 * cannot price is reported as unpriced rather than as zero.
 */

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { USAGE_GROUP_BYS, type UsageGroupBy } from "../tools/platform/schemas/usage.ts";
import { costBreakdown } from "./cost.ts";
import { isBackfillShard, usageMonthDir, usageMonthsInRange } from "./paths.ts";
import type { UsageLedgerEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One ledger line, as the aggregation reads it.
 *
 * `rates` is the difference that matters: present means the line prices from
 * what it cost at the time, absent means the catalog did not know the model and
 * the line is *unpriced* — which is not the same as priced at zero, and is
 * reported separately so an approximate month cannot read as a free one.
 */
type LlmCallRecord = UsageLedgerEntry;

interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageTotals {
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
  llmMs: number;
  /** Distinct chat conversations. Task runs are counted by `runs`, not here. */
  conversations: number;
  /** Distinct task runs — automations, which have no conversation to count. */
  runs?: number;
  /**
   * Calls whose model no price could be found for, at write time or now.
   *
   * Present only when non-zero. Their tokens are in the totals and their cost
   * is not, so a report carrying this is saying its dollar figure is
   * incomplete — as distinct from a spend of zero, which is what a bare
   * `$0.00` beside a large token count would otherwise imply. Backfilled
   * automation history is the common case.
   */
  unpricedCalls?: number;
  /** Input-side cache-hit rate (0–1). See `computeCacheHitRate`. */
  cacheHitRate?: number;
}

export interface ModelUsage {
  model: string;
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
  /** Input-side cache-hit rate (0–1). See `computeCacheHitRate`. */
  cacheHitRate?: number;
}

export interface BreakdownEntry {
  key: string;
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
  /** Distinct chat conversations. Task runs are counted by `runs`, not here. */
  conversations: number;
  /** Distinct task runs — automations, which have no conversation to count. */
  runs?: number;
  /**
   * Calls whose model no price could be found for, at write time or now.
   *
   * Present only when non-zero. Their tokens are in the totals and their cost
   * is not, so a report carrying this is saying its dollar figure is
   * incomplete — as distinct from a spend of zero, which is what a bare
   * `$0.00` beside a large token count would otherwise imply. Backfilled
   * automation history is the common case.
   */
  unpricedCalls?: number;
  /** Input-side cache-hit rate (0–1). See `computeCacheHitRate`. */
  cacheHitRate?: number;
}

/**
 * Input-side cache-hit rate: the fraction of input tokens served from cache
 * (cheap reads) rather than re-written or sent uncached —
 * `cacheRead / (input + cacheRead + cacheWrite)`, 0 when there were no input
 * tokens. A healthy long conversation trends high (the growing prefix is read
 * back each turn); a thrashing one trends low (the prefix is re-written every
 * turn). This is the standing signal the prompt-cache work keeps high — see
 * `model/cache-policy.ts`. `input` here is the NON-cached portion (the
 * aggregator's `tokens.input`), so the three terms sum to the input-side total.
 */
export function computeCacheHitRate(t: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number {
  const denom = t.input + t.cacheRead + t.cacheWrite;
  return denom > 0 ? t.cacheRead / denom : 0;
}

export interface UsageReport {
  period: { from: string; to: string };
  totals: UsageTotals;
  models: ModelUsage[];
  breakdown: BreakdownEntry[];
  breakdowns: Partial<Record<UsageGroupBy, BreakdownEntry[]>>;
}

interface BreakdownAccumulator {
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
  sids: Set<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTokenBreakdown(): TokenBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function createCostBreakdown(): CostBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/**
 * Decompose a model's TokenUsage into the four cost-bearing buckets
 * (input/output/cacheRead/cacheWrite) plus parallel cost numbers. Cost
 * comes from `costBreakdown` in src/usage/cost.ts — single source of
 * truth, so the dashboard total can't drift from the live per-turn
 * `usage.costUsd`. Token-side math: `usage.inputTokens` is the AI SDK
 * V3 grand total (includes cacheRead and cacheWrite); the `input`
 * bucket is the non-cached portion. Clamp to 0 guards against corrupted
 * records where the cache subtotals exceed the total.
 */
function decomposeUsage(record: LlmCallRecord): { tokens: TokenBreakdown; cost: CostBreakdown } {
  const cacheRead = record.usage.cacheReadTokens ?? 0;
  const cacheWrite = record.usage.cacheWriteTokens ?? 0;
  const inputNonCached = Math.max(record.usage.inputTokens - cacheRead - cacheWrite, 0);

  const tokens: TokenBreakdown = {
    input: inputNonCached,
    output: record.usage.outputTokens,
    cacheRead,
    cacheWrite,
  };

  // Stored rates win over the catalog, so a past call keeps the price it was
  // charged at. `rates` absent falls back to the catalog, which prices a model
  // the ledger predates; still-unknown yields zeros, and `isPriced` is what
  // keeps that zero from being read as "free" — see `accumulateRecord`.
  const cost = costBreakdown(record.model, record.usage, record.rates);
  return { tokens, cost };
}

function addTokens(target: TokenBreakdown, src: TokenBreakdown): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheRead += src.cacheRead;
  target.cacheWrite += src.cacheWrite;
}

function addCost(target: CostBreakdown, cost: CostBreakdown): void {
  target.input += cost.input;
  target.output += cost.output;
  target.cacheRead += cost.cacheRead;
  target.cacheWrite += cost.cacheWrite;
  target.total += cost.total;
}

/**
 * Normalize model ID by stripping any `provider:` prefix and date suffix for
 * grouping/display. The prefix match is generic (`^[a-z0-9-]+:`) so a new
 * provider like `nebius:` is handled without editing this (and the sibling
 * copies in the usage UIs). Exported for the drift-pinning test.
 */
/**
 * The provider a qualified model string names — the segment before the first
 * colon. Unqualified strings are Anthropic, matching `getModelByString`.
 */
export function providerOf(model: string): string {
  const i = model.indexOf(":");
  return i < 0 ? "anthropic" : model.slice(0, i);
}

/**
 * Whether this line's cost is a real number rather than an absence.
 *
 * True when the line carries stored rates, or when the catalog can still price
 * its model. False for a backfilled automation line (`model: "unknown"`) and
 * for anything else the catalog has never known — those contribute tokens and
 * no dollars, and are counted separately so the total reads as incomplete
 * rather than as zero.
 */
function isPriced(record: LlmCallRecord): boolean {
  if (record.rates) return true;
  return costBreakdown(record.model, { inputTokens: 1, outputTokens: 0 }).total > 0;
}

export function normalizeModel(model: string): string {
  return model.replace(/^[a-z0-9-]+:/, "").replace(/-\d{8}$/, "");
}

function isDateInRange(date: string, range: { from: string; to: string }): boolean {
  return date >= range.from && date <= range.to;
}

function isUsageGroupBy(value: string): value is UsageGroupBy {
  return (USAGE_GROUP_BYS as readonly string[]).includes(value);
}

function normalizeGroupBys(groupBy: string | string[]): UsageGroupBy[] {
  const requested = Array.isArray(groupBy) ? groupBy : [groupBy];
  const valid = requested.filter(isUsageGroupBy);
  const fallback: UsageGroupBy[] = ["day"];
  return [...new Set(valid.length > 0 ? valid : fallback)];
}

function groupKeyFor(record: LlmCallRecord, groupBy: UsageGroupBy, modelKey: string): string {
  switch (groupBy) {
    case "model":
      return modelKey;
    case "conversation":
      return record.sessionId ?? "unknown";
    case "user":
      return record.userId ?? "unknown";
    case "origin":
      return record.origin;
    case "provider":
      return providerOf(record.model);
    case "day":
      return record.ts.slice(0, 10);
  }
}

function getBreakdownAccumulator(
  map: Map<string, BreakdownAccumulator>,
  key: string,
): BreakdownAccumulator {
  let accumulator = map.get(key);
  if (!accumulator) {
    accumulator = {
      tokens: createTokenBreakdown(),
      cost: createCostBreakdown(),
      llmCalls: 0,
      sids: new Set(),
    };
    map.set(key, accumulator);
  }
  return accumulator;
}

function emptyBreakdownEntry(key: string): BreakdownEntry {
  return {
    key,
    tokens: createTokenBreakdown(),
    cost: createCostBreakdown(),
    llmCalls: 0,
    conversations: 0,
  };
}

function finalizeBreakdown(
  map: Map<string, BreakdownAccumulator>,
  groupBy: UsageGroupBy,
  period: string,
  range: { from: string; to: string },
): BreakdownEntry[] {
  const breakdown: BreakdownEntry[] = [...map.entries()]
    .map(([key, data]) => ({
      key,
      tokens: data.tokens,
      cost: data.cost,
      llmCalls: data.llmCalls,
      conversations: data.sids.size,
      cacheHitRate: computeCacheHitRate(data.tokens),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // For day grouping over a bounded period, zero-fill missing days so the
  // chart and table show the full window rather than only days with activity.
  // Skipped for `all` — the range can span years and noise outweighs signal.
  if (groupBy !== "day" || period === "all") return breakdown;

  const byKey = new Map(breakdown.map((e) => [e.key, e]));
  const filled: BreakdownEntry[] = [];
  const cursor = new Date(`${range.from}T00:00:00Z`);
  const end = new Date(`${range.to}T00:00:00Z`);
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    filled.push(byKey.get(key) ?? emptyBreakdownEntry(key));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return filled;
}

export function resolveDateRange(
  period: string,
  from?: string,
  to?: string,
): { from: string; to: string } {
  const now = new Date();
  const toDate = to ?? now.toISOString().slice(0, 10);

  if (from) return { from, to: toDate };

  switch (period) {
    case "day":
      return { from: toDate, to: toDate };
    case "week": {
      const d = new Date(`${toDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 7);
      return { from: d.toISOString().slice(0, 10), to: toDate };
    }
    case "all":
      return { from: "2020-01-01", to: toDate };
    default: {
      const d = new Date(`${toDate}T00:00:00Z`);
      d.setUTCDate(1);
      return { from: d.toISOString().slice(0, 10), to: toDate };
    }
  }
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

/**
 * Optional filters/dimensions layered on top of the date range.
 *
 * `ownerFilter` is the authorization boundary for the self-view: when set,
 * only conversations whose line-1 `ownerId` matches are aggregated. The
 * caller (the usage tool handler) sets it to the requester's own id so a
 * non-admin physically cannot aggregate another user's conversations —
 * the filter runs in the aggregator, below the tool surface, so it can't
 * be bypassed by a malformed call.
 */
export interface AggregateUsageOptions {
  from?: string;
  to?: string;
  /**
   * Restrict to calls made by this user id. Omit for every user.
   *
   * **Fails closed.** `userId` is optional on a ledger line — a call recorded
   * outside any request scope has none — and such a line is excluded from an
   * owner-filtered read rather than included. The alternative leaks one user's
   * spend into another's view on exactly the lines whose owner is unknown.
   */
  ownerFilter?: string;
}

/**
 * Read the ledger lines in range, oldest month first.
 *
 * A month's directory holds one shard per writer plus, after a migration,
 * `backfill.jsonl`. All of them are read: the backfill shard covers the period
 * before the live writer existed, and its cutoff is what keeps the two from
 * overlapping (see `scripts/backfill-usage-ledger.ts`).
 *
 * A malformed line is skipped rather than failing the report — a ledger that
 * cannot be read at all is worse than one missing a line, and the line count is
 * itself the signal if it ever becomes common.
 */
/** Parse one shard's lines into the records in range the caller may see. */
function parseShard(
  text: string,
  range: { from: string; to: string },
  ownerFilter?: string,
): LlmCallRecord[] {
  const out: LlmCallRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: LlmCallRecord;
    try {
      entry = JSON.parse(line) as LlmCallRecord;
    } catch {
      // A torn tail line — the writer appends, so only the last can be partial.
      continue;
    }
    if (!entry.ts || !isDateInRange(entry.ts.slice(0, 10), range)) continue;
    // Fails closed: a line with no `userId` is excluded from a filtered read,
    // never included. See `AggregateUsageOptions.ownerFilter`.
    if (ownerFilter !== undefined && entry.userId !== ownerFilter) continue;
    out.push(entry);
  }
  return out;
}

/** One month's shards, backfill first so accumulation is deterministic. */
function shardsForMonth(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return []; // No spend recorded that month.
  }
  return names.sort(
    (a, b) => Number(isBackfillShard(b)) - Number(isBackfillShard(a)) || a.localeCompare(b),
  );
}

/**
 * Read the ledger lines in range, oldest month first.
 *
 * A month's directory holds one shard per writer plus, after a migration,
 * `backfill.jsonl`. All are read: the backfill shard covers the period before
 * the live writer existed, and its cutoff is what keeps the two from
 * overlapping (see `scripts/backfill-usage-ledger.ts`).
 */
async function readLedger(
  workDir: string,
  range: { from: string; to: string },
  ownerFilter?: string,
): Promise<LlmCallRecord[]> {
  const records: LlmCallRecord[] = [];
  for (const month of usageMonthsInRange(range.from, range.to)) {
    const dir = usageMonthDir(workDir, month);
    for (const shard of shardsForMonth(dir)) {
      try {
        records.push(...parseShard(await readFile(join(dir, shard), "utf-8"), range, ownerFilter));
      } catch {
        // Shard vanished between listing and read (retention sweep); skip it.
      }
    }
  }
  return records;
}

interface AggregationSink {
  totals: UsageTotals;
  conversationIds: Set<string>;
  /** Distinct task-run ids, kept apart from conversations. See `accumulateRecord`. */
  runIds: Set<string>;
  unpricedCalls: number;
  modelMap: Map<string, ModelUsage>;
  breakdownMaps: Map<UsageGroupBy, Map<string, BreakdownAccumulator>>;
  groupBys: UsageGroupBy[];
}

/** Get or create the per-model accumulator for `modelKey`. */
function getModelUsage(map: Map<string, ModelUsage>, modelKey: string): ModelUsage {
  let usage = map.get(modelKey);
  if (!usage) {
    usage = {
      model: modelKey,
      tokens: createTokenBreakdown(),
      cost: createCostBreakdown(),
      llmCalls: 0,
    };
    map.set(modelKey, usage);
  }
  return usage;
}

/** Fold one record's tokens/cost into totals, per-model, and every groupBy breakdown. */
function accumulateRecord(record: LlmCallRecord, sink: AggregationSink): void {
  const { tokens, cost } = decomposeUsage(record);

  addTokens(sink.totals.tokens, tokens);
  addCost(sink.totals.cost, cost);
  sink.totals.llmMs += record.llmMs;
  // A task run stamps its run id into `sessionId`, so the two counts have to be
  // split by origin or an automation would be reported as a conversation. This
  // is what `origin` and `delegated` being orthogonal buys: a delegated call
  // inside an automation is `task`, so it counts toward the run that spawned it.
  if (record.sessionId) {
    if (record.origin === "task") sink.runIds.add(record.sessionId);
    else sink.conversationIds.add(record.sessionId);
  }
  // Unpriced is not free. A line the catalog cannot price contributes tokens
  // and zero dollars, and this is the count that says the dollar figure is
  // incomplete rather than the spend being zero.
  if (!isPriced(record)) sink.unpricedCalls++;

  // Per-model (normalized to strip date suffix and provider prefix)
  const modelKey = normalizeModel(record.model);
  const model = getModelUsage(sink.modelMap, modelKey);
  addTokens(model.tokens, tokens);
  addCost(model.cost, cost);
  model.llmCalls++;

  for (const dimension of sink.groupBys) {
    const map = sink.breakdownMaps.get(dimension)!;
    const key = groupKeyFor(record, dimension, modelKey);
    const bucket = getBreakdownAccumulator(map, key);
    addTokens(bucket.tokens, tokens);
    addCost(bucket.cost, cost);
    bucket.llmCalls++;
    if (record.sessionId) bucket.sids.add(record.sessionId);
  }
}

/**
 * Aggregate tenant spend from the durable usage ledger under `workDir`.
 *
 * 1. List all .jsonl files in conversationsDir
 * 2. Read line 1 (metadata) for conversation id / owner attribution
 *    (and filter by `ownerId` when `ownerFilter` is set)
 * 3. Scan for llm.response events whose own `ts` date is in range
 * 4. Derive totals, per-model, and breakdowns for the requested groupBy
 *    dimensions (`groupBy: "user"` buckets by the conversation owner)
 */
export async function aggregateUsage(
  workDir: string,
  period: string,
  groupBy: string | string[],
  options: AggregateUsageOptions = {},
): Promise<UsageReport> {
  const { from, to, ownerFilter } = options;
  const range = resolveDateRange(period, from, to);
  const groupBys = normalizeGroupBys(groupBy);

  const records = await readLedger(workDir, range, ownerFilter);
  // Derive totals
  const totals: UsageTotals = {
    tokens: createTokenBreakdown(),
    cost: createCostBreakdown(),
    llmCalls: records.length,
    llmMs: 0,
    conversations: 0,
  };
  const sink: AggregationSink = {
    totals,
    conversationIds: new Set<string>(),
    runIds: new Set<string>(),
    unpricedCalls: 0,
    modelMap: new Map<string, ModelUsage>(),
    breakdownMaps: new Map<UsageGroupBy, Map<string, BreakdownAccumulator>>(),
    groupBys,
  };
  for (const dimension of groupBys) sink.breakdownMaps.set(dimension, new Map());

  for (const record of records) accumulateRecord(record, sink);

  totals.conversations = sink.conversationIds.size;
  totals.runs = sink.runIds.size;
  if (sink.unpricedCalls > 0) totals.unpricedCalls = sink.unpricedCalls;
  totals.cacheHitRate = computeCacheHitRate(totals.tokens);

  const models = [...sink.modelMap.values()]
    .map((m) => {
      m.cacheHitRate = computeCacheHitRate(m.tokens);
      return m;
    })
    .sort((a, b) => b.cost.total - a.cost.total);
  const breakdowns: Partial<Record<UsageGroupBy, BreakdownEntry[]>> = {};
  for (const [dimension, map] of sink.breakdownMaps) {
    breakdowns[dimension] = finalizeBreakdown(map, dimension, period, range);
  }
  const breakdown = breakdowns[groupBys[0]!] ?? [];

  return { period: range, totals, models, breakdown, breakdowns };
}
