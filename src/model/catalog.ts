/**
 * Model Catalog — provides model metadata, pricing, and capabilities.
 *
 * Data is vendored from models.dev at build time (catalog-data.json).
 * Run `bun run sync-models` to refresh.
 */

import { log } from "../observability/log.ts";
import catalogData from "./catalog-data.json";
import nebiusData from "./catalog-nebius.json";

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

// ============================================================================
// Catalog
// ============================================================================

type CatalogData = Record<
  string,
  { name: string; models: Record<string, Omit<CatalogModel, "provider">> }
>;

// models.dev (the `sync-models` source) doesn't list Nebius Token Factory's
// open-weight models, so their metadata is hand-maintained in
// catalog-nebius.json and merged here. Keeping it out of catalog-data.json
// means `bun run sync-models` — which rewrites only the models.dev-backed
// providers — can never clobber it.
const data = { ...catalogData, ...nebiusData } as CatalogData;

/**
 * Reverse lookup: bare model id → owning provider. Built once at module
 * load (O(N) over all catalog entries). Lets `findProviderForModelId`
 * answer in O(1) and gives us a place to surface duplicate ids — if the
 * same id is declared under two providers, routing of the bare id silently
 * depends on JSON insertion order, which is not a contract we want.
 *
 * Logs a warning rather than throwing: duplicates are a data hygiene
 * issue, not a fatal one. The first-seen provider wins, matching prior
 * behavior.
 */
const idToProvider: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [provider, p] of Object.entries(data)) {
    for (const id of Object.keys(p.models)) {
      const existing = map.get(id);
      if (existing) {
        log.warn(
          `[catalog] Duplicate model id "${id}" appears in providers "${existing}" and "${provider}". ` +
            `findProviderForModelId will return "${existing}" (first seen); routing of the bare id ` +
            `should not depend on iteration order. Qualify with "<provider>:" or rename one entry.`,
        );
      } else {
        map.set(id, provider);
      }
    }
  }
  return map;
})();

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
 * Find which provider in the catalog owns the given bare model id.
 * Used by the resolver to rescue bare ids written to disk before the
 * settings UI started encoding `provider:` into option values.
 *
 * Returns null when the id isn't in any provider's catalog. O(1) via
 * the precomputed `idToProvider` map; duplicates surface as warnings
 * at module load.
 */
export function findProviderForModelId(modelId: string): string | null {
  return idToProvider.get(modelId) ?? null;
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
 * Get the list of available models for configured providers, respecting
 * allowlists. Deprecated models are excluded — this feeds the settings
 * model picker, and a model the upstream provider has shut down (e.g.
 * `google:gemini-3-pro-preview`, retired 2026-03-09) must not be
 * re-selectable. `listModels` stays honest as "all models for a provider";
 * the "available to pick" filter lives here. Note this does not retroactively
 * fix a slot already pointing at a deprecated model — that override must be
 * repointed in workspace/tenant config separately.
 */
export function getAvailableModels(
  configuredProviders: Record<string, { models?: string[] }>,
): Record<string, CatalogModel[]> {
  const result: Record<string, CatalogModel[]> = {};
  for (const [provider, config] of Object.entries(configuredProviders)) {
    result[provider] = listModels(provider, config.models).filter((m) => !m.deprecated);
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

/**
 * Extract the provider name from a model string. Bare strings (no `:`)
 * are treated as `"anthropic"` — same rule as `getModelByString`.
 * Single source of truth for that convention.
 */
export function getProviderFromModel(modelString: string): string {
  return parseModelString(modelString).provider;
}

/**
 * Anthropic model IDs that reject `thinking.type=enabled` and require
 * `thinking.type=adaptive` plus `output_config.effort` instead. Hardcoded
 * (not synced from models.dev — that source doesn't track this
 * distinction). Add new IDs here when Anthropic ships them.
 *
 * Matched by exact id. The catalog carries no dated variants for these
 * models, so exact match suffices; a dated id (e.g. `claude-opus-4-8-20260101`)
 * would fall through to the `enabled` shape and 400 — add it here if
 * models.dev ever emits one.
 */
const ADAPTIVE_ONLY_THINKING_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-5",
]);

/**
 * Whether the model accepts Anthropic's `thinking.type=enabled` shape.
 * Adaptive-only models reject it with `"thinking.type.enabled" is not
 * supported for this model. Use "thinking.type.adaptive" and
 * "output_config.effort" to control thinking behavior.` — the engine
 * translates the platform's `enabled` mode to that shape on the fly when
 * this returns false. Non-Anthropic providers always return true; the
 * engine only emits Anthropic thinking options today.
 */
export function supportsEnabledThinking(modelString: string): boolean {
  const { provider, modelId } = parseModelString(modelString);
  if (provider !== "anthropic") return true;
  return !ADAPTIVE_ONLY_THINKING_MODELS.has(modelId);
}
