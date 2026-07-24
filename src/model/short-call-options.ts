import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { getModelByString, getProviderFromModel } from "./catalog.ts";

/**
 * Anthropic model IDs that think when the `thinking` parameter is omitted.
 *
 * This is the whole reason the Anthropic arm exists, and it is a much smaller
 * set than `capabilities.reasoning`. Every Claude model through Opus 4.8 runs
 * *no* thinking unless asked, so a short call to one needs nothing from us —
 * sending `effort` there would change the request without preventing any
 * failure. Opus 5 and Sonnet 5 flipped that default, so on those a tight
 * `maxOutputTokens` can be consumed by a reasoning trace with nothing left for
 * the answer.
 *
 * Both members also accept `output_config.effort`, which is the other half of
 * the requirement — Haiku 4.5 and Sonnet 4.5 reason but reject it, and Opus
 * 4.1 predates it, so a set keyed on the reasoning flag would put a rejected
 * parameter on the wire.
 *
 * Hand-maintained for the same reason as `ADAPTIVE_ONLY_THINKING_MODELS`:
 * models.dev doesn't track it, so `sync-models` can't. A model missing here
 * gets no options — the safe direction, and identical to how the platform
 * behaved before this set existed — and
 * `test/unit/short-call-options.test.ts` fails on any Anthropic reasoning
 * model that isn't explicitly classified either way.
 */
const THINKS_BY_DEFAULT: ReadonlySet<string> = new Set(["claude-opus-5", "claude-sonnet-5"]);

/**
 * Provider-aware options for a short, single-shot auxiliary call — one made
 * outside the agentic loop with an output budget sized to its answer rather
 * than to a reasoning trace. Returns `undefined` when there is nothing to say,
 * so callers can pass the result straight through.
 *
 * `maxOutputTokens` caps thinking *plus* visible text, so a model that thinks
 * on a tight budget can spend the whole allowance on internal reasoning and
 * return no content — observed in production and recorded in
 * `resolve-thinking.ts`.
 *
 * **Anthropic cannot be told to stop thinking from here.** `@ai-sdk/anthropic`
 * serializes a `thinking` block only for `enabled` and `adaptive`; `disabled`
 * is accepted by the options schema and then dropped, producing a request
 * byte-identical to sending nothing (`test/unit/short-call-options.test.ts`
 * pins this against the resolved provider version). `output_config.effort`
 * does reach the wire, so the Anthropic arm asks for the shallowest thinking
 * available rather than none — on the two models where thinking happens
 * uninvited. It reduces the failure mode; it does not remove it. The guarantee
 * on the default path is the model itself — see `DEFAULT_FAST_MODEL`.
 *
 * Callers: conversation titling, history compaction, and the home briefing.
 */
export function shortCallProviderOptions(
  modelString: string | null,
): SharedV3ProviderOptions | undefined {
  if (!modelString) return undefined;
  const provider = getProviderFromModel(modelString);
  const model = getModelByString(modelString);
  if (!model?.capabilities.reasoning) return undefined;
  switch (provider) {
    case "anthropic":
      return THINKS_BY_DEFAULT.has(model.id) ? { anthropic: { effort: "low" } } : undefined;
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
      return undefined;
    default:
      return undefined;
  }
}
