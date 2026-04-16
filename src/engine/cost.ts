/**
 * Cost estimation and formatting utilities.
 *
 * Pricing data comes from the model catalog (src/model/catalog.ts),
 * which is vendored from models.dev. Run `bun run sync-models` to refresh.
 */

import { estimateCost as catalogEstimateCost, type TokenUsage } from "../model/catalog.ts";

export type { TokenUsage } from "../model/catalog.ts";

/** Estimate cost in USD from token usage. Returns 0 for unknown models. */
export function estimateCost(model: string, usage: TokenUsage): number {
  return catalogEstimateCost(model, usage);
}

/** Format USD cost for display. Sub-penny values shown as cents. */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`;
  return `$${usd.toFixed(2)}`;
}

/** Format token count for display (e.g., "2.5M", "512K", "450"). */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}
