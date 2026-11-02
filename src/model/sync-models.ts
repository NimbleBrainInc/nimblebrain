#!/usr/bin/env bun
/**
 * Sync model catalog from models.dev.
 *
 * Fetches the full API, filters to supported providers (anthropic, openai,
 * google, xai, greenpt), normalizes the data, and writes catalog-data.json.
 *
 * Run: bun run sync-models
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../limits.ts";

const API_URL = "https://models.dev/api.json";
const SUPPORTED_PROVIDERS = ["anthropic", "openai", "google", "xai", "greenpt"];
const OUTPUT_PATH = join(dirname(new URL(import.meta.url).pathname), "catalog-data.json");

// Models present upstream that the platform deliberately does not surface —
// excluded from the catalog entirely, so they can't be selected in the picker
// or pointed at by a tenant model slot. Format: "<provider>:<modelId>".
const MANUAL_EXCLUSIONS = new Set<string>([
  // Anthropic's premium research tier ($10/$50 per 1M) — not offered on the platform.
  "anthropic:claude-fable-5",
  "anthropic:claude-fable-5-1",
  // OpenAI's Daybreak tier is gated per organization and not enabled for the
  // platform's account: blue returns "The requested Daybreak tier is not enabled
  // for this organization or project", red "does not exist or you do not have
  // access to it". Listing them would only offer models that fail on every call.
  "openai:gpt-daybreak-blue-latest",
  "openai:gpt-daybreak-red-latest",
  // Priced and listed upstream, but the Chat Completions endpoint refuses it
  // outright: `400 "Multi Agent requests are not allowed on chat completions"`,
  // returned ahead of even the billing gate. The runtime speaks Chat Completions
  // to xAI, so this model is unreachable rather than merely limited — upstream's
  // `tool_call: false` understates it.
  "xai:grok-4.20-multi-agent-0309",
  // GreenPT's response-style variants of glm-5.2: the same model and price under
  // a house writing style. A style is a prompt concern, not a model choice, and
  // nine of them would crowd the picker around the one model they share.
  "greenpt:glm-5.2-caveman",
  "greenpt:glm-5.2-caveman-lite",
  "greenpt:glm-5.2-caveman-ultra",
  "greenpt:glm-5.2-honey",
  "greenpt:glm-5.2-honey-lite",
  "greenpt:glm-5.2-honey-ultra",
  "greenpt:glm-5.2-ponytail",
  "greenpt:glm-5.2-ponytail-lite",
  "greenpt:glm-5.2-ponytail-ultra",
  // Listed and priced upstream, but GreenPT's Chat Completions endpoint answers
  // `400 Unsupported model` for each, and none is in its `/v1/models` listing.
  "greenpt:devstral-2-123b-instruct-2512",
  "greenpt:gemma-3-27b-it",
  "greenpt:glm-5.1",
  "greenpt:holo2-30b-a3b",
  "greenpt:kimi-k2.6-fast",
  "greenpt:pixtral-12b-2409",
  "greenpt:qwen3-coder-30b-a3b-instruct",
  "greenpt:voxtral-small-24b-2507",
]);

// Upstream reports each model's maximum limits, but some maxima are only
// reachable with a capability the platform doesn't enable. Sonnet 4.5's 1M
// context requires the `context-1m-2025-08-07` beta header, which the runtime
// never sends (the provider is built without that beta header).
// Pin such models to the limit the platform can actually use so the message
// budget resolver doesn't over-pack and trip a provider 400. Sonnet 4.6+ ship
// 1M as GA (headerless) and are left untouched. Format: "<provider>:<modelId>".
const MANUAL_LIMIT_OVERRIDES: Record<string, { context?: number; output?: number }> = {
  "anthropic:claude-sonnet-4-5": { context: 200000 },
  "anthropic:claude-sonnet-4-5-20250929": { context: 200000 },
};

// Upstream carries one rate card per model, so an introductory price that ends
// on a published date is either right before that date or right after it. A
// usage line stores the rates current when its call is made, and a spend
// account reserves at catalog rates, so the catalog carries the price that
// holds once the promotion ends: it over-records during the promotion rather
// than under-recording, and under-reserving, after it. Each entry replaces the
// rates named. Delete one once upstream carries the same rates.
// Format: "<provider>:<modelId>".
const MANUAL_COST_OVERRIDES: Record<
  string,
  { input?: number; output?: number; cacheRead?: number }
> = {
  // $2 / $10 / $0.10 through 2026-11-30, then $4 / $20 / $0.20 (cache hits are
  // 95% off input). https://ai.google.dev/gemini-api/docs/pricing
  "google:gemini-4-argon": { input: 4, output: 20, cacheRead: 0.2 },
};

export interface RawModel {
  id: string;
  name: string;
  family?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
    tiers?: RawCostTier[];
  };
  limit?: {
    context?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  status?: string;
}

/** A prompt-length rate card; `tier.size` is the prompt length it applies above. */
export interface RawCostTier {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
  tier?: { type?: string; size?: number };
}

