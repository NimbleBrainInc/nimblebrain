/**
 * Handler for conversations__stats tool.
 *
 * Aggregates token usage analytics across conversations for a time period.
 * Reads full JSONL files to extract per-message model, skill, and tool data.
 */

import type { ConversationIndex } from "../index-cache.ts";
import { readConversation } from "../jsonl-reader.ts";

export interface StatsInput {
  period?: "day" | "week" | "month" | "all";
}

interface ModelStats {
  inputTokens: number;
  outputTokens: number;
  conversations: number;
}

interface ToolEntry {
  name: string;
  callCount: number;
}

interface StatsResult {
  period: { since: string; until: string };
  totalConversations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byModel: Record<string, ModelStats>;
  topTools: ToolEntry[];
}

/**
 * Calculate the start of the date range based on the period.
 * Returns null for "all" (no lower bound).
 */
function periodToSince(period: "day" | "week" | "month" | "all", now: Date): Date | null {
  switch (period) {
    case "day":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case "week":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "month":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "all":
      return null;
  }
}

export async function handleStats(
  input: StatsInput,
  index: ConversationIndex,
): Promise<StatsResult> {
  const period = input.period ?? "week";
  const now = new Date();
  const since = periodToSince(period, now);

  const sinceIso = since?.toISOString() ?? "";
  const untilIso = now.toISOString();

  // Get all conversations matching the date range using the index
  const listResult = index.list({
    limit: 999999,
    dateFrom: sinceIso || undefined,
    dateTo: untilIso,
    sortBy: "created",
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const byModel: Record<string, ModelStats> = {};
  const toolCounts: Record<string, number> = {};

  for (const entry of listResult.conversations) {
    const conv = await readConversation(entry.filePath);
    if (!conv) continue;

    // Sum tokens from metadata header
    totalInputTokens += conv.meta.totalInputTokens;
    totalOutputTokens += conv.meta.totalOutputTokens;

    // Track which models appeared in this conversation
    const modelsInConv = new Set<string>();

    for (const msg of conv.messages) {
      if (msg.role !== "assistant") continue;

      // Model breakdown (from aggregated turn-level usage)
      if (msg.usage?.model) {
        const model = msg.usage.model;
        modelsInConv.add(model);
        if (!byModel[model]) {
          byModel[model] = { inputTokens: 0, outputTokens: 0, conversations: 0 };
        }
        byModel[model]!.inputTokens += msg.usage.inputTokens;
        byModel[model]!.outputTokens += msg.usage.outputTokens;
      }

      // Tool usage (turn-level flat list)
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          toolCounts[tc.name] = (toolCounts[tc.name] ?? 0) + 1;
        }
      }
    }

    // Increment conversation counts per model (once per conversation)
    for (const model of modelsInConv) {
      byModel[model]!.conversations += 1;
    }
  }

  // Sort tools by callCount descending
  const topTools: ToolEntry[] = Object.entries(toolCounts)
    .map(([name, callCount]) => ({ name, callCount }))
    .sort((a, b) => b.callCount - a.callCount);

  return {
    period: { since: sinceIso, until: untilIso },
    totalConversations: listResult.conversations.length,
    totalInputTokens,
    totalOutputTokens,
    byModel,
    topTools,
  };
}
