import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { getModelByString, getProviderFromModel } from "./catalog.ts";

/**
 * Provider options for "short structured" LLM calls — small JSON output,
 * single-shot, user-blocking (briefing, conversation titles, etc.).
 *
 * Suppresses provider-specific reasoning/thinking so latency tracks
 * generation time, not adaptive deliberation. Without this, Gemini 2.5
 * defaults to dynamic thinking (variable, occasionally >15s) and OpenAI
 * o-series / gpt-5 default to medium reasoning effort — neither is
 * appropriate for a 1-sentence-lede + 1-section-per-facet response.
 *
 * Returns `{}` for providers/models without a thinking knob (e.g.
 * Gemini 2.0, gpt-4o), so callers can spread unconditionally.
 */
export function shortCallProviderOptions(modelString: string): SharedV3ProviderOptions {
  const provider = getProviderFromModel(modelString);

  switch (provider) {
    case "anthropic":
      return { anthropic: { thinking: { type: "disabled" } } };

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
