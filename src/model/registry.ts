import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3, ProviderV3 } from "@ai-sdk/provider";
import { createXai } from "@ai-sdk/xai";
import { createProviderRegistry, type Provider } from "ai";
import { findProviderForModelId } from "./catalog.ts";
import { wrapFetchWithLiveness } from "./fetch-liveness.ts";

export interface ProvidersConfig {
  providers?: {
    anthropic?: { apiKey?: string; promptCaching?: boolean; models?: string[] };
    openai?: { apiKey?: string; baseURL?: string; organization?: string; models?: string[] };
    google?: { apiKey?: string; models?: string[] };
    nebius?: { apiKey?: string; baseURL?: string; models?: string[] };
    xai?: { apiKey?: string; baseURL?: string; models?: string[] };
  };
}

/** Nebius Token Factory's OpenAI-compatible inference endpoint. */
const NEBIUS_DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

/**
 * Build a provider registry from config. Creates AI SDK provider instances
 * for each configured provider.
 */
export function buildRegistry(config: ProvidersConfig): Provider {
  const providersCfg = config.providers ?? { anthropic: {} };

  const providers: Record<string, ProviderV3> = {};

  if (providersCfg.anthropic) {
    const { apiKey } = providersCfg.anthropic;
    // Wrap fetch with the transport-liveness tap so the stream watchdog re-arms
    // on Anthropic's swallowed `ping` keep-alives — otherwise a healthy-but-slow
    // stream at large context trips the idle deadline. See fetch-liveness.ts.
    // The cast bridges an unused member: the SDK types `fetch` as the full
    // `typeof fetch` (incl. Bun's static `preconnect`) but only ever invokes the
    // call signature, which the wrapper implements.
    providers.anthropic = createAnthropic({
      apiKey,
      fetch: wrapFetchWithLiveness(globalThis.fetch) as typeof fetch,
    });
  }

  if (providersCfg.openai) {
    const { apiKey, baseURL, organization } = providersCfg.openai;
    // No fail-closed guard here, unlike nebius below, and the asymmetry is
    // about whose key it is. `OPENAI_API_KEY` is this provider's own variable,
    // and when `baseURL` points at an OpenAI-compatible proxy
    // (LiteLLM/Helicone/Azure) that proxy legitimately expects it — so the
    // fallback is the desired behavior and an absent config key is normal.
    // Nebius throws instead because a missing key there has no sensible
    // fallback at all. Don't "unify" the two branches.
    providers.openai = createOpenAI({ apiKey, baseURL, organization });
  }

  if (providersCfg.google) {
    const { apiKey } = providersCfg.google;
    providers.google = createGoogleGenerativeAI({ apiKey });
  }

  if (providersCfg.nebius) {
    const { apiKey, baseURL } = providersCfg.nebius;
    // Nebius Token Factory is an OpenAI-compatible gateway for open-weight
    // models, so it is built through the adapter written for exactly that —
    // `createOpenAICompatible` — rather than through `createOpenAI` pointed at
    // a foreign `baseURL`. It binds Chat Completions natively (Nebius serves no
    // Responses API), so no `.chat()` re-wrap is needed.
    //
    // The key is still resolved explicitly and still FAILS CLOSED when absent,
    // but the reason is smaller than it was: this adapter has no
    // `OPENAI_API_KEY` fallback to leak through, so a keyless provider is a
    // misconfiguration rather than a credential hazard. Throwing at boot beats
    // an unauthenticated 401 on the first chat turn.
    const nebiusApiKey = apiKey ?? process.env.NEBIUS_API_KEY;
    if (!nebiusApiKey) {
      throw new Error(
        "Provider 'nebius' is configured but no API key is set. " +
          "Set providers.nebius.apiKey or the NEBIUS_API_KEY environment variable.",
      );
    }
    // Three of these are load-bearing, and each replaces something
    // `createOpenAI` did unconditionally. This adapter is generic, so what the
    // OpenAI adapter assumed must be asked for by name.
    //
    // `name` — provider options are read under it, so the engine sends
    //   `providerOptions.nebius`, not `openai`. See `buildNebiusThinkingOptions`.
    // `includeUsage` — sets `stream_options.include_usage`. Nebius returns
    //   `"usage": null` on every chunk without it (measured), so the engine's
    //   only path (`doStream`) would meter every turn at zero: no cost, no
    //   ledger tokens, no reasoning tokens.
    // `supportsStructuredOutputs` — without it a schema-bearing
    //   `responseFormat` degrades to `{"type":"json_object"}`, dropping the
    //   schema and strict decoding. The home briefing sends exactly that shape
    //   on every generation.
    providers.nebius = createOpenAICompatible({
      name: "nebius",
      apiKey: nebiusApiKey,
      baseURL: baseURL ?? NEBIUS_DEFAULT_BASE_URL,
      includeUsage: true,
      supportsStructuredOutputs: true,
    });
  }

  if (providersCfg.xai) {
    const { apiKey, baseURL } = providersCfg.xai;
    // No fail-closed key guard, unlike nebius above, and the asymmetry is
    // deliberate: createXai's own env fallback is XAI_API_KEY — its own
    // variable — so an absent key cannot send another provider's credential to
    // x.ai. That hazard is specific to reaching a third-party host through
    // createOpenAI, whose fallback is OPENAI_API_KEY. This follows the
    // openai/google shape instead: pass what config has and let the adapter
    // read its own env.
    //
    // `.languageModel()` binds Chat Completions on this adapter version
    // (XaiChatLanguageModel, provider "xai.chat"), so no `.chat()` re-wrap is
    // needed — the adapter also exposes `.responses()`, which is opt-in. The
    // registry test pins `provider === "xai.chat"`, so a dependency bump that
    // moves that default fails there rather than silently changing the API this
    // talks to.
    providers.xai = createXai({ apiKey, baseURL });
  }

  return createProviderRegistry(providers);
}

/**
 * Resolve a model string to provider:model-id format.
 *
 * - `provider:model-id` strings pass through unchanged.
 * - Bare strings are looked up in the catalog and routed to whichever
 *   provider declares them. This rescues bare ids that the settings UI
 *   wrote before it started encoding the provider into option values
 *   (e.g., `gemini-3.1-pro-preview` saved by an older client) — without
 *   the catalog lookup, those ids would default to anthropic and 404.
 * - Bare strings not in the catalog fall back to `anthropic:` for
 *   backward compat with bespoke / pinned model ids that pre-date the
 *   catalog-driven UI.
 */
export function resolveModelString(model: string): string {
  if (model.includes(":")) {
    return model;
  }
  const catalogProvider = findProviderForModelId(model);
  if (catalogProvider) {
    return `${catalogProvider}:${model}`;
  }
  return `anthropic:${model}`;
}

/**
 * Build a function that resolves model strings to LanguageModelV3 instances.
 * If no providers configured, defaults to anthropic with env var fallback.
 */
export function buildModelResolver(
  config: ProvidersConfig,
): (modelString: string) => LanguageModelV3 {
  const provider = buildRegistry(config);

  return (modelString: string): LanguageModelV3 => {
    const resolved = resolveModelString(modelString);
    return provider.languageModel(resolved) as LanguageModelV3;
  };
}
