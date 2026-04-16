/**
 * Model Catalog — provides model metadata, pricing, and capabilities.
 *
 * Data is vendored from models.dev at build time (catalog-data.json).
 * Run `bun run sync-models` to refresh.
 */

import catalogData from "./catalog-data.json";

// ============================================================================
// Types
// ============================================================================

export interface ModelCost {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cached input tokens (read) */
  cacheRead?: number;
  /** USD per 1M cache write tokens */
  cacheWrite?: number;
  /** USD per 1M reasoning tokens */
  reasoning?: number;
}

export interface ModelLimits {
  /** Max context window tokens */
  context: number;
  /** Max output tokens */
  output: number;
}

export interface ModelCapabilities {
  toolCall: boolean;
  reasoning: boolean;
  attachment: boolean;
}

export interface CatalogModel {
  id: string;
  provider: string;
  name: string;
  cost: ModelCost;
  limits: ModelLimits;
  capabilities: ModelCapabilities;
  modalities: { input: string[]; output: string[] };
  family?: string;
  knowledgeCutoff?: string;
  releaseDate?: string;
  deprecated?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

// ============================================================================
// Catalog
// ============================================================================

type CatalogData = Record<
  string,
  { name: string; models: Record<string, Omit<CatalogModel, "provider">> }
>;

const data = catalogData as CatalogData;

/**
 * Look up a model by provider and model ID.
 * Returns undefined if not in catalog.
 */
export function getModel(provider: string, modelId: string): CatalogModel | undefined {
  const p = data[provider];
  if (!p) return undefined;
  const m = p.models[modelId];
  if (!m) return undefined;
  return { ...m, provider };
}

/**
 * Look up a model by its full "provider:model-id" string.
 * Bare strings (no colon) are treated as anthropic.
 */
export function getModelByString(modelString: string): CatalogModel | undefined {
  const { provider, modelId } = parseModelString(modelString);
  return getModel(provider, modelId);
}

/**
 * List all models for a provider. Optionally filter by an allowlist.
 */
export function listModels(provider: string, allowedModelIds?: string[]): CatalogModel[] {
  const p = data[provider];
  if (!p) return [];
  const entries = Object.values(p.models);
  const models = entries.map((m) => ({ ...m, provider }));
  if (allowedModelIds && allowedModelIds.length > 0) {
    return models.filter((m) => allowedModelIds.includes(m.id));
  }
  return models;
}

/** List all provider IDs in the catalog. */
export function listProviders(): string[] {
  return Object.keys(data);
}

/** Get provider display name. */
export function getProviderName(provider: string): string {
  return data[provider]?.name ?? provider;
}

/**
 * Estimate cost in USD from token usage.
 * Returns 0 for models not in catalog.
 */
export function estimateCost(modelString: string, usage: TokenUsage): number {
  const model = getModelByString(modelString);
  if (!model) return 0;
  const c = model.cost;

  const cacheRead = usage.cacheReadTokens ?? 0;
  return (
    (usage.inputTokens * c.input +
      usage.outputTokens * c.output +
      cacheRead * (c.cacheRead ?? c.input) +
      (usage.cacheWriteTokens ?? 0) * (c.cacheWrite ?? c.input) +
      (usage.reasoningTokens ?? 0) * (c.reasoning ?? c.output)) /
    1_000_000
  );
}

/**
 * Check whether a model string is valid for the given configured providers.
 * If a provider has a `models` allowlist, validates against it.
 */
export function isModelAllowed(
  modelString: string,
  configuredProviders: Record<string, { models?: string[] }>,
): boolean {
  const { provider, modelId } = parseModelString(modelString);
  const providerConfig = configuredProviders[provider];
  if (!providerConfig) return false;
  if (providerConfig.models && providerConfig.models.length > 0) {
    return providerConfig.models.includes(modelId);
  }
  return true;
}

/**
 * Get the list of available models for configured providers, respecting allowlists.
 */
export function getAvailableModels(
  configuredProviders: Record<string, { models?: string[] }>,
): Record<string, CatalogModel[]> {
  const result: Record<string, CatalogModel[]> = {};
  for (const [provider, config] of Object.entries(configuredProviders)) {
    result[provider] = listModels(provider, config.models);
  }
  return result;
}

// ============================================================================
// Helpers
// ============================================================================

function parseModelString(modelString: string): { provider: string; modelId: string } {
  const idx = modelString.indexOf(":");
  if (idx === -1) return { provider: "anthropic", modelId: modelString };
  return { provider: modelString.slice(0, idx), modelId: modelString.slice(idx + 1) };
}
