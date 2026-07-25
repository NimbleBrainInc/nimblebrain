import {
  DEFAULT_THINKING_EFFORT,
  type ResolvedThinking,
  type ThinkingEffort,
} from "../engine/types.ts";
import { getModelByString } from "../model/catalog.ts";

export interface ResolveThinkingInput {
  /** Operator/tenant config value. Wins over the model-default. */
  configMode?: "off" | "adaptive" | "enabled";
  /** Operator-chosen reasoning depth. */
  configEffort?: ThinkingEffort;
  /** Operator-pinned token budget. Honored only on budget-shaped providers. */
  configBudgetTokens?: number;
  /** Resolved model string (e.g. `"anthropic:claude-opus-5"`). */
  model?: string;
}

/**
 * Resolve the effective thinking config for an LLM call.
 *
 * Provider-neutral by construction: this function never looks at which
 * provider owns the model. It decides *whether* to reason and *how hard*;
 * translating that into `thinking.type`, `reasoningEffort`, or a token
 * budget is the engine's job (`buildThinkingProviderOptions`).
 *
 * Resolution priority:
 *   1. Operator override (`configMode`):
 *      - `off`      → passed through. Not enforceable on every model — see
 *                     `RuntimeConfig.thinking`.
 *      - `adaptive` → passed through bare. Adaptive states no depth, so an
 *                     effort or budget alongside it is deliberately dropped.
 *      - `enabled`  → an explicit budget if the operator set one, otherwise
 *                     their effort tier, otherwise the default tier.
 *   2. No override + reasoning-capable model → the same treatment as
 *      `enabled`, so a stock install reasons at a known depth rather than
 *      at whatever the provider does when told nothing.
 *   3. No override + non-reasoning model → `undefined` (the engine omits
 *      thinking from the provider call entirely — cheapest path).
 *
 * Note what is absent: nothing here reads `maxOutputTokens`. An output
 * ceiling caps the response; it says nothing about reasoning depth. Sizing
 * thinking from it is what turned a number nobody chose into a directive to
 * reason maximally on every call.
 */
export function resolveThinking(input: ResolveThinkingInput): ResolvedThinking | undefined {
  if (input.configMode === "off") return { mode: "off" };
  if (input.configMode === "adaptive") return { mode: "adaptive" };

  if (input.configMode !== "enabled") {
    const supportsReasoning = input.model
      ? (getModelByString(input.model)?.capabilities.reasoning ?? false)
      : false;
    if (!supportsReasoning) return undefined;
  }

  // Depth is always resolved, even when a budget is set. The two are not
  // alternatives: a budget meters thinking on the providers that count tokens,
  // and the tier is what every other provider uses. Dropping the tier here
  // because a budget exists would make the depth control inert on exactly the
  // effort-shaped models it was added for.
  const effort = input.configEffort ?? DEFAULT_THINKING_EFFORT;
  if (input.configBudgetTokens != null && input.configBudgetTokens > 0) {
    return { mode: "enabled", budgetTokens: input.configBudgetTokens, effort };
  }
  return { mode: "effort", effort };
}