export interface RawProvider {
  id: string;
  name: string;
  models: Record<string, RawModel>;
}

interface CatalogCostTier {
  aboveInputTokens: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

interface CatalogModel {
  id: string;
  name: string;
  family?: string;
  cost: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    tiers?: CatalogCostTier[];
  };
  limits: {
    context: number;
    output: number;
  };
  capabilities: {
    toolCall: boolean;
    reasoning: boolean;
    attachment: boolean;
  };
  modalities: {
    input: string[];
    output: string[];
  };
  knowledgeCutoff?: string;
  releaseDate?: string;
  deprecated?: boolean;
}

/** The optional per-bucket rates of a raw rate card, spread only when present. */
function optionalRates(cost: RawCostTier | undefined) {
  return {
    ...(cost?.cache_read != null ? { cacheRead: cost.cache_read } : {}),
    ...(cost?.cache_write != null ? { cacheWrite: cost.cache_write } : {}),
    ...(cost?.reasoning != null ? { reasoning: cost.reasoning } : {}),
  };
}

/**
 * The prompt-length rate cards, ascending. Only `context` tiers are kept: a
 * `context` tier's `size` is the prompt length above which the whole call bills
 * at that card, which is the one shape `costBreakdown` prices. Any other tier
 * type is dropped rather than misread as one.
 */
function toCatalogTiers(tiers: RawCostTier[] | undefined): CatalogCostTier[] {
  return (tiers ?? [])
    .filter((t) => t.tier?.type === "context" && typeof t.tier.size === "number")
    .map((t) => ({
      aboveInputTokens: t.tier?.size ?? 0,
      input: t.input ?? 0,
      output: t.output ?? 0,
      ...optionalRates(t),
    }))
    .sort((a, b) => a.aboveInputTokens - b.aboveInputTokens);
}

/** Normalize a raw cost block into the catalog cost shape; optional rates are spread only when present. */
function toCatalogCost(cost: RawModel["cost"]): CatalogModel["cost"] {
  const tiers = toCatalogTiers(cost?.tiers);
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    ...optionalRates(cost),
    ...(tiers.length ? { tiers } : {}),
  };
}

/** Whether upstream flags a model deprecated. */
function isModelDeprecated(raw: RawModel): boolean {
  return raw.status === "deprecated";
}

/** Normalize one raw model into a catalog entry; optional fields are spread only when present. */
function toCatalogModel(modelId: string, raw: RawModel): CatalogModel {
  return {
    id: modelId,
    name: raw.name || modelId,
    ...(raw.family ? { family: raw.family } : {}),
    cost: toCatalogCost(raw.cost),
    limits: {
      context: raw.limit?.context ?? 0,
      output: raw.limit?.output ?? 0,
    },
    capabilities: {
      toolCall: raw.tool_call ?? false,
      reasoning: raw.reasoning ?? false,
      attachment: raw.attachment ?? false,
    },
    modalities: {
      input: raw.modalities?.input ?? ["text"],
      output: raw.modalities?.output ?? ["text"],
    },
    ...(raw.knowledge ? { knowledgeCutoff: raw.knowledge } : {}),
    ...(raw.release_date ? { releaseDate: raw.release_date } : {}),
    ...(isModelDeprecated(raw) ? { deprecated: true } : {}),
  };
}

