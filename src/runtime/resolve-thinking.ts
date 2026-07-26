import {
  DEFAULT_THINKING_EFFORT,
  type EffortSource,
  type ResolvedThinking,
  type ThinkingEffort,
} from "../engine/types.ts";
import { getModelByString } from "../model/catalog.ts";
import { log } from "../observability/log.ts";

/**
 * Model strings already warned about, so a dropped override is reported once
 * per process rather than on every LLM call.
 */
const warnedUncatalogued = new Set<string>();

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

/** Where the resolved depth came from — see {@link EffortSource}. */
function effortSourceFor(input: ResolveThinkingInput): EffortSource {
  if (input.configEffort != null) return "operator";
  if (input.configMode != null) return "mode";
  return (input.configBudgetTokens ?? 0) > 0 ? "mode" : "platform";
}

/**
 * Whether the operator asked for reasoning that this call is about to drop.
 *
 * Derived from {@link effortSourceFor}, not from `configMode` alone: depth and
 * budget are each an override on their own, and the settings panel's
 * default-mode payload is a `thinkingEffort` with no mode at all. A gate that
 * reads only the mode is therefore silent on the most common way to set one.
 *
 * `off` is excluded because dropping it costs nothing — no reasoning is exactly
 * what it asked for. That is where this predicate parts company with the
 * engine's `operatorAsked`, which does report a dropped `off`: on an unmapped
 * Google model an off state exists and goes unsent, whereas here the model has
 * no reasoning parameter at all.
 */
function askedForReasoning(input: ResolveThinkingInput): boolean {
  return input.configMode !== "off" && effortSourceFor(input) !== "platform";
}

/** The settings being dropped, named so the warning is actionable. */
function describeOverride(input: ResolveThinkingInput): string {
  const set = [
    input.configMode != null ? `thinking="${input.configMode}"` : null,
    input.configEffort != null ? `thinkingEffort="${input.configEffort}"` : null,
    (input.configBudgetTokens ?? 0) > 0 ? `thinkingBudgetTokens=${input.configBudgetTokens}` : null,
  ].filter((s) => s != null);
  return set.join(" + ");
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
 *   1. Non-reasoning model (or no model) → `undefined`. The engine omits
 *      thinking from the provider call entirely.
 *   2. Operator override (`configMode`):
 *      - `off`      → passed through. Not enforceable on every model — see
 *                     `RuntimeConfig.thinking`.
 *      - `adaptive` → passed through bare. Adaptive states no depth, so an
 *                     effort or budget alongside it is deliberately dropped.
 *      - `enabled`  → an explicit budget if the operator set one, otherwise
 *                     their effort tier, otherwise the default tier.
 *   3. No override → the same treatment as `enabled`, so a stock install
 *      reasons at a known depth rather than at whatever the provider does
 *      when told nothing.
 *
 * Note what is absent: nothing here reads `maxOutputTokens`. An output
 * ceiling caps the response; it says nothing about reasoning depth. Sizing
 * thinking from it is what turned a number nobody chose into a directive to
 * reason maximally on every call.
 */
export function resolveThinking(input: ResolveThinkingInput): ResolvedThinking | undefined {
  // The capability gate runs on every path, including explicit overrides. An
  // override can ask for reasoning; it cannot make the parameter exist on a
  // model that has none. Skipping it for `enabled` was inert while Anthropic
  // was the only wired provider and the engine dropped everything else — with
  // OpenAI and Google wired it became a live send of a parameter the model
  // doesn't take, on every call. Google is protected by its per-model table;
  // this is the same gate for the other two, in the one place all three share.
  //
  // It removes the ability to force thinking on a model the catalog marks
  // non-reasoning. That belongs in the catalog entry, which is the source of
  // truth this already consults.
  const supportsReasoning = input.model
    ? (getModelByString(input.model)?.capabilities.reasoning ?? false)
    : false;
  if (!supportsReasoning) {
    // Dropping an instruction the operator wrote is worth saying out loud. A
    // model absent from the catalog is a supported configuration (pinned ids,
    // and OpenAI-compatible proxies with their own model names — see
    // `resolveModelString`), and it lands here looking identical to a genuinely
    // non-reasoning model, so the warning naming the model is the whole
    // diagnosis.
    if (input.model && askedForReasoning(input) && !warnedUncatalogued.has(input.model)) {
      warnedUncatalogued.add(input.model);
      log.warn(
        `[thinking] Ignoring ${describeOverride(input)} for "${input.model}": the model is ` +
          "not in the catalog or is not flagged reasoning-capable, so no reasoning options are " +
          "sent. Add it to the catalog (or correct its `capabilities.reasoning`) to enable " +
          "thinking on it. Logged once per model.",
      );
    }
    return undefined;
  }

  if (input.configMode === "off") return { mode: "off" };
  if (input.configMode === "adaptive") return { mode: "adaptive" };

  // Depth is always resolved, even when a budget is set. The two are not
  // alternatives: a budget meters thinking on the providers that count tokens,
  // and the tier is what every other provider uses. Dropping the tier here
  // because a budget exists would make the depth control inert on exactly the
  // effort-shaped models it was added for.
  // Set once, here, and carried on both arms. Deriving it per call site is how
  // the budget arm ended up without it while the effort arm had it, and the
  // two engine carve-outs keyed off a field only one of them saw.
  const effort = input.configEffort ?? DEFAULT_THINKING_EFFORT;
  const source = effortSourceFor(input);
  if (input.configBudgetTokens != null && input.configBudgetTokens > 0) {
    return { mode: "enabled", budgetTokens: input.configBudgetTokens, effort, source };
  }
  return { mode: "effort", effort, source };
}
