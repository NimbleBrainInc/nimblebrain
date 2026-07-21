import { estimateToolDescriptionTokens } from "../engine/token-estimate.ts";
import type { ToolSchema } from "../engine/types.ts";
import { getModelByString } from "../model/catalog.ts";
import { log } from "../observability/log.ts";

/**
 * Per-call safety margin reserved against the model's context window after
 * subtracting the system prompt, tool schemas, and `maxOutputTokens`. This
 * covers (a) drift between our pre-flight token estimates and the provider's
 * real tokenizer, (b) per-call overhead the provider charges that we don't
 * see (Anthropic cache framing, etc.), and (c) leaves room for reactive
 * recovery to retry without immediately re-overflowing.
 *
 * Sized to be meaningful relative to typical conversation budgets without
 * eating substantial headroom on small-context models.
 */
export const DEFAULT_BUDGET_SAFETY_MARGIN_TOKENS = 8_192;

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
  /** Override for the safety margin. Defaults to DEFAULT_BUDGET_SAFETY_MARGIN_TOKENS. */
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
  const safety = input.safetyMarginTokens ?? DEFAULT_BUDGET_SAFETY_MARGIN_TOKENS;
  const catalogModel = getModelByString(input.model);
  const modelCtx = catalogModel?.limits.context ?? null;

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
