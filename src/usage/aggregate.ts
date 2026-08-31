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

/**
 * How much of a dimension's breakdown was returned, when the cap bound.
 *
 * Present per dimension only when rows were dropped, so its absence means the
 * breakdown is complete. `totals` is unaffected either way — it is accumulated
 * from every record, not from these rows — so this reports a narrower VIEW,
 * never missing spend.
 */
export interface BreakdownTruncation {
  /** Rows in the response: the {@link MAX_BREAKDOWN_ROWS} costliest. */
  returned: number;
  /** Rows the dimension has in full. */
  total: number;
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
  /**
   * Dimensions whose breakdown hit {@link MAX_BREAKDOWN_ROWS}. Absent when
   * every breakdown is complete, so a consumer that ignores it still reads a
   * complete report correctly and a partial one is never silently mistaken for
   * the whole set.
   */
  truncatedBreakdowns?: Partial<Record<UsageGroupBy, BreakdownTruncation>>;
}

interface BreakdownAccumulator {
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
  /** Chat session ids. Task runs go in `runIds` — the same split `totals` makes. */
  sids: Set<string>;
  runIds: Set<string>;
  unpricedCalls: number;
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

// ── Legacy `sessionId` normalization ─────────────────────────────────────
//
// Records written before the id split carry one `sessionId` holding either a
// conversation or an automation run, told apart by `origin`. Records written
// since carry `conversationId` / `taskRunId` under their own names. Both shapes
// are in the retention window at once, so every read goes through these two
// helpers rather than touching either field directly.
//
// These are the whole compatibility surface, and they expire: when the oldest
// retained month postdates the split (see `retentionMonths`, default 24), no
// record on disk has `sessionId` and both `?? legacy` arms become dead code.

/** The chat conversation a record belongs to, new shape or old. */
function conversationOf(record: LlmCallRecord): string | undefined {
  if (record.conversationId) return record.conversationId;
  // Legacy: `sessionId` was a conversation only when the call was not a task.
  return record.origin === "task" ? undefined : record.sessionId;
}

/** The automation run a record belongs to, new shape or old. */
function taskRunOf(record: LlmCallRecord): string | undefined {
  if (record.taskRunId) return record.taskRunId;
  // Legacy: `sessionId` was an automation run only when the call was a task.
  return record.origin === "task" ? record.sessionId : undefined;
}

function groupKeyFor(record: LlmCallRecord, groupBy: UsageGroupBy, modelKey: string): string {
  switch (groupBy) {
    case "model":
      return modelKey;
    case "conversation":
      // A task run has no conversation, so it groups under "none" rather than
      // contributing its run id to a conversation breakdown — which is what the
      // undiscriminated `sessionId` read did, putting `run_…` rows in a
      // dimension the schema calls "conversation".
      return conversationOf(record) ?? "none";
    case "turn":
      // One assistant turn. A delegated sub-agent runs its own engine and so
      // mints its own `runId`; keying on that alone would bill one turn as
      // several rows, understating the turn the user actually took and putting
      // sub-agent rows beside top-level ones with nothing to tell them apart.
      // `parentRunId` is the TOP-LEVEL run at any depth — the delegate tracker
      // only advances `currentRunId` for runs that have no parent
      // (`runtime.ts:286`) — so preferring it rolls a whole delegation subtree
      // onto the turn that spawned it.
      //
      // The forked fast-slot calls (title, compaction, briefing) carry no
      // engine run at all, and neither do records predating this field; both
      // group under "none".
      return record.parentRunId ?? record.runId ?? "none";
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
      runIds: new Set(),
      unpricedCalls: 0,
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

/**
 * Most rows any one breakdown returns.
 *
 * Sized so a full report stays a few hundred KB rather than tens of MB: at the
 * ~0.85 KB a row serializes to, this is ~210 KB. Every low-cardinality
 * dimension (`user`, `model`, `origin`, `provider`) sits far below it and is
 * unaffected; it binds only on the id-keyed ones.
 */
export const MAX_BREAKDOWN_ROWS = 250;

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
      ...(data.runIds.size > 0 ? { runs: data.runIds.size } : {}),
      ...(data.unpricedCalls > 0 ? { unpricedCalls: data.unpricedCalls } : {}),
      cacheHitRate: computeCacheHitRate(data.tokens),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // Cap the rows. `conversation` and `turn` are keyed on ids the ledger mints
  // per thread and per turn, so their cardinality grows with every turn the
  // tenant ever takes — over the retention window that is tens of thousands of
  // rows, and the whole report is serialized twice (the text the model reads
  // and the structured copy) before anything trims it. The engine bounds what
  // reaches the MODEL at `MAX_TOOL_RESULT_CHARS`, but the full string is built
  // in the process first and the unbounded copy is what gets persisted to the
  // conversation record, so the ceiling has to be here rather than downstream.
  //
  // Top-N by cost, because the question a breakdown answers is where the money
  // went; the rows dropped are the cheapest ones. `totals` is accumulated from
  // every record independently of this, so capping loses no spend from the
  // report — only rows from one view of it, and `truncatedBreakdowns` says so.
  //
  // `day` is exempt: it is bounded by the period, and it is zero-filled below
  // to a contiguous series that a capped set would put holes in.
  if (groupBy !== "day" && breakdown.length > MAX_BREAKDOWN_ROWS) {
    return [...breakdown]
      .sort((a, b) => b.cost.total - a.cost.total)
      .slice(0, MAX_BREAKDOWN_ROWS)
      .sort((a, b) => a.key.localeCompare(b.key));
  }

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
 * `ownerFilter` is the authorization boundary for the self-view: when set, only
 * lines whose `userId` matches are aggregated. The caller (the usage tool
 * handler) sets it to the requester's own id, so a non-admin physically cannot
 * aggregate another user's spend — the filter runs here, below the tool
 * surface, and cannot be bypassed by a malformed call.
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
  // `conversationOf` / `taskRunOf` decide which of the two a record belongs to,
  // so an automation is never counted as a conversation. This is what `origin`
  // and `delegated` being orthogonal buys: a delegated call
  // inside an automation is `task`, so it counts toward the run that spawned it.
  const conversationId = conversationOf(record);
  const taskRunId = taskRunOf(record);
  if (conversationId) sink.conversationIds.add(conversationId);
  if (taskRunId) sink.runIds.add(taskRunId);
  // Unpriced is not free. A line the catalog cannot price contributes tokens
  // and zero dollars, and this is the count that says the dollar figure is
  // incomplete rather than the spend being zero.
  const priced = isPriced(record);
  if (!priced) sink.unpricedCalls++;

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
    // Same split as `totals`, through the same two helpers, so a breakdown row
    // cannot report an automation as a conversation while the totals disagree.
    if (conversationId) bucket.sids.add(conversationId);
    if (taskRunId) bucket.runIds.add(taskRunId);
    if (!priced) bucket.unpricedCalls++;
  }
}

/**
 * Aggregate tenant spend from the durable usage ledger under `workDir`.
 *
 * 1. Read the shards for every month the range spans, dropping out-of-range
 *    lines and — when `ownerFilter` is set — anyone else's
 * 2. Derive totals, splitting chat conversations from task runs and counting
 *    the calls no price could be found for
 * 3. Derive per-model and per-dimension breakdowns, which make the same split
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
  // Both optional counts are omitted at zero rather than emitted as `0`, the
  // same rule the breakdown rows follow — one convention for one payload.
  if (sink.runIds.size > 0) totals.runs = sink.runIds.size;
  if (sink.unpricedCalls > 0) totals.unpricedCalls = sink.unpricedCalls;
  totals.cacheHitRate = computeCacheHitRate(totals.tokens);

  const models = [...sink.modelMap.values()]
    .map((m) => {
      m.cacheHitRate = computeCacheHitRate(m.tokens);
      return m;
    })
    .sort((a, b) => b.cost.total - a.cost.total);
  const breakdowns: Partial<Record<UsageGroupBy, BreakdownEntry[]>> = {};
  const truncatedBreakdowns: Partial<Record<UsageGroupBy, BreakdownTruncation>> = {};
  for (const [dimension, map] of sink.breakdownMaps) {
    const rows = finalizeBreakdown(map, dimension, period, range);
    breakdowns[dimension] = rows;
    // `map.size` is the pre-cap key count. Compared only off `day`, whose row
    // count can exceed it by design once the zero-fill has run.
    if (dimension !== "day" && map.size > rows.length) {
      truncatedBreakdowns[dimension] = { returned: rows.length, total: map.size };
    }
  }
  const breakdown = breakdowns[groupBys[0]!] ?? [];

  return {
    period: range,
    totals,
    models,
    breakdown,
    breakdowns,
    ...(Object.keys(truncatedBreakdowns).length > 0 ? { truncatedBreakdowns } : {}),
  };
}
