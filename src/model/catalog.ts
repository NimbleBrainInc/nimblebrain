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
// open-weight models, so their metadata lives in catalog-nebius.json — synced
// from the account's own `/v1/models` API by `bun run sync-nebius` — and is
// merged here. Keeping it out of catalog-data.json means `bun run sync-models`
// (which rewrites only the models.dev-backed providers) can never clobber it.
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
  "claude-opus-5",
  "claude-sonnet-5",
]);

/**
 * Whether the model accepts Anthropic's `thinking.type=enabled` shape.
 * Adaptive-only models reject it with `"thinking.type.enabled" is not
 * supported for this model. Use "thinking.type.adaptive" and
 * "output_config.effort" to control thinking behavior.` — the engine
 * translates the platform's `enabled` mode to that shape on the fly when
 * this returns false. Non-Anthropic providers always return true — the split
 * is an Anthropic-specific one, and the other providers' dialects are selected
 * elsewhere in `buildThinkingProviderOptions`.
 */
export function supportsEnabledThinking(modelString: string): boolean {
  const { provider, modelId } = parseModelString(modelString);
  if (provider !== "anthropic") return true;
  return !ADAPTIVE_ONLY_THINKING_MODELS.has(modelId);
}

/** Gemini 3's thinking-level ladder, ascending. */
export const GOOGLE_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type GoogleThinkingLevel = (typeof GOOGLE_THINKING_LEVELS)[number];

/**
 * How a Google model accepts a reasoning instruction. The two dialects do not
 * overlap: Gemini 3 takes `thinkingConfig.thinkingLevel`, and the 2.5 line
 * takes `thinkingConfig.thinkingBudget` and rejects a level outright.
 */
export type GoogleThinkingSupport =
  | { dialect: "level"; levels: ReadonlySet<GoogleThinkingLevel> }
  | { dialect: "budget"; min: number; max: number; canDisable: boolean };

/**
 * Per-model reasoning support for Google, hand-maintained from Google's
 * thinking docs. models.dev doesn't carry it, and — unlike Anthropic's split —
 * it is not even uniform within a generation: `gemini-3-pro-preview` accepts
 * only `low` and `high`, while `gemini-3.6-flash` accepts all four, and
 * `gemini-2.5-pro` cannot disable thinking at all where the flash models can.
 *
 * Deriving this from the model id was tried and is wrong twice over: a version
 * prefix can't express a per-model level set, and it silently misses the
 * `-latest` aliases and the non-`gemini-` reasoning entries (deep-research-*).
 *
 * A model absent from this table gets NO thinking options — exactly what every
 * Google model got before this wiring existed. Guessing a dialect is how a
 * stock install starts returning 400s.
 *
 * Coverage is deliberately partial, and the rule is exactly one thing: an
 * entry exists when Google publishes that model's support. Note that "Google
 * publishes it" spans more than one page — the thinking guide and the Gemini 3
 * guide carry different tables, and a model absent from one can be listed in
 * the other. Check both before concluding a model is undocumented.
 *
 * Two categories stay out regardless. The `-latest` aliases (`gemini-flash-
 * latest`, `gemini-flash-lite-latest`) point at a moving target, so any level
 * set pinned to them expires silently on Google's schedule rather than ours.
 * And models with no published support at all — `deep-research-*`,
 * `gemini-robotics-*`, the tts/live variants — run at their own default until
 * there is something to cite. Adding a row from a sibling's values would be
 * the guesswork this table replaced.
 */
const GOOGLE_THINKING: Record<string, GoogleThinkingSupport> = {
  "gemini-3.6-flash": { dialect: "level", levels: new Set(GOOGLE_THINKING_LEVELS) },
  "gemini-3.5-flash": { dialect: "level", levels: new Set(GOOGLE_THINKING_LEVELS) },
  "gemini-3.5-flash-lite": { dialect: "level", levels: new Set(GOOGLE_THINKING_LEVELS) },
  "gemini-3-flash-preview": { dialect: "level", levels: new Set(GOOGLE_THINKING_LEVELS) },
  "gemini-3.1-pro-preview": { dialect: "level", levels: new Set(["low", "medium", "high"]) },
  "gemini-3-pro-preview": { dialect: "level", levels: new Set(["low", "high"]) },
  "gemini-3.1-flash-lite": { dialect: "level", levels: new Set(GOOGLE_THINKING_LEVELS) },
  "gemini-3.1-flash-lite-image": { dialect: "level", levels: new Set(["minimal", "high"]) },
  // The 2.5 rows are budget-shaped on purpose. Google's thinking page now
  // shows these three in the same levels table as Gemini 3, but its 2.5
  // reference states plainly that the 2.5 series does not support
  // `thinkingLevel` and takes `thinkingBudget` instead — and the budget path
  // is what the installed adapter and the live API accept. Left as budget
  // until the two agree; don't "correct" these from the levels table alone.
  "gemini-2.5-pro": { dialect: "budget", min: 128, max: 32768, canDisable: false },
  "gemini-2.5-flash": { dialect: "budget", min: 0, max: 24576, canDisable: true },
  "gemini-2.5-flash-lite": { dialect: "budget", min: 512, max: 24576, canDisable: true },
};

/** The model ids this table classifies. Exposed so tests can check each one is real. */
export function googleThinkingModelIds(): string[] {
  return Object.keys(GOOGLE_THINKING);
}

/**
 * How this Google model accepts a reasoning instruction, or `undefined` when we
 * have no verified answer — in which case the engine sends nothing.
 */
export function googleThinkingSupport(modelString: string): GoogleThinkingSupport | undefined {
  const { modelId } = parseModelString(modelString);
  return GOOGLE_THINKING[modelId];
}

