import type { LanguageModelV3, SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { ModelSlots } from "../runtime/types.ts";
import { getModelByString, getProviderFromModel } from "./catalog.ts";

/** Named role for a model in tenant config — matches `keyof ModelSlots`. */
export type ModelSlotName = keyof ModelSlots;

/**
 * Resolved profile for a model slot. Bundles the model instance with the
 * provider-aware defaults that match the slot's semantic intent ("fast"
 * = optimize for latency, "reasoning" = optimize for thinking, "default"
 * = balanced).
 *
 * Centralizing these defaults in slot resolution means every fast-slot
 * caller (briefing, conversation title, skill matching, etc.) gets the
 * same latency optimizations for free, without each caller having to
 * know which provider knob to flip.
 */
export interface ModelProfile {
  /** Slot the profile was built from. */
  slot: ModelSlotName;
  /** Resolved model instance ready to call. */
  model: LanguageModelV3;
  /** Resolved "provider:model-id" string for the slot. */
  modelString: string;
  /** Provider name parsed from modelString (e.g. "anthropic", "google"). */
  provider: string;
  /**
   * Default provider options for this slot, derived from slot semantics
   * + the model's catalog capabilities. Callers may merge their own
   * overrides on top when a specific call needs to deviate from the
   * slot's intent.
   */
  providerOptions: SharedV3ProviderOptions;
}

/**
 * Provider options that express the slot's intent for the given model.
 *
 * Today:
 *   - `fast` suppresses reasoning/thinking everywhere it's controllable
 *     (anthropic thinking disabled, gemini 2.5 thinking budget 0, openai
 *     reasoning-model effort minimal). Models that don't expose a knob
 *     (gemini 2.0, gpt-4o, etc.) get an empty options object.
 *   - `default` and `reasoning` return empty — `reasoning` is driven by
 *     the engine's per-call `buildThinkingProviderOptions` against the
 *     operator's thinking config, and emitting options here would
 *     double-apply.
 *
 * Future: a tenant override knob could let operators upgrade or
 * downgrade the slot's defaults per workspace (e.g. "for ipsdi's fast
 * slot, allow thinking — I'm willing to pay the latency"). The shape
 * here makes that a localized change.
 */
export function buildSlotProviderOptions(
  slot: ModelSlotName,
  modelString: string,
): SharedV3ProviderOptions {
  if (slot !== "fast") return {};

  const provider = getProviderFromModel(modelString);
  switch (provider) {
    case "anthropic": {
      // Gate on capabilities.reasoning for symmetry with the other
      // providers. The Anthropic API has accepted
      // `thinking: { type: "disabled" }` across all models historically
      // (the engine emits it unconditionally for thinking-mode "off"),
      // but only reasoning-capable Claude models actually expose the
      // knob. Sending the option to older 3.x models is a no-op today;
      // gating here keeps the wire shape symmetric across providers
      // and removes a class of future SDK-tightening risk.
      const model = getModelByString(modelString);
      if (model?.capabilities.reasoning) {
        return { anthropic: { thinking: { type: "disabled" } } };
      }
      return {};
    }
    case "google": {
      const model = getModelByString(modelString);
      if (model?.capabilities.reasoning) {
        return { google: { thinkingConfig: { thinkingBudget: 0 } } };
      }
      return {};
    }
    case "openai": {
      const model = getModelByString(modelString);
      if (model?.capabilities.reasoning) {
        return { openai: { reasoningEffort: "minimal" } };
      }
      return {};
    }
    default:
      return {};
  }
}
