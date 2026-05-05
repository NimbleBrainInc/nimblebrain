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
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** Zero-valued TokenUsage. Convenience for accumulators. */
export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

/** Add `delta` into `target` in place. */
export function addUsage(target: TokenUsage, delta: TokenUsage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0);
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0);
}
