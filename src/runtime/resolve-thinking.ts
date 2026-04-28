import type { ResolvedThinking } from "../engine/types.ts";
import { getModelByString } from "../model/catalog.ts";

export interface ResolveThinkingInput {
  /** Operator/tenant config value. Wins over the model-default. */
  configMode?: "off" | "adaptive" | "enabled";
  /** Operator-pinned token budget for `enabled` mode. */
  configBudgetTokens?: number;
  /** Resolved model string (e.g. `"anthropic:claude-opus-4-7"`). */
  model?: string;
}

/**
 * Resolve the effective thinking mode for an LLM call.
 *
 * The platform's policy:
 *   - If the operator pinned a `configMode`, use it as-is. Their call.
 *   - Otherwise: `adaptive` for catalog-flagged reasoning-capable models,
 *     `off` for everything else.
 *
 * Returns `undefined` when the resolved mode is `off` AND there's no
 * operator override — that signals "don't pass thinking to the provider
 * at all" (the cheapest, most boring path). When the operator explicitly
 * sets `off`, the engine still passes a provider-specific "disabled"
 * option so the provider doesn't fall back to its own default.
 */
export function resolveThinking(input: ResolveThinkingInput): ResolvedThinking | undefined {
  if (input.configMode != null) {
    return {
      mode: input.configMode,
      ...(input.configBudgetTokens != null && input.configBudgetTokens > 0
        ? { budgetTokens: input.configBudgetTokens }
        : {}),
    };
  }

  // No operator override — fall back to model capability.
  const supportsReasoning = input.model
    ? (getModelByString(input.model)?.capabilities.reasoning ?? false)
    : false;

  if (supportsReasoning) return { mode: "adaptive" };
  return undefined;
}
