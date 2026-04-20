/**
 * Usage aggregation — derives cost and token analytics from conversation files.
 *
 * Source of truth: `llm.response` events in conversation JSONL files.
 * Cost is computed at query time from the model catalog, never stored.
 *
 * The approach:
 * 1. Scan conversation directory for all .jsonl files
 * 2. Read line 1 (metadata) — check updatedAt against the date range
 * 3. For matching conversations, scan lines 2+ for llm.response events
 * 4. Aggregate tokens, cost, model breakdown
 */

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getModelByString } from "../model/catalog.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LlmCallRecord {
  ts: string;
  sid?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  llmMs: number;
}

interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export interface UsageTotals {
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
  llmMs: number;
  conversations: number;
}

export interface ModelUsage {
  model: string;
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
}

export interface BreakdownEntry {
  key: string;
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
  conversations: number;
}

export interface UsageReport {
  period: { from: string; to: string };
  totals: UsageTotals;
  models: ModelUsage[];
  breakdown: BreakdownEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTokenBreakdown(): TokenBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

function createCostBreakdown(): CostBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}

function computeCost(record: LlmCallRecord): CostBreakdown {
  const model = getModelByString(record.model);
  if (!model) return createCostBreakdown();

  const c = model.cost;
  const inputCost = (record.inputTokens * c.input) / 1_000_000;
  const outputCost = (record.outputTokens * c.output) / 1_000_000;
  const cacheReadCost = (record.cacheReadTokens * (c.cacheRead ?? c.input)) / 1_000_000;
  const cacheCreationCost = (record.cacheCreationTokens * (c.cacheWrite ?? c.input)) / 1_000_000;

  return {
    input: inputCost,
    output: outputCost,
    cacheRead: cacheReadCost,
    cacheCreation: cacheCreationCost,
    total: inputCost + outputCost + cacheReadCost + cacheCreationCost,
  };
}

function addTokens(target: TokenBreakdown, record: LlmCallRecord): void {
  target.input += record.inputTokens;
  target.output += record.outputTokens;
  target.cacheRead += record.cacheReadTokens;
  target.cacheCreation += record.cacheCreationTokens;
}

function addCost(target: CostBreakdown, cost: CostBreakdown): void {
  target.input += cost.input;
  target.output += cost.output;
  target.cacheRead += cost.cacheRead;
  target.cacheCreation += cost.cacheCreation;
  target.total += cost.total;
}

/** Normalize model ID by stripping provider prefix and date suffix for grouping. */
function normalizeModel(model: string): string {
  return model.replace(/^(anthropic:|openai:|google:)/, "").replace(/-\d{8}$/, "");
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
      const d = new Date(toDate);
      d.setDate(d.getDate() - 7);
      return { from: d.toISOString().slice(0, 10), to: toDate };
    }
    case "all":
      return { from: "2020-01-01", to: toDate };
    default: {
      const d = new Date(toDate);
      d.setDate(1);
      return { from: d.toISOString().slice(0, 10), to: toDate };
    }
  }
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate usage from conversation files in a directory.
 *
 * 1. List all .jsonl files in conversationsDir
 * 2. Read line 1 (metadata) — filter by updatedAt within date range
 * 3. For matching files, scan for llm.response events
 * 4. Derive totals, per-model, and breakdown by groupBy key
 */
export async function aggregateUsage(
  conversationsDir: string,
  period: string,
  groupBy: string,
  from?: string,
  to?: string,
): Promise<UsageReport> {
  const range = resolveDateRange(period, from, to);

  // List conversation files
  let filenames: string[];
  try {
    filenames = readdirSync(conversationsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    filenames = [];
  }

  // Collect LLM call records from conversations in the date range
  const records: LlmCallRecord[] = [];

  for (const filename of filenames) {
    const filepath = join(conversationsDir, filename);
    let content: string;
    try {
      content = await readFile(filepath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    const firstLine = lines[0];
    if (!firstLine?.trim()) continue;

    // Parse metadata (line 1) — filter by date range
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(firstLine);
    } catch {
      continue;
    }

    const updatedAt = (meta.updatedAt as string) ?? "";
    const updatedDate = updatedAt.slice(0, 10);

    // Skip conversations outside the date range
    if (updatedDate < range.from || updatedDate > range.to) continue;

    const sid = meta.id as string | undefined;

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

      if (entry.type === "llm.response") {
        records.push({
          ts: (entry.ts as string) ?? "",
          sid,
          model: (entry.model as string) ?? "unknown",
          inputTokens: (entry.inputTokens as number) ?? 0,
          outputTokens: (entry.outputTokens as number) ?? 0,
          cacheReadTokens: (entry.cacheReadTokens as number) ?? 0,
          cacheCreationTokens: (entry.cacheCreationTokens as number) ?? 0,
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
  const breakdownMap = new Map<
    string,
    { tokens: TokenBreakdown; cost: CostBreakdown; llmCalls: number; sids: Set<string> }
  >();

  for (const record of records) {
    const cost = computeCost(record);

    addTokens(totals.tokens, record);
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
    addTokens(m.tokens, record);
    addCost(m.cost, cost);
    m.llmCalls++;

    // Breakdown
    const key =
      groupBy === "model"
        ? modelKey
        : groupBy === "conversation"
          ? (record.sid ?? "unknown")
          : record.ts.slice(0, 10);

    if (!breakdownMap.has(key)) {
      breakdownMap.set(key, {
        tokens: createTokenBreakdown(),
        cost: createCostBreakdown(),
        llmCalls: 0,
        sids: new Set(),
      });
    }
    const b = breakdownMap.get(key)!;
    addTokens(b.tokens, record);
    addCost(b.cost, cost);
    b.llmCalls++;
    if (record.sid) b.sids.add(record.sid);
  }

  totals.conversations = conversationIds.size;

  const models = [...modelMap.values()].sort((a, b) => b.cost.total - a.cost.total);

  const breakdown: BreakdownEntry[] = [...breakdownMap.entries()]
    .map(([key, data]) => ({
      key,
      tokens: data.tokens,
      cost: data.cost,
      llmCalls: data.llmCalls,
      conversations: data.sids.size,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // For day grouping over a bounded period, zero-fill missing days so the
  // chart and table show the full window rather than only days with activity.
  // Skipped for `all` — the range can span years and noise outweighs signal.
  if (groupBy === "day" && period !== "all") {
    const byKey = new Map(breakdown.map((e) => [e.key, e]));
    const filled: BreakdownEntry[] = [];
    const cursor = new Date(`${range.from}T00:00:00Z`);
    const end = new Date(`${range.to}T00:00:00Z`);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      filled.push(
        byKey.get(key) ?? {
          key,
          tokens: createTokenBreakdown(),
          cost: createCostBreakdown(),
          llmCalls: 0,
          conversations: 0,
        },
      );
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return { period: range, totals, models, breakdown: filled };
  }

  return { period: range, totals, models, breakdown };
}
