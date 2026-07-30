#!/usr/bin/env bun
/**
 * Sync the Nebius Token Factory catalog from the account's /v1/models API.
 *
 * The drift-prone numbers — pricing, context window, and tool/reasoning
 * capability — are pulled from the authoritative account endpoint
 * (`/v1/models?verbose=true`) rather than hand-typed. The *selection* (which
 * models to surface + their stable display names) is curated below; the
 * volatile metadata is synced.
 *
 * models.dev (the `sync-models` source) does carry a `nebius` entry, and it is
 * deliberately not used. A gateway's lineup is account- and tier-specific, and
 * that entry is community-maintained: it omits ids this account serves, lists
 * ids it does not, and carries 8K-context `-fast` variants that
 * `MIN_USABLE_CONTEXT` below exists to reject. For a provider whose catalog
 * varies per key, the key's own endpoint is the only source that can be right.
 *
 * **Every candidate is probed before it ships.** Being listed in `/v1/models`
 * is not evidence that a model serves: `deepseek-ai/DeepSeek-V4-Pro` was listed,
 * priced, and advertised `tools` while every completion hung with no response
 * and no status. The stream watchdog does bound that (90s to first content,
 * then `withRetry`'s 4 attempts), so it fails rather than hanging forever — but
 * it costs ~6 minutes per call to arrive at "this model does not work", which is
 * indistinguishable from a hang to whoever is waiting. The watchdog is the
 * backstop; keeping the model out of the catalog is the fix.
 * `supported_features` is a claim too, so the probe sends a real tool and
 * requires a real `tool_calls` back. A model that cannot do that is useless on
 * an agent platform, so it does not belong in the catalog.
 *
 * Run: NEBIUS_API_KEY=... bun run sync-nebius
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_THINKING_EFFORT } from "../engine/types";

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
export const DEFAULT_OUTPUT_LIMIT = 16384;

/**
 * Smallest context window worth cataloguing. Chosen conservative, not derived —
 * the arithmetic below sets a lower bound, and this sits well above it.
 *
 * `resolveMessageBudget` computes `modelCtx - system - tools - maxOutput -
 * safety` (`DEFAULT_OUTPUT_LIMIT` 16K + `DEFAULT_BUDGET_SAFETY_MARGIN_TOKENS`
 * 8K, plus a few K of system and tools). Two thresholds fall out of it:
 *
 *   - **~30K** — below this the headroom is <= 0, the budget resolves to 0, and
 *     every turn fails. This is the hard floor.
 *   - **~50K** — below this an ordinary ~22K-token run does not fit in the
 *     headroom, so history is trimmed hard on every turn. It degrades; it does
 *     not fail.
 *
 * 64K clears both with margin. A model between 50K and 64K would technically
 * serve, and is excluded anyway — the cost of that is a warned exclusion an
 * operator can override by pinning the id as free text, which is the cheaper
 * mistake to make in a file whose thesis is fail-closed.
 *
 * This is the one failure class the probe structurally cannot see: a model with
 * an 8K window answers the probe's toy prompt perfectly. `Kimi-K2.7-Code` and
 * `Kimi-K3` are both served at 8000 on this account.
 */
