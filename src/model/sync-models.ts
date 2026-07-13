#!/usr/bin/env bun
/**
 * Sync model catalog from models.dev.
 *
 * Fetches the full API, filters to supported providers (anthropic, openai, google),
 * normalizes the data, and writes catalog-data.json.
 *
 * Run: bun run sync-models
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const API_URL = "https://models.dev/api.json";
const SUPPORTED_PROVIDERS = ["anthropic", "openai", "google"];
const OUTPUT_PATH = join(dirname(new URL(import.meta.url).pathname), "catalog-data.json");

// Models present upstream that the platform deliberately does not surface —
// excluded from the catalog entirely, so they can't be selected in the picker
// or pointed at by a tenant model slot. Format: "<provider>:<modelId>".
const MANUAL_EXCLUSIONS = new Set<string>([
  // Anthropic's premium research tier ($10/$50 per 1M) — not offered on the platform.
  "anthropic:claude-fable-5",
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

// Models the upstream API hasn't flagged yet but we know are scheduled for shutdown.
// Format: "<provider>:<modelId>". Remove an entry once models.dev catches up.
const MANUAL_DEPRECATIONS = new Set<string>([
  // Google shutdown 2026-03-09 (successor: gemini-3.1-pro-preview)
  "google:gemini-3-pro-preview",
  // OpenAI shutdown 2026-07-23
  "openai:gpt-5-chat-latest",
  "openai:gpt-5-codex",
  "openai:gpt-5.1-chat-latest",
  "openai:gpt-5.1-codex",
  "openai:gpt-5.1-codex-max",
  "openai:gpt-5.1-codex-mini",
  "openai:gpt-5.2-codex",
  "openai:o3-deep-research",
  "openai:o4-mini-deep-research",
  // OpenAI shutdown 2026-10-23
  "openai:gpt-4-turbo",
  "openai:gpt-4.1-nano",
  "openai:gpt-4o-2024-05-13",
  "openai:o1-pro",
  "openai:o3-mini",
  "openai:o4-mini",
]);

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

export interface RawProvider {
  id: string;
  name: string;
  models: Record<string, RawModel>;
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

/** Normalize a raw cost block into the catalog cost shape; optional rates are spread only when present. */
function toCatalogCost(cost: RawModel["cost"]): CatalogModel["cost"] {
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    ...(cost?.cache_read != null ? { cacheRead: cost.cache_read } : {}),
    ...(cost?.cache_write != null ? { cacheWrite: cost.cache_write } : {}),
    ...(cost?.reasoning != null ? { reasoning: cost.reasoning } : {}),
  };
}

/** Whether a model is deprecated per upstream status or our manual shutdown list. */
function isModelDeprecated(providerId: string, modelId: string, raw: RawModel): boolean {
  return raw.status === "deprecated" || MANUAL_DEPRECATIONS.has(`${providerId}:${modelId}`);
}

/** Normalize one raw model into a catalog entry; optional fields are spread only when present. */
function toCatalogModel(providerId: string, modelId: string, raw: RawModel): CatalogModel {
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
    ...(isModelDeprecated(providerId, modelId, raw) ? { deprecated: true } : {}),
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
    const model = toCatalogModel(providerId, modelId, raw);
    const limitOverride = MANUAL_LIMIT_OVERRIDES[`${providerId}:${modelId}`];
    if (limitOverride) model.limits = { ...model.limits, ...limitOverride };
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
