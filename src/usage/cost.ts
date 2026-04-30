/**
 * Cost estimation and usage formatting.
 *
 * `costBreakdown(model, usage)` is the single source of truth for the
 * arithmetic. `estimateCost(...)` is sugar for `.total`. The
 * usage-aggregator's per-bucket dashboard math reads the same struct,
 * so the dashboard total can never silently diverge from the live
 * per-turn cost.
 *
 * Pricing data comes from the model catalog (src/model/catalog.ts),
 * which is vendored from models.dev. Run `bun run sync-models` to refresh.
 */

import { getModelByString } from "../model/catalog.ts";
import type { TokenUsage } from "./types.ts";

/**
 * Per-bucket cost in USD plus the total. The four buckets always sum to
 * `total` (within float epsilon).
 *
 * Note that `output` includes reasoning-token cost: when a model has a
 * distinct `cost.reasoning` rate, the reasoning subset bills at that
 * rate and the remainder bills at `cost.output`, with both summed into
 * the `output` bucket. Reasoning IS output tokens — splitting at the
 * rate boundary is a billing concern, not a UX one.
 */
export interface CostBreakdownUsd {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

const ZERO_BREAKDOWN: CostBreakdownUsd = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

/**
 * Decompose token usage into per-bucket cost in USD. Returns all-zeros
 * for unknown models.
 *
 * Pricing model — input side: per AI SDK V3 (LanguageModelV3Usage),
 * `inputTokens` is the GRAND TOTAL of all input-side tokens, equal to
 * `noCache + cacheRead + cacheWrite`. The Anthropic provider explicitly
 * computes it that way:
 *   total = inputTokens + cacheCreationTokens + cacheReadTokens
 * So the cost formula must subtract cache reads and cache writes from
 * `inputTokens` before applying the full input rate, otherwise cache
 * tokens get billed twice (once at full input rate, once at the cache
 * rate). The clamp to 0 guards against corrupted event data where the
 * cache subtotals exceed the recorded total.
 *
 * Pricing model — output side: reasoning tokens are a SUBSET of
 * `outputTokens` per the V3 spec (`outputTokens.total = text + reasoning`).
 * When a model has a distinct `cost.reasoning` rate, reasoning tokens are
 * billed at that rate and the remainder of `outputTokens` at `cost.output`
 * — splitting rather than adding. When the model lacks `cost.reasoning`,
 * all output tokens bill at `cost.output`, including any reasoning
 * subtotal.
 */
export function costBreakdown(modelString: string, usage: TokenUsage): CostBreakdownUsd {
  const model = getModelByString(modelString);
  if (!model) return { ...ZERO_BREAKDOWN };
  const c = model.cost;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const inputNonCached = Math.max(usage.inputTokens - cacheRead - cacheWrite, 0);

  const reasoning = usage.reasoningTokens ?? 0;
  const outputNonReasoning =
    c.reasoning != null ? Math.max(usage.outputTokens - reasoning, 0) : usage.outputTokens;
  const reasoningCost = c.reasoning != null ? reasoning * c.reasoning : 0;

  const input = (inputNonCached * c.input) / 1_000_000;
  const output = (outputNonReasoning * c.output + reasoningCost) / 1_000_000;
  const cacheReadCost = (cacheRead * (c.cacheRead ?? c.input)) / 1_000_000;
  const cacheWriteCost = (cacheWrite * (c.cacheWrite ?? c.input)) / 1_000_000;

  return {
    input,
    output,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    total: input + output + cacheReadCost + cacheWriteCost,
  };
}

/** Estimate cost in USD from token usage. Returns 0 for unknown models. */
export function estimateCost(modelString: string, usage: TokenUsage): number {
  return costBreakdown(modelString, usage).total;
}

/** Format USD cost for display. Sub-penny values shown as cents. */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(2)}`;
}

/** Format token count for display (e.g., "2.5M", "512K", "450"). */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}
