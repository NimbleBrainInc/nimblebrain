import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3, ProviderV3 } from "@ai-sdk/provider";
import { createProviderRegistry, type Provider } from "ai";
import { findProviderForModelId } from "./catalog.ts";
import { wrapFetchWithLiveness } from "./fetch-liveness.ts";

export interface ProvidersConfig {
  providers?: {
    anthropic?: { apiKey?: string; promptCaching?: boolean; models?: string[] };
    openai?: { apiKey?: string; baseURL?: string; organization?: string; models?: string[] };
    google?: { apiKey?: string; models?: string[] };
  };
}

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
    providers.openai = createOpenAI({ apiKey, baseURL, organization });
  }

  if (providersCfg.google) {
    const { apiKey } = providersCfg.google;
    providers.google = createGoogleGenerativeAI({ apiKey });
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
