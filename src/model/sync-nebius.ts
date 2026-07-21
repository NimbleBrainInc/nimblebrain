#!/usr/bin/env bun
/**
 * Sync the Nebius Token Factory catalog from the account's /v1/models API.
 *
 * models.dev (the `sync-models` source) doesn't list Nebius, so the drift-prone
 * numbers — pricing, context window, and tool/reasoning capability — are pulled
 * from the authoritative account endpoint (`/v1/models?verbose=true`) rather
 * than hand-typed. The *selection* (which models to surface + their stable
 * display names) is curated below; the volatile metadata is synced.
 *
 * Run: NEBIUS_API_KEY=... bun run sync-nebius
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const API_URL = "https://api.tokenfactory.nebius.com/v1/models?verbose=true";
const OUTPUT_PATH = join(dirname(new URL(import.meta.url).pathname), "catalog-nebius.json");

// Nebius publishes no per-model max-output cap; the only hard limit is
// `max_tokens <= context_length`. Cap output at the platform default, which is
// safely under the smallest served context window.
const DEFAULT_OUTPUT_LIMIT = 16384;

/** Curated selection: which Nebius models we surface, with stable display metadata. */
interface CuratedModel {
  id: string;
  name: string;
  family: string;
}

// Add/remove ids here, then re-run `bun run sync-nebius` to refresh the numbers.
// The account serves ~26 models (many niche); this is the flagship set.
const CURATED: CuratedModel[] = [
  { id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro", family: "deepseek" },
  { id: "meta-llama/Llama-3.3-70B-Instruct", name: "Llama 3.3 70B Instruct", family: "llama" },
  { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", family: "gpt-oss" },
  { id: "Qwen/Qwen3-235B-A22B-Instruct-2507", name: "Qwen3 235B A22B Instruct", family: "qwen" },
  { id: "Qwen/Qwen3-32B", name: "Qwen3 32B", family: "qwen" },
  { id: "Qwen/Qwen3-Next-80B-A3B-Thinking", name: "Qwen3 Next 80B A3B Thinking", family: "qwen" },
];

export interface RawNebiusModel {
  id: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_features?: string[];
}

interface CatalogModel {
  id: string;
  name: string;
  family: string;
  cost: { input: number; output: number };
  limits: { context: number; output: number };
  capabilities: { toolCall: boolean; reasoning: boolean; attachment: boolean };
  modalities: { input: string[]; output: string[] };
}

/** Nebius prices are per-token strings (e.g. "0.00000015"); convert to USD per 1M and drop float noise. */
function perMillion(perToken: string | undefined): number {
  return Math.round(Number(perToken ?? 0) * 1_000_000 * 10_000) / 10_000;
}

/**
 * Map the raw `/v1/models` entries to catalog entries for the curated set.
 * Pure and network-free so it can be unit-tested with a fixture.
 */
export function buildNebiusCatalog(
  raw: RawNebiusModel[],
  curated: CuratedModel[] = CURATED,
): Record<string, CatalogModel> {
  const byId = new Map(raw.map((m) => [m.id, m]));
  const models: Record<string, CatalogModel> = {};
  for (const { id, name, family } of curated) {
    const m = byId.get(id);
    if (!m) {
      console.warn(`  "${id}" not present in /v1/models — skipping`);
      continue;
    }
    const feats = new Set(m.supported_features ?? []);
    const context = m.context_length ?? 0;
    models[id] = {
      id,
      name,
      family,
      cost: { input: perMillion(m.pricing?.prompt), output: perMillion(m.pricing?.completion) },
      limits: {
        context,
        // Never exceed the model's own context window (a larger max_tokens 400s).
        output: context > 0 ? Math.min(DEFAULT_OUTPUT_LIMIT, context) : DEFAULT_OUTPUT_LIMIT,
      },
      capabilities: {
        toolCall: feats.has("tools"),
        reasoning: feats.has("reasoning"),
        attachment: false,
      },
      modalities: { input: ["text"], output: ["text"] },
    };
  }
  return models;
}

async function main() {
  const key = process.env.NEBIUS_API_KEY;
  if (!key) {
    console.error("Set NEBIUS_API_KEY to sync the Nebius catalog.");
    process.exit(1);
  }
  console.log(`Fetching ${API_URL}...`);
  const res = await fetch(API_URL, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { data: RawNebiusModel[] };
  const models = buildNebiusCatalog(data.data);
  const catalog = { nebius: { name: "Nebius Token Factory", models } };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Wrote ${OUTPUT_PATH} (${Object.keys(models).length} models)`);
}

// Guard so importing this module (e.g. from tests) doesn't hit the network.
if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
