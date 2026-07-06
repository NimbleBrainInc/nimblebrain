import type { ResolvedThinking } from "../engine/types.ts";
import { getModelByString } from "../model/catalog.ts";

export interface ResolveThinkingInput {
  /** Operator/tenant config value. Wins over the model-default. */
  configMode?: "off" | "adaptive" | "enabled";
  /** Operator-pinned token budget for `enabled` mode. */
  configBudgetTokens?: number;
  /** Resolved model string (e.g. `"anthropic:claude-opus-4-7"`). */
  model?: string;
  /**
   * Resolved per-call output budget. Strongly recommended — without it,
   * the platform-default and `enabled` paths can't compute a useful
   * thinking budget and fall back to the 1024-token floor, which gives
   * reasoning models far less room than they need. Pass it from the
   * runtime so the cap leaves at least `MIN_VISIBLE_OUTPUT_TOKENS` of
   * room for visible content while still giving thinking enough budget
   * to produce quality reasoning. Optional only to keep legacy callsites
   * compiling.
   */
  maxOutputTokens?: number;
}

/**
 * Tokens reserved for visible content when thinking is on. The Anthropic
 * Claude Opus 4.7 model with `adaptive` thinking and a tight `max_tokens`
 * was observed in production spending the entire output budget on internal
 * reasoning and emitting zero visible content. This floor guarantees the
 * model always has room to actually answer.
 */
const MIN_VISIBLE_OUTPUT_TOKENS = 4096;

/** Anthropic's stated minimum thinking budget. Below this the API rejects. */
const MIN_THINKING_BUDGET_TOKENS = 1024;

/**
 * Compute a thinking budget that leaves at least `MIN_VISIBLE_OUTPUT_TOKENS`
 * for visible content. Floors at Anthropic's minimum (1024). When
 * `requestedBudget` is provided, clamps to it (so an operator override
 * can lower the budget but never raise it past the safe ceiling).
 */
function safeThinkingBudget(maxOutputTokens: number, requestedBudget?: number): number {
  const ceiling = Math.max(MIN_THINKING_BUDGET_TOKENS, maxOutputTokens - MIN_VISIBLE_OUTPUT_TOKENS);
  if (requestedBudget != null && requestedBudget > 0) {
    return Math.min(requestedBudget, ceiling);
  }
  return ceiling;
}

/** Budget for `enabled`: safe cap when the output budget is known, else the operator value or the floor. */
function enabledBudget(maxOutputTokens?: number, requestedBudget?: number): number {
  if (maxOutputTokens != null) {
    return safeThinkingBudget(maxOutputTokens, requestedBudget);
  }
  if (requestedBudget != null && requestedBudget > 0) {
    return requestedBudget;
  }
  return MIN_THINKING_BUDGET_TOKENS;
}

/** Adaptive carries an operator budget only when positive; the Anthropic adapter currently drops it, but a future provider may honor it. */
function adaptiveThinking(configBudgetTokens?: number): ResolvedThinking {
  if (configBudgetTokens != null && configBudgetTokens > 0) {
    return { mode: "adaptive", budgetTokens: configBudgetTokens };
  }
  return { mode: "adaptive" };
}

/** Resolve an operator override (`configMode`) into its thinking shape; `enabled` always carries a safe budget. */
function resolveOverride(
  input: ResolveThinkingInput,
  configMode: "off" | "adaptive" | "enabled",
): ResolvedThinking {
  if (configMode === "off") {
    return { mode: "off" };
  }
  if (configMode === "adaptive") {
    return adaptiveThinking(input.configBudgetTokens);
  }
  return {
    mode: "enabled",
    budgetTokens: enabledBudget(input.maxOutputTokens, input.configBudgetTokens),
  };
}

/**
 * Resolve the effective thinking mode for an LLM call.
 *
 * Platform invariant: when thinking is on, at least
 * `MIN_VISIBLE_OUTPUT_TOKENS` are reserved for visible content. The model
 * can never spend the whole output budget on reasoning and emit nothing.
 *
 * Resolution priority:
 *   1. Operator override (`configMode`):
 *      - `off`       → passed through; engine emits provider-disabled.
 *      - `enabled`   → always carries a budget. Operator's budget (if any)
 *                      is clamped down to the safe ceiling so a too-large
 *                      value can't fail the API call.
 *      - `adaptive`  → passed through. The Anthropic provider does NOT
 *                      accept a budget on adaptive — the model decides per
 *                      call. Use `enabled` for predictable behavior.
 *   2. No override + reasoning-capable model → `enabled` with a safe
 *      budget. (Adaptive was the previous default but consumed entire
 *      output budgets in production; switched to `enabled` so the
 *      platform stays in control of thinking spend.)
 *   3. No override + non-reasoning model → `undefined` (engine omits
 *      thinking from the provider call entirely — cheapest path).
 */
export function resolveThinking(input: ResolveThinkingInput): ResolvedThinking | undefined {
  if (input.configMode != null) {
    return resolveOverride(input, input.configMode);
  }

  const supportsReasoning = input.model
    ? (getModelByString(input.model)?.capabilities.reasoning ?? false)
    : false;

  if (!supportsReasoning) return undefined;

  // Default for reasoning models: enabled with a capped budget so the model
  // can't spend the whole output budget on internal thinking and emit no
  // visible content.
  return {
    mode: "enabled",
    budgetTokens: enabledBudget(input.maxOutputTokens),
  };
}
