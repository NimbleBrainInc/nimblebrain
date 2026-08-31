/**
 * Model Catalog — provides model metadata, pricing, and capabilities.
 *
 * Data is vendored from models.dev at build time (catalog-data.json).
 * Run `bun run sync-models` to refresh.
 */

import { log } from "../observability/log.ts";
import catalogData from "./catalog-data.json";
import greenptData from "./catalog-greenpt.json";
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

// Nebius metadata comes from the account's own `/v1/models` API via
// `bun run sync-nebius`, not from models.dev, and lands in catalog-nebius.json
// to be merged here. models.dev does carry a `nebius` entry, but it is
// community-maintained and drifts from what a given account actually serves —
// it omits ids this account serves, lists ids it doesn't, and includes
// 8K-context `-fast` variants that the sync's own context floor exists to
// reject. The account API is the source of record for a gateway whose lineup is
// account- and tier-specific. Keeping this out of catalog-data.json means
// `bun run sync-models` (which rewrites only the models.dev-backed providers)
// can never clobber it.
//
// GreenPT's catalog is curated separately for the same reason: models.dev
// cannot be the source until its GreenPT entry ships. The model ids and
// capabilities come from GreenPT's `/v1/models` endpoint and model cards.
// GreenPT bills in EUR, so catalog-greenpt.json converts the July 2026 prices
// to the USD units this catalog requires at the ECB reference rate from
// 2026-07-24 (1 EUR = 1.1377 USD).
//
// Curated by hand on 2026-08-05, with no generator and no probe behind it —
// unlike `sync-nebius`, which pulls the account's `/v1/models` and verifies
// what it writes. Re-check the ids, prices, and capabilities against GreenPT's
// published models before trusting this file far past that date.
//
// Every GreenPT entry carries `limits.output` at the platform default
// (`DEFAULT_MAX_OUTPUT_TOKENS`) because GreenPT publishes no per-model output
// cap. `resolveMaxOutputTokens` sends `limits.output` as `max_tokens`, so a
// figure invented here is a real ceiling on every request — and one set to the
// full context window leaves the prompt no room at all. `sync-models` collapses
// exactly that shape to the same default, and every `catalog-nebius.json` entry
// carries it for the same reason. Replace a figure only with one GreenPT
// publishes.
const data = { ...catalogData, ...greenptData, ...nebiusData } as CatalogData;

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
/**
 * Can this model serve a chat turn?
 *
 * Derived from the catalog rather than listed by hand, because the catalog is
 * synced and a hand-maintained set goes stale on the next sync — two others in
 * this area already have.
 *
 * The two halves answer different questions, and only one of them currently
 * excludes anything.
 *
 * **Text in and out** is the product requirement: this platform is text-only.
 * On its own it does not remove embeddings — the catalog records those as text
 * in, text out, because a vector is not a modality it distinguishes.
 *
 * **Tool calling** is what actually separates an embedding or an image model
 * from a chat model: every turn here hands the model a tool surface, so one
 * that cannot call a tool cannot serve a slot, and no chat model lacks it.
 *
 * Tool calling alone would exclude the same set today, so the modality check is
 * kept for the case it is the only guard against — a tool-calling model that
 * emits audio or images rather than text, which is the direction omni models
 * are heading. It states the requirement rather than relying on a proxy that
 * happens to coincide with it.
 */
function isChatCapable(model: CatalogModel): boolean {
  return (
    model.modalities.input.includes("text") &&
    model.modalities.output.includes("text") &&
    model.capabilities.toolCall
  );
}

/**
 * Does org policy permit this model?
 *
 * Takes an already-qualified `provider:id` — this module cannot normalize one
 * itself, because the resolver that does lives downstream of it.
 *
 * Unset and empty both mean permissive. An empty array is the same statement
 * as no array: an org that has selected nothing has not thereby forbidden
 * everything, and treating it as a total ban would take a deployment offline
 * on a mis-click.
 */
