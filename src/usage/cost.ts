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
import type { TokenUsage, UsageRates } from "./types.ts";

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
 * Anthropic cache-WRITE multipliers over base input, by TTL: a 5-minute write
 * is 1.25x base, a 1-hour write is 2x. The engine tiers TTL by breakpoint
 * stability (1h on system+tools, 5m on the rolling history — see
 * `model/cache-policy.ts`), so writes must be costed per-bucket. Empirically
 * confirmed against the live API (`cache_creation.ephemeral_{1h,5m}_input_tokens`).
 * The catalog's `cacheWrite` field is the 5-minute rate (synced from upstream);
 * we use it for the 5m bucket and derive the 1h rate as 2x base input.
 */
const ONE_HOUR_CACHE_WRITE_MULTIPLIER = 2;
const FIVE_MIN_CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * The unit prices a model bills at, flattened so they can be stored on a ledger
 * line and replayed later.
 *
 * The two cache-write tiers are derived here rather than read from the catalog:
 * the catalog carries one `cacheWrite` (the 5-minute rate) and the 1-hour rate
 * is a multiple of base input. A caller storing rates needs both, so this is
 * where the derivation lives — one place, shared with `costBreakdown` below.
 *
 * Returns `null` for a model the catalog does not know, which the ledger writes
 * as an absent `rates` and the reader treats as *unpriced* rather than free.
 */
export function resolveRates(modelString: string): UsageRates | null {
  const model = getModelByString(modelString);
  if (!model) return null;
  const c = model.cost;
  return {
    input: c.input,
    output: c.output,
    cacheRead: c.cacheRead ?? c.input,
    cacheWrite5m: c.cacheWrite ?? c.input * FIVE_MIN_CACHE_WRITE_MULTIPLIER,
    cacheWrite1h: c.input * ONE_HOUR_CACHE_WRITE_MULTIPLIER,
    ...(c.reasoning != null ? { reasoning: c.reasoning } : {}),
  };
}

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
 *
 * @param rates Stored unit prices from a ledger line. When supplied they win
 *   over the catalog, so a past call costs what it cost rather than what the
 *   model costs today. Optional, and the catalog path is unchanged, so every
 *   existing caller is unaffected.
 */
export function costBreakdown(
  modelString: string,
  usage: TokenUsage,
  rates?: UsageRates | null,
): CostBreakdownUsd {
  const c = rates ?? resolveRates(modelString);
  if (!c) return { ...ZERO_BREAKDOWN };

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const inputNonCached = Math.max(usage.inputTokens - cacheRead - cacheWrite, 0);

  const reasoning = usage.reasoningTokens ?? 0;
  const outputNonReasoning =
    c.reasoning != null ? Math.max(usage.outputTokens - reasoning, 0) : usage.outputTokens;
  const reasoningCost = c.reasoning != null ? reasoning * c.reasoning : 0;

  const input = (inputNonCached * c.input) / 1_000_000;
  const output = (outputNonReasoning * c.output + reasoningCost) / 1_000_000;
  const cacheReadCost = (cacheRead * c.cacheRead) / 1_000_000;
  // Cache writes are TTL-tiered. `cacheWrite1hTokens` is the 1-hour portion
  // (2x base input); the remainder is the 5-minute portion (the catalog's
  // `cacheWrite` rate, ~1.25x). When the split is absent — legacy events from
  // before TTL tiering, when every write was 1-hour — treat the whole write as
  // 1-hour so historical figures stay accurate. Reads are TTL-independent.
  //
  // Both tier rates come from `resolveRates` (or the stored line), so the
  // derivation has one home rather than two.
  //
  // The "absent → 2x" default is Anthropic-specific (the only provider the
  // platform caches with, and the only one that reports cache-write tokens —
  // OpenAI/Gemini caching is read-discount or out-of-band, so `cacheWrite` is 0
  // there and this is a no-op). If a future provider reports cache writes with a
  // different write multiplier, gate this default on the model's provider rather
  // than assuming 2x.
  const cacheWrite1h = usage.cacheWrite1hTokens ?? cacheWrite;
  const cacheWrite5m = Math.max(cacheWrite - cacheWrite1h, 0);
  const cacheWriteCost =
    (cacheWrite1h * c.cacheWrite1h + cacheWrite5m * c.cacheWrite5m) / 1_000_000;

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

/** Format USD cost for display. Sub-penny non-zero values shown as cents; zero is "$0.00". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(2)}`;
}

/** Format token count for display (e.g., "2.5M", "512K", "450"). */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}
