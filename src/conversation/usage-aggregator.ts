/**
 * Usage aggregation — derives cost and token analytics from conversation files.
 *
 * Source of truth: `llm.response` events in conversation JSONL files.
 * Cost is computed at query time from the model catalog, never stored.
 *
 * The approach:
 * 1. Scan conversation directory for all .jsonl files
 * 2. Read line 1 (metadata) for conversation id / owner attribution
 * 3. Scan lines 2+ for llm.response events whose own `ts` is in the date range
 * 4. Aggregate tokens, cost, model breakdown
 */

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { USAGE_GROUP_BYS, type UsageGroupBy } from "../tools/platform/schemas/usage.ts";
import { costBreakdown } from "../usage/cost.ts";
import type { TokenUsage } from "../usage/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LlmCallRecord {
  ts: string;
  sid?: string;
  /** Owner of the conversation this call belongs to (line-1 `ownerId`). */
  ownerId?: string;
  model: string;
  usage: TokenUsage;
  llmMs: number;
}

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
  conversations: number;
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
  conversations: number;
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

  const cost = costBreakdown(record.model, record.usage);
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

/** Normalize model ID by stripping provider prefix and date suffix for grouping. */
function normalizeModel(model: string): string {
  return model.replace(/^(anthropic:|openai:|google:)/, "").replace(/-\d{8}$/, "");
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
      return record.sid ?? "unknown";
    case "user":
      return record.ownerId ?? "unknown";
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
  /** Restrict to conversations owned by this user id. Omit for all owners. */
  ownerFilter?: string;
}

/**
 * Aggregate usage from conversation files in a directory.
 *
 * 1. List all .jsonl files in conversationsDir
 * 2. Read line 1 (metadata) for conversation id / owner attribution
 *    (and filter by `ownerId` when `ownerFilter` is set)
 * 3. Scan for llm.response events whose own `ts` date is in range
 * 4. Derive totals, per-model, and breakdowns for the requested groupBy
 *    dimensions (`groupBy: "user"` buckets by the conversation owner)
 */
export async function aggregateUsage(
  source: string | string[],
  period: string,
  groupBy: string | string[],
  options: AggregateUsageOptions = {},
): Promise<UsageReport> {
  const { from, to, ownerFilter } = options;
  const range = resolveDateRange(period, from, to);
  const groupBys = normalizeGroupBys(groupBy);

  // `source` is either an explicit list of conversation file paths — the
  // workspace-owned platform path, spanning every workspace a user touched — or a
  // single flat directory to enumerate (legacy / test fixtures).
  let filePaths: string[];
  if (Array.isArray(source)) {
    filePaths = source;
  } else {
    try {
      filePaths = readdirSync(source)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(source, f));
    } catch {
      filePaths = [];
    }
  }

  // Collect LLM call records whose event timestamp is in the date range.
  const records: LlmCallRecord[] = [];

  for (const filepath of filePaths) {
    let content: string;
    try {
      content = await readFile(filepath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    const firstLine = lines[0];
    if (!firstLine?.trim()) continue;

    // Parse metadata (line 1) for identity/owner attribution. Usage date
    // range filtering is done per llm.response event below, not by updatedAt.
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(firstLine);
    } catch {
      continue;
    }

    const sid = meta.id as string | undefined;
    const ownerId = meta.ownerId as string | undefined;

    // Authorization boundary for the self-view: when an ownerFilter is set,
    // skip any conversation not owned by that user before reading its events.
    if (ownerFilter !== undefined && ownerId !== ownerFilter) continue;

    // Scan events for llm.response
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      // `aux.usage` carries the same {ts, model, usage, llmMs} shape for forked
      // model calls (compaction summarizer, auto-title) that emit no
      // llm.response — count them so their cost isn't undercounted.
      if ((entry.type === "llm.response" || entry.type === "aux.usage") && entry.usage) {
        const ts = (entry.ts as string) ?? "";
        if (!isDateInRange(ts.slice(0, 10), range)) continue;

        records.push({
          ts,
          sid,
          ownerId,
          model: (entry.model as string) ?? "unknown",
          usage: entry.usage as TokenUsage,
          llmMs: (entry.llmMs as number) ?? 0,
        });
      }
    }
  }

  // Derive totals
  const totals: UsageTotals = {
    tokens: createTokenBreakdown(),
    cost: createCostBreakdown(),
    llmCalls: records.length,
    llmMs: 0,
    conversations: 0,
  };
  const conversationIds = new Set<string>();
  const modelMap = new Map<string, ModelUsage>();
  const breakdownMaps = new Map<UsageGroupBy, Map<string, BreakdownAccumulator>>();
  for (const dimension of groupBys) breakdownMaps.set(dimension, new Map());

  for (const record of records) {
    const { tokens, cost } = decomposeUsage(record);

    addTokens(totals.tokens, tokens);
    addCost(totals.cost, cost);
    totals.llmMs += record.llmMs;
    if (record.sid) conversationIds.add(record.sid);

    // Per-model (normalized to strip date suffix and provider prefix)
    const modelKey = normalizeModel(record.model);
    if (!modelMap.has(modelKey)) {
      modelMap.set(modelKey, {
        model: modelKey,
        tokens: createTokenBreakdown(),
        cost: createCostBreakdown(),
        llmCalls: 0,
      });
    }
    const m = modelMap.get(modelKey)!;
    addTokens(m.tokens, tokens);
    addCost(m.cost, cost);
    m.llmCalls++;

    for (const dimension of groupBys) {
      const map = breakdownMaps.get(dimension)!;
      const key = groupKeyFor(record, dimension, modelKey);
      const b = getBreakdownAccumulator(map, key);
      addTokens(b.tokens, tokens);
      addCost(b.cost, cost);
      b.llmCalls++;
      if (record.sid) b.sids.add(record.sid);
    }
  }

  totals.conversations = conversationIds.size;
  totals.cacheHitRate = computeCacheHitRate(totals.tokens);

  const models = [...modelMap.values()]
    .map((m) => {
      m.cacheHitRate = computeCacheHitRate(m.tokens);
      return m;
    })
    .sort((a, b) => b.cost.total - a.cost.total);
  const breakdowns: Partial<Record<UsageGroupBy, BreakdownEntry[]>> = {};
  for (const [dimension, map] of breakdownMaps) {
    breakdowns[dimension] = finalizeBreakdown(map, dimension, period, range);
  }
  const breakdown = breakdowns[groupBys[0]!] ?? [];

  return { period: range, totals, models, breakdown, breakdowns };
}