/** Build a provider's catalog models, sorted by ID and skipping models without pricing. */
export function buildProviderModels(
  providerId: string,
  provider: RawProvider,
): Record<string, CatalogModel> {
  const models: Record<string, CatalogModel> = {};

  // Sort by model ID for stable, review-friendly diffs across sync runs.
  const entries = Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b));
  for (const [modelId, raw] of entries) {
    // Skip models with no cost data (embeddings, etc. without pricing)
    if (!raw.cost?.input && !raw.cost?.output) continue;
    // Skip models the platform deliberately does not surface.
    if (MANUAL_EXCLUSIONS.has(`${providerId}:${modelId}`)) continue;
    const model = toCatalogModel(modelId, raw);
    // Skip a model upstream reports no context window for. Every budget the
    // runtime computes is `context - …`, so a zero window has no arithmetic
    // that yields a usable answer, and the cap below cannot supply one either:
    // `output < context` is unsatisfiable at `context: 0`, so the row could
    // never hold the invariant this build is here to enforce.
    //
    // Note this drops a **priced** row, which the missing-pricing skip above
    // does not — so it is the row-deletion shape #739 is open about, and the
    // reason `gpt-4` is capped rather than excluded a few lines up. It is
    // acceptable only because there is no history to misprice: a model that
    // cannot accept a single input token was never called, and today's only
    // instance emits images and cannot tool-call, so it was never selectable
    // either. A priced model with a zero window that *is* chat-capable would
    // be a different question, and there is none upstream.
    if (model.limits.context <= 0) continue;
    // xAI's own API publishes no per-model max-output cap — neither
    // `/v1/models` nor `/v1/language-models` carries the field, and the endpoint
    // accepts `max_completion_tokens` (what the adapter sends) up to
    // `context_length` (measured). Where models.dev has no vendor figure to
    // report it mirrors the context window, and `output == context` is the
    // sentinel that reaches here. It is unusable as a ceiling:
    // `resolveMaxOutputTokens` returns the catalog `limits.output` when no
    // operator override is set, and `resolveMessageBudget` then computes
    // `context - system - tools - maxOutput - safety` — negative, so the budget
    // resolves to 0 and every turn fails.
    //
    // Capped by rule rather than by model id, and by rule across every provider
    // rather than xAI alone: `output >= context` is a property of the *data*,
    // not of who published it. xAI is simply the provider that produces it
    // systematically. A model models.dev carries a distinct figure for is
    // untouched — the grok-4.20 line reports 30000 against a 1M window and keeps
    // it. `sync-nebius.ts` applies the same platform default for the same reason.
    //
    // The cap is relative to the window, not a flat constant. A flat
    // `DEFAULT_MAX_OUTPUT_TOKENS` is only a cap for models with a window well
    // above it: at 8192 context it *raises* the declared output to 16384, and at
    // 16384 it leaves no headroom at all. Half the window keeps the meaning
    // ("leave at least as much room for input as for output") at every size,
    // and above 32768 it is the flat default anyway — so every currently-capped
    // xAI model keeps exactly the ceiling it has today.
    //
    // This also caps an operator override, since `resolveMaxOutputTokens`
    // clamps `configValue` down to the ceiling. That matches every Nebius model
    // today and is the accepted posture.
    if (model.limits.output >= model.limits.context) {
      model.limits = {
        ...model.limits,
        output: Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(model.limits.context / 2)),
      };
    }
    const limitOverride = MANUAL_LIMIT_OVERRIDES[`${providerId}:${modelId}`];
    if (limitOverride) model.limits = { ...model.limits, ...limitOverride };
    const costOverride = MANUAL_COST_OVERRIDES[`${providerId}:${modelId}`];
    if (costOverride) model.cost = { ...model.cost, ...costOverride };
    models[modelId] = model;
  }

  return models;
}

async function main() {
  console.log(`Fetching ${API_URL}...`);
  const response = await fetch(API_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as Record<string, RawProvider>;

  const catalog: Record<string, { name: string; models: Record<string, CatalogModel> }> = {};
  let totalModels = 0;

  for (const providerId of SUPPORTED_PROVIDERS) {
    const provider = data[providerId];
    if (!provider) {
      console.warn(`  Provider "${providerId}" not found in api.json, skipping`);
      continue;
    }

    const models = buildProviderModels(providerId, provider);
    catalog[providerId] = {
      name: provider.name || providerId,
      models,
    };

    const count = Object.keys(models).length;
    totalModels += count;
    console.log(`  ${providerId}: ${count} models`);
  }

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  const sizeKB = Math.round(Buffer.byteLength(JSON.stringify(catalog)) / 1024);
  console.log(`\nWrote ${OUTPUT_PATH} (${totalModels} models, ${sizeKB}KB)`);
}

// Guard so importing this module (e.g. from tests) doesn't hit the network.
if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
