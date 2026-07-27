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
 * **Every candidate is probed before it ships.** Being listed in `/v1/models`
 * is not evidence that a model serves: `deepseek-ai/DeepSeek-V4-Pro` was listed,
 * priced, and advertised `tools` while every completion hung with no response
 * and no status — which stalls an agent run indefinitely rather than failing.
 * `supported_features` is a claim too, so the probe sends a real tool and
 * requires a real `tool_calls` back. A model that cannot do that is useless on
 * an agent platform, so it does not belong in the catalog.
 *
 * Run: NEBIUS_API_KEY=... bun run sync-nebius
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const API_URL = "https://api.tokenfactory.nebius.com/v1/models?verbose=true";
const COMPLETIONS_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";

/**
 * Per-probe budget. Healthy models on this account answer a 16-token tool call
 * in 0.5–5s; the slowest measured was 5.4s. 30s is far outside that band, so a
 * timeout means "not serving", not "slow".
 */
const PROBE_TIMEOUT_MS = 30_000;
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

// Add/remove ids here, then re-run `bun run sync-nebius`. The account serves
// ~25 models (embeddings, vision, and several niche fine-tunes among them); this
// is the flagship set, chosen so each entry covers a role the others don't
// rather than stacking a tier. A curated id that fails the probe is dropped from
// the output with a warning — the probe is what keeps this list honest, so a
// stale entry degrades to a build-time warning instead of a hung agent.
const CURATED: CuratedModel[] = [
  { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", family: "gpt-oss" },
  { id: "Qwen/Qwen3-235B-A22B-Instruct-2507", name: "Qwen3 235B A22B Instruct", family: "qwen" },
  { id: "nvidia/Cosmos3-Super-Reasoner", name: "Cosmos3 Super Reasoner", family: "nemotron" },
  { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6", family: "kimi" },
  { id: "zai-org/GLM-5.1", name: "GLM 5.1", family: "glm" },
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

/** One-shot tool schema for the probe — small, unambiguous, trivially callable. */
const PROBE_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
} as const;

export type ProbeOutcome =
  | { ok: true }
  | { ok: false; reason: "timeout" | "http_error" | "no_tool_calls"; detail?: string };

/**
 * Ask a model to make one real tool call.
 *
 * The assertion is `tool_calls` in the response, not a 200 — a model that
 * answers in prose when handed an unambiguous tool cannot drive this platform,
 * and `supported_features: ["tools"]` has already been observed to overstate.
 * Network and abort failures are outcomes rather than throws so one bad model
 * cannot fail the whole sync.
 */
export async function probeModel(
  id: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(COMPLETIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: id,
        max_tokens: 64,
        tools: [PROBE_TOOL],
        messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, reason: "http_error", detail: `${res.status} ${res.statusText}` };
    }
    const body = (await res.json()) as {
      choices?: { message?: { tool_calls?: unknown[] } }[];
    };
    const calls = body.choices?.[0]?.message?.tool_calls;
    return calls && calls.length > 0 ? { ok: true } : { ok: false, reason: "no_tool_calls" };
  } catch (err) {
    // An abort is the timeout firing; anything else is a transport failure. Both
    // mean the same thing for cataloguing purposes: it did not serve.
    const reason = (err as Error)?.name === "AbortError" ? "timeout" : "http_error";
    return { ok: false, reason, detail: (err as Error)?.message };
  } finally {
    clearTimeout(timer);
  }
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
  const listed = buildNebiusCatalog(data.data);

  // Probe before writing. Listing is not serving — see the module header.
  console.log(`Probing ${Object.keys(listed).length} model(s) for a live tool call...`);
  const models: typeof listed = {};
  const rejected: string[] = [];
  for (const [id, entry] of Object.entries(listed)) {
    const started = performance.now();
    const outcome = await probeModel(id, key);
    const ms = Math.round(performance.now() - started);
    if (outcome.ok) {
      console.log(`  ✓ ${id} (${ms}ms)`);
      models[id] = entry;
    } else {
      const detail = outcome.detail ? ` — ${outcome.detail}` : "";
      console.warn(`  ✗ ${id}: ${outcome.reason}${detail} (${ms}ms) — excluded`);
      rejected.push(id);
    }
  }

  if (Object.keys(models).length === 0) {
    // Writing an empty catalog would silently strip every Nebius model from the
    // picker; a total failure is far more likely to be a bad key or an outage.
    throw new Error("every curated model failed its probe — refusing to write an empty catalog");
  }

  const catalog = { nebius: { name: "Nebius Token Factory", models } };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Wrote ${OUTPUT_PATH} (${Object.keys(models).length} models)`);
  if (rejected.length > 0) {
    console.warn(
      `${rejected.length} curated id(s) excluded: ${rejected.join(", ")}. ` +
        `Remove them from CURATED, or leave them if the outage is expected to lift.`,
    );
  }
}

// Guard so importing this module (e.g. from tests) doesn't hit the network.
if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
