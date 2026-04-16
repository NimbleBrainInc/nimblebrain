import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3, ProviderV3 } from "@ai-sdk/provider";
import { createProviderRegistry, type Provider } from "ai";

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
    providers.anthropic = createAnthropic({ apiKey });
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
 * Bare strings (no `:`) are prefixed with `anthropic:` for backward compat.
 */
export function resolveModelString(model: string): string {
  if (model.includes(":")) {
    return model;
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