export function isModelInPolicy(qualifiedModel: string, allowed?: string[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(qualifiedModel);
}

/**
 * The models a deployment will offer for selection.
 *
 * Filtered, not flagged — and only here. `listModels` and `getModelByString`
 * still return everything, so a past turn on a since-excluded model still
 * resolves for cost reconstruction. Same split `deprecated` already uses.
 */
export function getAvailableModels(
  configuredProviders: Record<string, { models?: string[] }>,
  allowed?: string[],
): Record<string, CatalogModel[]> {
  const result: Record<string, CatalogModel[]> = {};
  for (const [provider, config] of Object.entries(configuredProviders)) {
    result[provider] = listModels(provider, config.models).filter(
      (m) => !m.deprecated && isChatCapable(m) && isModelInPolicy(`${provider}:${m.id}`, allowed),
    );
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
 * Every tier OpenAI accepts on the wire. `minimal` sits below the ladder and is
 * deliberately not in OPENAI_EFFORTS: it is reachable only by a caller that
 * asks for it by name (the home briefing), never by stepping down from a
 * requested depth.
 */
export type OpenAIWireEffort = OpenAIEffort | "minimal";

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
 * bounded from above as well as below, and not a `-pro` model — so don't read
 * the restrictions as a `-pro` rule and skip measuring the rest.
 */
const FULL_LADDER: ReadonlySet<OpenAIWireEffort> = new Set(OPENAI_EFFORTS);
/** The three models that also take the sub-`low` `minimal` tier. */
const FULL_PLUS_MINIMAL: ReadonlySet<OpenAIWireEffort> = new Set([...OPENAI_EFFORTS, "minimal"]);

const OPENAI_EFFORT_SUPPORT: Record<string, ReadonlySet<OpenAIWireEffort>> = {
  // Restricted — measured rejections.
  "gpt-5-pro": new Set(["high"]),
  "gpt-5.2-pro": new Set(["medium", "high"]),
  "gpt-5.4-pro": new Set(["medium", "high"]),
  "gpt-5.5-pro": new Set(["medium", "high"]),
  // Deprecated, and hidden from the picker — but a pinned `providers.openai.models`
  // entry still resolves it, and it still rejects `low` and `high` on the wire.
  // Drop this row once models.dev stops carrying the model (OpenAI shutdown 2026-08-10).
  "gpt-5.2-chat-latest": new Set(["medium"]),

  // Measured and unrestricted — 20 of the 25 reachable models.
  "gpt-5": FULL_PLUS_MINIMAL,
  "gpt-5-mini": FULL_PLUS_MINIMAL,
  "gpt-5-nano": FULL_PLUS_MINIMAL,
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
 * Reasoning models the API will not serve for this account — both return
 * "model does not exist" at every tier, so their ladder cannot be measured.
 *
 * This does NOT make them restricted: they are absent from the support map, so
 * a lookup still returns the full ladder. Its only effect is to exempt them
 * from the coverage guard below, which would otherwise fail CI forever over
 * models nobody can reach. Both are still offered in the picker and still fall
 * through to the full ladder, so this is a known gap, not a safe one — #811.
 */
const OPENAI_UNAVAILABLE: ReadonlySet<string> = new Set([
  "gpt-5.3-codex-spark",
  "gpt-realtime-2.1",
]);

/** Whether this model accepts the sub-`low` `minimal` tier. */
export function openaiAcceptsMinimalEffort(modelString: string): boolean {
  return openaiSupportedEfforts(modelString).has("minimal");
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
    .filter(([, tiers]) => OPENAI_EFFORTS.some((e) => !tiers.has(e)))
    .map(([id]) => id);
}

/**
 * Which effort tiers this OpenAI model accepts. Keyed on the bare model id.
 *
 * OpenAI only — Nebius has its own builder and consults no table, because it
 * accepts all three tiers on every catalog model (measured) and its catalog is
 * curated and probe-verified rather than synced wholesale.
 */
export function openaiSupportedEfforts(modelString: string): ReadonlySet<OpenAIWireEffort> {
  const { modelId } = parseModelString(modelString);
  return OPENAI_EFFORT_SUPPORT[modelId] ?? FULL_LADDER;
}

/** xAI's effort ladder as the platform can express it, ascending. */
export const XAI_EFFORTS = ["low", "medium", "high"] as const;
export type XAIEffort = (typeof XAI_EFFORTS)[number];

/**
 * Every tier xAI accepts on the wire. `none` sits below the ladder and is
 * deliberately not in XAI_EFFORTS — same split as OpenAI's `minimal`, reachable
 * only by a caller naming it, never by stepping down from a requested depth.
 *
 * Unlike `minimal`, `none` genuinely suppresses: measured on `grok-4.3`,
 * `reasoning_effort: "none"` returns `reasoning_tokens: 0` against 150 at
 * `high`. It is the only *tier* that can implement `thinking: "off"` — the
 * other effort dialects have no such value and send nothing. Google reaches the
 * same end through a zero token budget, not a tier.
 */
export type XAIWireEffort = XAIEffort | "none";

/**
 * Effort ladder per xAI model, measured against `POST /v1/chat/completions`.
 *
 * **Fail-closed, following Google's table rather than OpenAI's.** An id absent
 * here gets NO reasoning options. The permissive "absent means full ladder"
 * default that `OPENAI_EFFORT_SUPPORT` uses would be actively wrong on this
 * provider: `grok-4.20-0309-reasoning` and `grok-build-0.1` are both flagged
 * reasoning-capable upstream and both reject `reasoning_effort` at *every*
 * tier — `Model <id> does not support parameter reasoningEffort` — so a
 * permissive default 400s every call to them, not just the one tier
 * `gpt-5-pro` refuses.
 *
 * An **empty set** is a measured fact, not a gap: the model reasons but exposes
 * no knob. `grok-4.20-0309-reasoning` returns 227 reasoning tokens with the
 * parameter omitted. That is why `capabilities.reasoning` stays `true` for it
 * while its ladder is empty — the flag says whether the model reasons, this
 * table says whether you can ask it to. Do not "fix" the 400 by flipping the
 * capability flag; that would misreport reasoning cost to say nothing of being
 * false.
 *
 * Absent vs. empty behave identically at the engine (send nothing) but differ
 * to `xaiUnmeasuredReasoningModels` below, which is what keeps a newly-synced
 * Grok from silently inheriting a guessed ladder.
 *
 * Only reasoning-capable models belong here. A non-reasoning one needs no row:
 * `resolveThinking` drops the override on `capabilities.reasoning` before the
 * builder runs, and `xaiUnmeasuredReasoningModels` filters on the same flag, so
 * a row for one classifies nothing.
 */
const XAI_EFFORT_SUPPORT: Record<string, ReadonlySet<XAIWireEffort>> = {
  // Full ladder plus suppression.
  "grok-4.3": new Set([...XAI_EFFORTS, "none"]),
  // Rejects `none` specifically ("This model does not support `reasoning_effort`
  // value..."); takes the rest.
  "grok-4.5": new Set(XAI_EFFORTS),
  // Reasons, no knob — every tier 400s. See the header.
  "grok-4.20-0309-reasoning": new Set(),
  "grok-build-0.1": new Set(),
};

/**
 * Catalog xAI reasoning models nobody has measured. Non-empty means
 * `sync-models` added one and its ladder is unknown — it will get no reasoning
 * options until measured, which is the safe direction but still a gap worth
 * failing CI over.
 */
export function xaiUnmeasuredReasoningModels(): string[] {
  const models = data.xai?.models ?? {};
  return Object.entries(models)
    .filter(([id, m]) => m.capabilities.reasoning && !(id in XAI_EFFORT_SUPPORT))
    .map(([id]) => id)
    .sort();
}

/** The model ids this table classifies. Exposed so tests can check each one is real. */
export function xaiEffortModelIds(): string[] {
  return Object.keys(XAI_EFFORT_SUPPORT);
}

/**
 * Which effort tiers this xAI model accepts, or `undefined` when there is no
 * measured answer — in which case the engine sends nothing. An empty set means
 * measured-and-none, and the engine treats it the same way.
 */
export function xaiSupportedEfforts(modelString: string): ReadonlySet<XAIWireEffort> | undefined {
  const { modelId } = parseModelString(modelString);
  return XAI_EFFORT_SUPPORT[modelId];
}
