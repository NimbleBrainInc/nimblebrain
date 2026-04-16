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

interface RawModel {
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

interface RawProvider {
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

    const models: Record<string, CatalogModel> = {};

    for (const [modelId, raw] of Object.entries(provider.models)) {
      // Skip models with no cost data (embeddings, etc. without pricing)
      if (!raw.cost?.input && !raw.cost?.output) continue;

      models[modelId] = {
        id: modelId,
        name: raw.name || modelId,
        ...(raw.family ? { family: raw.family } : {}),
        cost: {
          input: raw.cost?.input ?? 0,
          output: raw.cost?.output ?? 0,
          ...(raw.cost?.cache_read != null ? { cacheRead: raw.cost.cache_read } : {}),
          ...(raw.cost?.cache_write != null ? { cacheWrite: raw.cost.cache_write } : {}),
          ...(raw.cost?.reasoning != null ? { reasoning: raw.cost.reasoning } : {}),
        },
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
        ...(raw.status === "deprecated" ? { deprecated: true } : {}),
      };
    }

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

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
