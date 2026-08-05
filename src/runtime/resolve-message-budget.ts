import { estimateToolDescriptionTokens } from "../engine/token-estimate.ts";
import type { ToolSchema } from "../engine/types.ts";
import { getModelByString } from "../model/catalog.ts";
import { log } from "../observability/log.ts";

/**
 * Floor for the per-call safety margin. Binding for any model whose context
 * window is under ~164K, where the ratio below resolves smaller.
 */
export const MIN_BUDGET_SAFETY_MARGIN_TOKENS = 8_192;

/**
 * Fraction of the context window held back as the safety margin.
 *
 * The margin covers (a) drift between our pre-flight token estimates and the
 * provider's real tokenizer, (b) per-call overhead the provider charges that
 * we don't see (Anthropic cache framing, etc.), and (c) room for reactive
 * recovery to retry without immediately re-overflowing.
 *
 * It scales with the window because (a) does. The estimators are deliberately
 * cheap — `chars/4` for text, and the same shape for JSON tool schemas, where
 * it is weakest — so their ABSOLUTE error grows with the prompt while a fixed
 * margin does not. Held flat, the margin shrinks as a fraction of exactly the
 * quantity it has to absorb: 4% of a 200K window, 3.1% of a 262K one, less
 * again on the million-token models. A prompt composed to fill a large window
 * then overflows by the drift the margin was supposed to cover.
 *
 * This bounds the error rather than measuring it. Reading the provider's own
 * `llm.response.usage` back to calibrate the estimate is the durable fix and
 * is tracked separately; this floor is what that would fall back to on a
 * conversation's first turn, where no measurement exists yet.
 */
export const BUDGET_SAFETY_MARGIN_RATIO = 0.05;

/**
 * The safety margin for a model's context window — the ratio above, never
 * below the floor. `modelContextWindow` of 0 (catalog miss) yields the floor.
 */
export function budgetSafetyMarginTokens(modelContextWindow: number): number {
  return Math.max(
    MIN_BUDGET_SAFETY_MARGIN_TOKENS,
    Math.ceil(modelContextWindow * BUDGET_SAFETY_MARGIN_RATIO),
  );
}

export interface ResolveMessageBudgetInput {
  /** Resolved provider-qualified model id (e.g. "anthropic:claude-opus-4-7"). */
  model: string;
  /** Operator/tenant cap from runtime config. Acts as an upper bound only. */
  configMaxInputTokens: number;
  /** The system prompt that will go on this call. */
  systemPrompt: string;
  /** Active tool schemas that will be advertised on this call. */
  tools: ToolSchema[];
  /** Already-resolved `maxOutputTokens` for this call (catalog-clamped). */
  maxOutputTokens: number;
  /** Override for the safety margin. Defaults to `budgetSafetyMarginTokens(context)`. */
  safetyMarginTokens?: number;
}

export interface ResolveMessageBudgetResult {
  /** Tokens available for message history on this call. May be 0 in pathological cases. */
  budget: number;
  /** Breakdown of the composition — useful for telemetry / debugging. */
  breakdown: {
    modelContextWindow: number | null;
    systemPromptTokens: number;
    toolTokens: number;
    maxOutputTokens: number;
    safetyMarginTokens: number;
    configMaxInputTokens: number;
    /** True when the composed headroom was the binding constraint. False when the config cap was. */
    boundedByModel: boolean;
  };
}

/**
 * Compose the per-call message token budget from first principles:
 *
 *   budget = min(
 *     configMaxInputTokens,
 *     modelContextWindow − systemTokens − toolTokens − maxOutputTokens − safetyMargin
 *   )
 *
 * The model's catalog `limits.context` is the absolute ceiling. Subtracting
 * the static per-call overhead (system + tools + reserved output + safety)
 * yields the maximum tokens we can spend on message history without the
 * provider rejecting the request for exceeding the context window. The
 * operator's `configMaxInputTokens` caps that headroom from below — never
 * raises it.
 *
 * If the resolved model isn't in the catalog (typo, brand-new model
 * pre-sync), fall back to `configMaxInputTokens` directly. This preserves
 * the prior behavior for unknown models rather than silently zeroing the
 * budget; missing catalog data should not break sends.
 *
 * Estimators are intentionally cheap and conservative:
 *   - System prompt: chars/4 (text-only, matches `approxTokens` elsewhere).
 *   - Tool schemas: `estimateToolDescriptionTokens` from
 *     `src/engine/token-estimate.ts` — same estimator the `context.assembled`
 *     telemetry uses, so the reported and enforced budgets agree.
 *
 * The reactive-recovery path (engine-side, on a provider-reported overflow)
 * can call this with the same inputs and a tighter `safetyMarginTokens` to
 * re-trim before a retry. The composition is pure; callers own the policy.
 */
export function resolveMessageBudget(input: ResolveMessageBudgetInput): ResolveMessageBudgetResult {
  const catalogModel = getModelByString(input.model);
  const modelCtx = catalogModel?.limits.context ?? null;
  // Scales with the window, so the margin tracks the estimator drift it exists
  // to absorb. A catalog miss has no window to scale against and takes the floor.
  const safety = input.safetyMarginTokens ?? budgetSafetyMarginTokens(modelCtx ?? 0);

  const systemTokens = Math.ceil(input.systemPrompt.length / 4);
  const toolTokens = input.tools.reduce((sum, t) => sum + estimateToolDescriptionTokens(t), 0);

  const baseBreakdown = {
    modelContextWindow: modelCtx,
    systemPromptTokens: systemTokens,
    toolTokens,
    maxOutputTokens: input.maxOutputTokens,
    safetyMarginTokens: safety,
    configMaxInputTokens: input.configMaxInputTokens,
  };

  if (modelCtx === null) {
    // Catalog miss. Fall back to the config cap so the call still ships,
    // but warn loudly: this is the only path where `configMaxInputTokens`
    // re-acquires its old "target" semantics (no overhead subtracted), so
    // a typo'd model id or a brand-new model that's ahead of the vendored
    // catalog can still overflow on the first call. The engine's reactive
    // recovery (one retry, halved budget) is the safety net; operators
    // tuning catalog sync should see this in stderr aggregates.
    log.warn(
      `[runtime] resolveMessageBudget: model "${input.model}" not in catalog; ` +
        `falling back to configMaxInputTokens=${input.configMaxInputTokens} as budget. ` +
        `Per-call overhead is NOT subtracted on this path — the call may overflow and rely on engine recovery.`,
    );
    return {
      budget: input.configMaxInputTokens,
      breakdown: { ...baseBreakdown, boundedByModel: false },
    };
  }

  const headroom = modelCtx - systemTokens - toolTokens - input.maxOutputTokens - safety;
  if (headroom <= 0) {
    // The static per-call cost already exceeds the context window. The
    // call will almost certainly fail at the provider; returning 0 lets
    // `windowMessages` keep just the anchor plus the last atomic group and
    // surfaces the condition via the breakdown.
    return { budget: 0, breakdown: { ...baseBreakdown, boundedByModel: true } };
  }

  if (headroom <= input.configMaxInputTokens) {
    return { budget: headroom, breakdown: { ...baseBreakdown, boundedByModel: true } };
  }
  return {
    budget: input.configMaxInputTokens,
    breakdown: { ...baseBreakdown, boundedByModel: false },
  };
}