/** OpenAI's effort ladder as the platform can express it, ascending. */
export const OPENAI_EFFORTS = ["low", "medium", "high"] as const;
export type OpenAIEffort = (typeof OPENAI_EFFORTS)[number];

/**
 * Effort ladder per OpenAI model, measured against `POST /v1/responses` rather
 * than taken from docs. Every reachable catalog reasoning model is listed,
 * restricted or not — presence means "someone measured this", which is what
 * `openaiUnmeasuredReasoningModels` below checks. Absent means unmeasured, and
 * the lookup falls back to the full ladder, so a model `sync-models` adds is
 * permissive by default until the coverage test forces a measurement.
 *
 * Restriction is per-model exactly as on Gemini 3, and the adapter doesn't gate
 * it — it forwards the string and the API rejects it. `gpt-5-pro` is the one
 * that bites with no configuration at all: it rejects `medium`, which is
 * `DEFAULT_THINKING_EFFORT`, so a slot pointed at it 400s on every call.
 * `gpt-5.2-chat-latest` is the one that breaks the shape the rest suggest —
 * bounded from above as well as below, and not a `-pro` model.
 */
const FULL_LADDER: ReadonlySet<OpenAIEffort> = new Set(OPENAI_EFFORTS);

const OPENAI_EFFORT_SUPPORT: Record<string, ReadonlySet<OpenAIEffort>> = {
  // Restricted — measured rejections.
  "gpt-5-pro": new Set(["high"]),
  "gpt-5.2-pro": new Set(["medium", "high"]),
  "gpt-5.4-pro": new Set(["medium", "high"]),
  "gpt-5.5-pro": new Set(["medium", "high"]),
  "gpt-5.2-chat-latest": new Set(["medium"]),

  // Measured and unrestricted — 20 of the 25 reachable models.
  "gpt-5": FULL_LADDER,
  "gpt-5-mini": FULL_LADDER,
  "gpt-5-nano": FULL_LADDER,
  "gpt-5.1": FULL_LADDER,
  "gpt-5.2": FULL_LADDER,
  "gpt-5.3-codex": FULL_LADDER,
  "gpt-5.4": FULL_LADDER,
  "gpt-5.4-mini": FULL_LADDER,
  "gpt-5.4-nano": FULL_LADDER,
  "gpt-5.5": FULL_LADDER,
  "gpt-5.6": FULL_LADDER,
  "gpt-5.6-luna": FULL_LADDER,
  "gpt-5.6-sol": FULL_LADDER,
  "gpt-5.6-terra": FULL_LADDER,
  o1: FULL_LADDER,
  "o1-pro": FULL_LADDER,
  o3: FULL_LADDER,
  "o3-mini": FULL_LADDER,
  "o3-pro": FULL_LADDER,
  "o4-mini": FULL_LADDER,
};

/**
 * Models accepting `minimal`, the tier below `low` used for short internal
 * calls. Almost nothing takes it: 22 of the 25 reachable reasoning models
 * reject it, including every mainline model from `gpt-5.1` on and the whole
 * o-series. `gpt-5.1`+ replaced it with `none`, which the platform never sends.
 */
const OPENAI_MINIMAL_EFFORT: ReadonlySet<string> = new Set(["gpt-5", "gpt-5-mini", "gpt-5-nano"]);

/**
 * Reasoning models the API will not serve for this account — both return
 * "model does not exist" at every tier, so their ladder cannot be measured.
 *
 * This does NOT make them restricted: they are absent from the support map, so
 * a lookup still returns the full ladder. Its only effect is to exempt them
 * from the coverage guard below, which would otherwise fail CI forever over
 * models nobody can reach. Revisit if the account gains access.
 */
const OPENAI_UNAVAILABLE: ReadonlySet<string> = new Set([
  "gpt-5.3-codex-spark",
  "gpt-realtime-2.1",
]);

/** Whether this model accepts the sub-`low` `minimal` tier. */
export function openaiAcceptsMinimalEffort(modelString: string): boolean {
  return OPENAI_MINIMAL_EFFORT.has(parseModelString(modelString).modelId);
}

/**
 * Catalog reasoning models nobody has measured. Non-empty means `sync-models`
 * added one and its ladder is a guess — the map's "absent means full ladder"
 * default would silently hand it all three tiers.
 */
export function openaiUnmeasuredReasoningModels(): string[] {
  const models = data.openai?.models ?? {};
  return Object.entries(models)
    .filter(
      ([id, m]) =>
        m.capabilities.reasoning && !(id in OPENAI_EFFORT_SUPPORT) && !OPENAI_UNAVAILABLE.has(id),
    )
    .map(([id]) => id)
    .sort();
}

/** The model ids with a restricted ladder. Exposed so tests can check each is real. */
export function openaiRestrictedEffortModelIds(): string[] {
  return Object.entries(OPENAI_EFFORT_SUPPORT)
    .filter(([, tiers]) => tiers.size < OPENAI_EFFORTS.length)
    .map(([id]) => id);
}

/**
 * Which effort tiers this OpenAI-family model accepts.
 *
 * Keyed on the bare model id, and reached for Nebius too — both providers run
 * through the OpenAI adapter. Safe because every Nebius id is org-qualified
 * (`Qwen/Qwen3-32B`) and so cannot collide with a bare OpenAI id; a Nebius
 * model therefore always falls through to the full ladder, which matches
 * measurement — Nebius accepts all three on every catalog model.
 */
export function openaiSupportedEfforts(modelString: string): ReadonlySet<OpenAIEffort> {
  const { modelId } = parseModelString(modelString);
  return OPENAI_EFFORT_SUPPORT[modelId] ?? FULL_LADDER;
}
