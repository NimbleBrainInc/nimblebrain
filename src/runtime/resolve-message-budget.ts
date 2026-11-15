import { estimateToolDescriptionTokens } from "../engine/token-estimate.ts";
import type { ToolSchema } from "../engine/types.ts";
import { getModelByString } from "../model/catalog.ts";
import { log } from "../observability/log.ts";
import { MAX_TOKEN_ESTIMATE_CORRECTION } from "./token-estimate-correction.ts";

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
 * This remains the floor on a conversation's first turn, or whenever there
 * is no comparable provider usage from its previous turn.
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
  /** Operator/tenant cap on estimated input tokens from runtime config. */
  configMaxInputTokens: number;
  /** The system prompt that will go on this call. */
  systemPrompt: string;
  /** Active tool schemas that will be advertised on this call. */
  tools: ToolSchema[];
  /** Already-resolved `maxOutputTokens` for this call (catalog-clamped). */
  maxOutputTokens: number;
  /** Override for the safety margin. Defaults to `budgetSafetyMarginTokens(context)`. */
  safetyMarginTokens?: number;
  /** Previous same-model provider usage divided by its disjoint prompt estimate; 1 without data. */
  estimateCorrection?: number;
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
    /** Conservative correction applied to both the configured cap and model headroom. */
    estimateCorrection: number;
    /** True when the composed headroom was the binding constraint. False when the config cap was. */
    boundedByModel: boolean;
  };
}

/**
 * Compose the per-call message token budget from first principles:
 *
 *   budget = min(
 *     configMaxInputTokens / correction − systemTokens − toolTokens,
 *     (modelContextWindow − maxOutputTokens − safetyMargin) / correction
 *       − systemTokens − toolTokens
 *   )
 *
 * The model's catalog `limits.context` is the absolute ceiling. The
 * correction reduces each estimated input allowance before subtracting the
 * static system and tool estimates. The operator's `configMaxInputTokens`
 * caps that allowance from below — never raises it. With no prior
 * measurement, correction is 1 and the model-window safety margin remains.
 *
 * If the resolved model isn't in the catalog (typo, brand-new model
 * pre-sync), fall back to the corrected config cap. Missing catalog data
 * should not silently zero the budget or break sends.
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
  const measured = input.estimateCorrection;
  const correction =
    measured !== undefined && Number.isFinite(measured)
      ? Math.min(MAX_TOKEN_ESTIMATE_CORRECTION, Math.max(1, measured))
      : 1;

  const systemTokens = Math.ceil(input.systemPrompt.length / 4);
  const toolTokens = input.tools.reduce((sum, t) => sum + estimateToolDescriptionTokens(t), 0);
  const correctedConfigCap = Math.max(
    0,
    Math.floor(input.configMaxInputTokens / correction - systemTokens - toolTokens),
  );

  const baseBreakdown = {
    modelContextWindow: modelCtx,
    systemPromptTokens: systemTokens,
    toolTokens,
    maxOutputTokens: input.maxOutputTokens,
    safetyMarginTokens: safety,
    configMaxInputTokens: input.configMaxInputTokens,
    estimateCorrection: correction,
  };

  if (modelCtx === null) {
    // Catalog miss. Fall back to the corrected config cap so the call still
    // ships, but warn: without the model's context limit the provider can
    // still reject a prompt. Reactive recovery is the safety net.
    log.warn(
      `[runtime] resolveMessageBudget: model "${input.model}" not in catalog; ` +
        `falling back to corrected history budget=${correctedConfigCap}; ` +
        `unknown model context may still require engine recovery.`,
    );
    return {
      budget: correctedConfigCap,
      breakdown: { ...baseBreakdown, boundedByModel: false },
    };
  }

  const headroom = Math.floor(
    (modelCtx - input.maxOutputTokens - safety) / correction - systemTokens - toolTokens,
  );
  if (headroom <= 0) {
    // The static per-call cost already exceeds the context window. The
    // call will almost certainly fail at the provider; returning 0 lets
    // `windowMessages` keep just the anchor plus the last atomic group and
    // surfaces the condition via the breakdown.
    return { budget: 0, breakdown: { ...baseBreakdown, boundedByModel: true } };
  }

  if (headroom <= correctedConfigCap) {
    return { budget: headroom, breakdown: { ...baseBreakdown, boundedByModel: true } };
  }
  return {
    budget: correctedConfigCap,
    breakdown: { ...baseBreakdown, boundedByModel: false },
  };
}