export const MIN_USABLE_CONTEXT = 64_000;

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
//
// One probe, no retry, fail-closed: the output therefore depends on the link at
// sync time. Ids on this account have answered in 1.3s and timed out at 30s
// within the same hour, so a transient blip silently drops a healthy model. If a
// sync shrinks the catalog, re-run before trusting the diff — the stderr warning
// names every exclusion, and a diff that removes a model is a claim to check,
// not a result. Retrying here would trade this for the opposite failure
// (a flaky model looking healthy), which is the one that ships a hang.
const CURATED: CuratedModel[] = [
  { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", family: "gpt-oss" },
  { id: "Qwen/Qwen3-235B-A22B-Instruct-2507", name: "Qwen3 235B A22B Instruct", family: "qwen" },
  { id: "Qwen/Qwen3-Next-80B-A3B-Thinking", name: "Qwen3 Next 80B A3B Thinking", family: "qwen" },
  { id: "nvidia/Cosmos3-Super-Reasoner", name: "Cosmos3 Super Reasoner", family: "nvidia" },
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

/**
 * Output budget for a probe.
 *
 * Reasoning tokens count against `max_tokens` on an OpenAI-compatible endpoint,
 * so a thinking model spends its trace before it can emit a call. At 64 this
 * probe truncated `Qwen3-Next-80B-A3B-Thinking` and `MiniMax-M2.5` mid-trace and
 * reported both as refusing to call tools; both call reliably with room. A
 * budget that small tests the budget, not the model.
 */
const PROBE_MAX_TOKENS = 1024;

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
  | {
      ok: false;
      /**
       * `truncated` is deliberately NOT folded into `no_tool_calls`. They look
       * identical in the response — no call, no error — and conflating them is
       * how a working model gets dropped on a diagnosis nobody can check. Both
       * still exclude (fail-closed), but only one means "this model is broken".
       */
      reason: "timeout" | "http_error" | "transport_error" | "no_tool_calls" | "truncated";
      detail?: string;
    };

/**
 * Ask a model to make one real tool call.
 *
 * `tool_choice` is left at the default so this measures what the runtime will
 * actually see. Forcing `"required"` would test capability rather than
 * propensity — a stricter question, but not the one that predicts whether the
 * model drives an agent loop.
 *
 * The assertion is `tool_calls` in the response, not a 200 — a model that
 * answers in prose when handed an unambiguous tool cannot drive this platform,
 * and `supported_features: ["tools"]` has already been observed to overstate.
 * Network and abort failures are outcomes rather than throws so one bad model
 * cannot fail the whole sync.
 *
 * `reasoning` aligns the probe's PROVIDER OPTIONS with the runtime's — not the
 * whole request. For a model this catalog flags reasoning-capable, an
 * unconfigured install resolves to `{mode: "effort"}` (`resolveThinking` →
 * `DEFAULT_THINKING_EFFORT`) and `buildNebiusThinkingOptions` puts
 * `reasoning_effort` on EVERY call. Probing without it would verify options no
 * run uses, which
 * is the same mistake as trusting `supported_features`: the tools half proven
 * and the reasoning half assumed. A model that rejects the parameter it claims
 * to support does not serve, and is excluded like any other failure.
 *
 * Two axes stay unverified, deliberately. This posts a BUFFERED completion while
 * the runtime calls `doStream`, so a model that answers a whole response but
 * stalls mid-SSE still passes — the observed failure was a completion that never
 * returned at all, which this does catch, and the stream watchdog covers the
 * rest at runtime. And accepting `reasoning_effort` is not evidence a model
 * reasons: the tools half is proven end-to-end, the reasoning half only
 * negatively (it does not 400). Asserting on `reasoning_content` would vary by
 * model and trade a real false-exclusion risk for a claim nothing depends on.
 */
export async function probeModel(
  id: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  reasoning = false,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(COMPLETIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: id,
        max_tokens: PROBE_MAX_TOKENS,
        tools: [PROBE_TOOL],
        messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
        // Only when claimed, matching the runtime's own capability gate: a model
        // the catalog marks non-reasoning is never sent this, so probing it with
        // the parameter would test a shape that model never receives.
        //
        // The default tier reaches the wire unchanged — `toOpenAIEffort` clamps
        // only `xhigh`/`max` — so this is the literal value an unconfigured
        // install sends, not an approximation of it.
        ...(reasoning ? { reasoning_effort: DEFAULT_THINKING_EFFORT } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, reason: "http_error", detail: `${res.status} ${res.statusText}` };
    }
    const body = (await res.json()) as {
      choices?: { finish_reason?: string; message?: { tool_calls?: unknown[] } }[];
    };
    const choice = body.choices?.[0];
    const calls = choice?.message?.tool_calls;
    if (calls && calls.length > 0) return { ok: true };
    if (choice?.finish_reason === "length") {
      return {
        ok: false,
        reason: "truncated",
        detail: `hit the ${PROBE_MAX_TOKENS}-token probe budget before calling a tool`,
      };
    }
    return { ok: false, reason: "no_tool_calls" };
  } catch (err) {
    // An abort is the timeout firing; anything else is a transport failure. Both
    // mean the same thing for cataloguing purposes: it did not serve.
    // A server that answered 404/429 said something; a socket that died said
    // nothing. Same exclusion, different diagnosis for whoever reads the log.
    const reason = (err as Error)?.name === "AbortError" ? "timeout" : "transport_error";
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
    // No `context > 0` escape hatch: an absent `context_length` is MORE dangerous
    // than a small one. It would catalogue as `context: 0`, and
    // `resolveMessageBudget` treats only `null` as a catalog miss — 0 is a
    // number, so the fallback never fires and every turn resolves to budget 0.
    // Unknown means excluded here, like everything else in this file.
    if (context < MIN_USABLE_CONTEXT) {
      const window = context > 0 ? `only ${context} context` : "no declared context_length";
      console.warn(
        `  "${id}" has ${window} (need >= ${MIN_USABLE_CONTEXT}) — skipping; ` +
          `it cannot hold one turn on this platform`,
      );
      continue;
    }
    models[id] = {
      id,
      name,
      family,
      cost: { input: perMillion(m.pricing?.prompt), output: perMillion(m.pricing?.completion) },
      // The gate above guarantees `context >= MIN_USABLE_CONTEXT`, which is well
      // clear of the output default, so no clamp is needed to keep `max_tokens`
      // inside the window.
      limits: { context, output: DEFAULT_OUTPUT_LIMIT },
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
    const outcome = await probeModel(
      id,
      key,
      fetch,
      PROBE_TIMEOUT_MS,
      entry.capabilities.reasoning,
    );
    const ms = Math.round(performance.now() - started);
    if (outcome.ok) {
      console.log(`  ✓ ${id} (${ms}ms)`);
      // The probe just got a real `tool_calls` array back from this id, which
      // outranks `supported_features` — the whole point of running it. Writing
      // `feats.has("tools")` here instead would keep the untrusted source as the
      // output of record for the one fact the probe proves, and could only ever
      // be wrong in one direction: a model that calls tools while omitting
      // "tools" from its listing would ship flagged false, having just passed
      // the check that disproves the flag. Every id reaching this line passed.
      models[id] = { ...entry, capabilities: { ...entry.capabilities, toolCall: true } };
    } else {
      const detail = outcome.detail ? ` — ${outcome.detail}` : "";
      console.warn(`  ✗ ${id}: ${outcome.reason}${detail} (${ms}ms) — excluded`);
      rejected.push(id);
    }
  }

  if (Object.keys(models).length === 0) {
    // Writing an empty catalog would silently strip every Nebius model from the
    // picker; a total failure is far more likely to be a bad key or an outage.
    //
    // Name which stage emptied it. "Failed its probe" is wrong when nothing was
    // probed — if every id was dropped for not being listed, the account or the
    // ids changed, which is a different fix from a dead endpoint.
    const cause =
      Object.keys(listed).length === 0
        ? "no curated id survived listing and the context gate — the probe never ran"
        : "every probed model failed";
    throw new Error(`${cause} — refusing to write an empty catalog`);
  }

  const catalog = { nebius: { name: "Nebius Token Factory", models } };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Wrote ${OUTPUT_PATH} (${Object.keys(models).length} models)`);
  // Count every way an id can be dropped, not just the probe. Ids the listing
  // omits and ids the context gate rejects each warn as they happen inside
  // `buildNebiusCatalog`, but a summary that tallies only probe failures reads
  // as "everything else made it" — which is how a shrunken catalog gets
  // committed without anyone re-reading the scrollback.
  const preProbeDrops = CURATED.filter(({ id }) => !(id in listed)).map(({ id }) => id);
  const dropped = [...preProbeDrops, ...rejected];
  if (dropped.length > 0) {
    const detail = preProbeDrops.length
      ? ` (${preProbeDrops.length} before the probe: not listed, or under the context floor)`
      : "";
    console.warn(
      `${dropped.length} curated id(s) excluded${detail}: ${dropped.join(", ")}. ` +
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
