/**
 * Canonical token-usage shape — used by engine, runtime, conversation
 * events, storage, and cost computation.
 *
 * Provider-aligned with AI SDK V3 (LanguageModelV3Usage):
 *   inputTokens  = grand total of input-side tokens
 *                = noCache + cacheRead + cacheWrite
 *   outputTokens = grand total of output-side tokens
 *                = text + reasoning
 *   cacheReadTokens, cacheWriteTokens, reasoningTokens are SUBSETS of
 *   the totals above. Cost computation must subtract them from the totals
 *   before applying the full input/output rates.
 *
 * One shape, one definition. Anything that touches token counts uses this
 * type — there is intentionally no "partial" or "flat" alternative. The
 * compiler enforces that callers supply the full struct, which is what
 * keeps cost computation from silently dropping a field.
 */
import type { LanguageModelV3Usage } from "@ai-sdk/provider";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /**
   * The portion of `cacheWriteTokens` written with a 1-HOUR TTL (billed at 2x
   * base input vs 1.25x for the 5-minute remainder). The engine tiers TTL by
   * breakpoint stability (1h on system+tools, 5m on the rolling history), so
   * this distinguishes the two for accurate costing. Subset of
   * `cacheWriteTokens`; the rest is the 5-minute portion. Absent on legacy
   * events (pre-tiering, when all writes were 1h) — cost treats absent as
   * all-1h so historical figures stay correct.
   */
  cacheWrite1hTokens?: number;
}

/**
 * Map an AI SDK V3 `doGenerate`/`doStream` usage struct into the canonical
 * `TokenUsage`.
 *
 * Deliberately omits `cacheWrite1hTokens` — that 1h/5m split comes from
 * provider metadata the engine reads separately, not from this usage struct.
 * Cost treats an absent split as all-1h (the 2x rate; see `cost.ts`), so a
 * caller that sets `cache_control` breakpoints AND maps usage only through here
 * would over-cost its cache writes. Safe for the current callers (the forked
 * `fast`-slot utility calls — compaction summarizer, auto-title, briefing —
 * issue raw `doGenerate` with no breakpoints, so `cacheWriteTokens` is ~0); the
 * engine layers the 1h split on top of this for the main loop.
 */
export function tokenUsageFromV3(usage: LanguageModelV3Usage): TokenUsage {
  return {
    inputTokens: usage.inputTokens.total ?? 0,
    outputTokens: usage.outputTokens.total ?? 0,
    cacheReadTokens: usage.inputTokens.cacheRead ?? 0,
    cacheWriteTokens: usage.inputTokens.cacheWrite ?? 0,
    reasoningTokens: usage.outputTokens.reasoning ?? 0,
  };
}

/** Zero-valued TokenUsage. Convenience for accumulators. */
export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    // cacheWrite1hTokens is intentionally left undefined: it is tri-state, where
    // absent means "no TTL split reported" (cost treats that as all-1h). Forcing
    // it to 0 here would wrongly mark every accumulated write as 5-minute.
  };
}

/** Add `delta` into `target` in place. */
export function addUsage(target: TokenUsage, delta: TokenUsage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0);
  // Preserve the tri-state: only materialize a number once some call actually
  // reported a 1h split, so "no split reported" stays absent (→ cost assumes 1h)
  // rather than collapsing to an explicit 0 (→ cost would assume all 5-minute).
  //
  // ASSUMES all deltas are same-era (same deploy): either all carry the split or
  // none do. That holds within a run (every event is same-deploy) and is the
  // only way addUsage is used today — the usage aggregator sums per-record
  // *costs* (each priced correctly by costBreakdown), never raw usage across the
  // boundary. Mixing a split-bearing delta with a legacy (no-split) one would
  // mis-bucket the legacy writes as 5-minute; that cross-deploy aggregation is
  // out of scope here (handled per-record at the cost boundary).
  if (target.cacheWrite1hTokens != null || delta.cacheWrite1hTokens != null) {
    target.cacheWrite1hTokens = (target.cacheWrite1hTokens ?? 0) + (delta.cacheWrite1hTokens ?? 0);
  }
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0);
}
