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
    nebius?: { apiKey?: string; baseURL?: string; models?: string[] };
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
    // No fail-closed guard here, unlike nebius below: when `baseURL` overrides
    // the endpoint it typically points at an OpenAI-compatible proxy
    // (LiteLLM/Helicone/Azure) that legitimately expects the OpenAI key, so
    // createOpenAI's OPENAI_API_KEY fallback is the desired behavior. Nebius is
    // a distinct third-party host that must never receive that key — hence the
    // asymmetry. Don't "unify" the two branches.
    providers.openai = createOpenAI({ apiKey, baseURL, organization });
  }

  if (providersCfg.google) {
    const { apiKey } = providersCfg.google;
    providers.google = createGoogleGenerativeAI({ apiKey });
  }

  if (providersCfg.nebius) {
    const { apiKey, baseURL } = providersCfg.nebius;
    // Nebius Token Factory is an OpenAI-compatible gateway for open-weight
    // models. It serves the Chat Completions API but NOT OpenAI's Responses
    // API, which createOpenAI's default `.languageModel()` binds — so route
    // through `.chat()`.
    //
    // Resolve the key explicitly and FAIL CLOSED when it's absent. createOpenAI's
    // built-in key fallback is OPENAI_API_KEY, so passing an undefined key here
    // would silently send the operator's *OpenAI* credential to Nebius's
    // endpoint. A configured-but-unauthenticated provider is a misconfiguration
    // worth surfacing loudly, never a credential leak.
    const nebiusApiKey = apiKey ?? process.env.NEBIUS_API_KEY;
    if (!nebiusApiKey) {
      throw new Error(
        "Provider 'nebius' is configured but no API key is set. " +
          "Set providers.nebius.apiKey or the NEBIUS_API_KEY environment variable.",
      );
    }
    const nebius = createOpenAI({
      apiKey: nebiusApiKey,
      baseURL: baseURL ?? NEBIUS_DEFAULT_BASE_URL,
      name: "nebius",
    });
    providers.nebius = { ...nebius, languageModel: (modelId: string) => nebius.chat(modelId) };
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
