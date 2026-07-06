/**
 * Handler for conversations__stats tool.
 *
 * Aggregates token usage analytics across conversations for a time period.
 * Reads full JSONL files to extract per-message model and tool data.
 */

import type { AccessContext, ConversationIndex } from "../index-cache.ts";
import {
  type ConversationFile,
  type DisplayMessage,
  type DisplayToolCall,
  readConversation,
} from "../jsonl-reader.ts";

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

/** Mutable running totals a single stats pass folds each conversation into. */
interface StatsAccumulator {
  totalInputTokens: number;
  totalOutputTokens: number;
  byModel: Record<string, ModelStats>;
  toolCounts: Record<string, number>;
}

/** Get or create the per-model stats bucket for a model. */
function ensureModelStats(byModel: Record<string, ModelStats>, model: string): ModelStats {
  const existing = byModel[model];
  if (existing) return existing;
  const created: ModelStats = { inputTokens: 0, outputTokens: 0, conversations: 0 };
  byModel[model] = created;
  return created;
}

/** Increment call counts for each tool call in an assistant turn. */
function recordToolCalls(toolCounts: Record<string, number>, toolCalls: DisplayToolCall[]): void {
  for (const tc of toolCalls) {
    toolCounts[tc.name] = (toolCounts[tc.name] ?? 0) + 1;
  }
}

/** Fold one assistant message's usage and tool calls into the accumulator, tracking its model. */
function accumulateAssistantMessage(
  msg: DisplayMessage,
  acc: StatsAccumulator,
  modelsInConv: Set<string>,
): void {
  const usage = msg.usage;
  if (usage?.model) {
    modelsInConv.add(usage.model);
    const stats = ensureModelStats(acc.byModel, usage.model);
    stats.inputTokens += usage.inputTokens;
    stats.outputTokens += usage.outputTokens;
  }
  if (msg.toolCalls) {
    recordToolCalls(acc.toolCounts, msg.toolCalls);
  }
}

/** Fold one conversation's tokens, per-model usage, and tool calls into the accumulator. */
function accumulateConversation(conv: ConversationFile, acc: StatsAccumulator): void {
  // Sum tokens from metadata header
  acc.totalInputTokens += conv.meta.totalInputTokens;
  acc.totalOutputTokens += conv.meta.totalOutputTokens;

  // Track which models appeared in this conversation; each bumps its
  // conversation count once, after all messages are folded in.
  const modelsInConv = new Set<string>();
  for (const msg of conv.messages) {
    if (msg.role !== "assistant") continue;
    accumulateAssistantMessage(msg, acc, modelsInConv);
  }

  for (const model of modelsInConv) {
    acc.byModel[model]!.conversations += 1;
  }
}

export async function handleStats(
  input: StatsInput,
  index: ConversationIndex,
  access?: AccessContext,
): Promise<StatsResult> {
  const period = input.period ?? "week";
  const now = new Date();
  const since = periodToSince(period, now);

  const sinceIso = since?.toISOString() ?? "";
  const untilIso = now.toISOString();

  // Get all conversations matching the date range using the index;
  // `access` filters to the caller's owned set so stats reflect their
  // usage, not the global tenant.
  const listResult = index.list(
    {
      limit: 999999,
      dateFrom: sinceIso || undefined,
      dateTo: untilIso,
      sortBy: "created",
    },
    access,
  );

  const acc: StatsAccumulator = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    byModel: {},
    toolCounts: {},
  };

  for (const entry of listResult.conversations) {
    const conv = await readConversation(entry.filePath);
    if (!conv) continue;
    accumulateConversation(conv, acc);
  }

  // Sort tools by callCount descending
  const topTools: ToolEntry[] = Object.entries(acc.toolCounts)
    .map(([name, callCount]) => ({ name, callCount }))
    .sort((a, b) => b.callCount - a.callCount);

  return {
    period: { since: sinceIso, until: untilIso },
    totalConversations: listResult.conversations.length,
    totalInputTokens: acc.totalInputTokens,
    totalOutputTokens: acc.totalOutputTokens,
    byModel: acc.byModel,
    topTools,
  };
}
