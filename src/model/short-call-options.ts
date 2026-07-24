import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { getModelByString, getProviderFromModel } from "./catalog.ts";

/**
 * Provider-aware options for a short, single-shot auxiliary call — one made
 * outside the agentic loop with an output budget sized to its answer rather
 * than to a reasoning trace. Suppresses reasoning/thinking on every provider
 * that exposes a knob (gated on the catalog's `capabilities.reasoning` so
 * older models that don't expose the option get an empty options object).
 *
 * Every such callsite must pass these options. `maxOutputTokens` caps
 * thinking *plus* visible text, so a reasoning model on a tight budget can
 * spend the whole allowance on internal reasoning and return no content —
 * observed in production and recorded in `resolve-thinking.ts`. Newer models
 * make this the default rather than the exception: on Claude Opus 5, omitting
 * `thinking` entirely runs adaptive thinking, where Opus 4.7/4.8 ran none.
 *
 * **Anthropic cannot be told to stop thinking from here.** `@ai-sdk/anthropic`
 * serializes a `thinking` block only for `enabled` and `adaptive`; `disabled`
 * is accepted by the options schema and then dropped, producing a request byte-
 * identical to sending nothing (`test/unit/short-call-options.test.ts` pins
 * this against the pinned provider). `output_config.effort` does reach the
 * wire, so the Anthropic arm asks for the shallowest thinking available rather
 * than none. It reduces the failure mode; it does not remove it. The guarantee
 * on the default path is the model itself — see `DEFAULT_FAST_MODEL`.
 *
 * Callers: conversation titling, history compaction, and the home briefing.
 */
export function shortCallProviderOptions(modelString: string | null): SharedV3ProviderOptions {
  if (!modelString) return {};
  const provider = getProviderFromModel(modelString);
  const model = getModelByString(modelString);
  if (!model?.capabilities.reasoning) return {};
  switch (provider) {
    case "anthropic":
      return { anthropic: { effort: "low" } };
    case "google":
      return { google: { thinkingConfig: { thinkingBudget: 0 } } };
    case "openai":
      return { openai: { reasoningEffort: "minimal" } };
    case "nebius":
      // Deliberately no suppression, and NOT a silent fallthrough. Nebius rejects
      // `reasoning_effort` (HTTP 400) on its DeepSeek/Qwen/gpt-oss reasoning
      // models, and there's no shared alternative knob. It isn't needed anyway:
      // under the briefing's json_schema structured-output path these models
      // return clean JSON within the 1500-token budget (finish=stop, no reasoning
      // dump) — verified against a live account. Do not add a `reasoning_effort`
      // case here; it breaks the briefing rather than fixing it.
      return {};
    default:
      return {};
  }
}
