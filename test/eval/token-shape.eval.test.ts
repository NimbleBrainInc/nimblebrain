/**
 * Token-shape eval (Tier 3) — realized cross-provider cache behavior.
 *
 * The unit-tier `test/unit/token-shape.test.ts` proves the REQUEST shape is
 * correct with a scripted fake model and zero API calls (fast, every PR). This
 * eval is the complement: drive the SAME agentic scenario against the REAL
 * Anthropic / OpenAI / Google APIs and check two things that only a real
 * provider can tell you:
 *
 *   1. Structural invariants still hold under a real model's (non-uniform)
 *      tool-calling pattern — we wrap the live model with `recordingModel` and
 *      run the same `checkInvariants` the unit tier uses.
 *   2. The provider actually HONORS the cache — read realized `cacheRead` /
 *      `cacheWrite` from the run's usage and assert tolerance-banded health,
 *      then log the realized cache-hit rate so a weekly cron can track drift.
 *
 * Run infrequently (weekly cron / pre-release), not per-PR — it costs real
 * tokens and is subject to provider nondeterminism. Skips gracefully per
 * provider when the key is absent.
 *
 * Requires env vars (skip if missing):
 *   ANTHROPIC_API_KEY
 *   OPENAI_API_KEY
 *   GOOGLE_GENERATIVE_AI_API_KEY
 *
 * Run: bun run eval
 */
import { describe, expect, it } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { AgentEngine } from "../../src/engine/engine.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { EngineConfig, EngineResult, ToolSchema } from "../../src/engine/types.ts";
import { buildModelResolver } from "../../src/model/registry.ts";
import { recordingModel, type RecordedCall } from "../helpers/recording-model.ts";
import { checkInvariants, deriveShape } from "../helpers/token-shape.ts";

interface ProviderSpec {
  name: "anthropic" | "openai" | "google";
  envVar: string;
  modelString: string;
  /** Anthropic places explicit breakpoints; the others auto-cache (passthrough). */
  cacheMode: "anthropic" | "passthrough";
}

const PROVIDERS: ProviderSpec[] = [
  {
    name: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    modelString: "anthropic:claude-haiku-4-5-20251001",
    cacheMode: "anthropic",
  },
  {
    name: "openai",
    envVar: "OPENAI_API_KEY",
    modelString: "openai:gpt-4o-mini",
    cacheMode: "passthrough",
  },
  {
    name: "google",
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    modelString: "google:gemini-2.0-flash",
    cacheMode: "passthrough",
  },
];

// A deliberately large, STABLE system block. Prompt caching only engages above a
// provider-specific floor (Anthropic ~1024 tokens; OpenAI auto-caches long
// prefixes), so a realistic eval needs a prefix big enough to be cacheable. The
// content is irrelevant; the size and stability are the point.
const STABLE_PREAMBLE = Array.from(
  { length: 80 },
  (_, i) =>
    `Operating principle ${i + 1}: gather evidence with the provided tool before answering, ` +
    "prefer primary sources, cite what you used, and never fabricate facts you did not retrieve.",
).join("\n");

const SYSTEM_PROMPT = `You are a meticulous research assistant.\n\n${STABLE_PREAMBLE}\n\nWork one tool call at a time.`;

const FACT_TOOL: ToolSchema = {
  name: "get_fact",
  description: "Return a short factual sentence about the given topic.",
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string", description: "The topic to look up." } },
    required: ["topic"],
  },
};

const TOPICS = ["alpha", "beta", "gamma", "delta", "epsilon"];

const USER_TASK =
  `Look up a fact for each of these topics, exactly one get_fact call at a time, ` +
  `in order: ${TOPICS.join(", ")}. After you have all five, give a one-line summary.`;

interface ScenarioResult {
  calls: RecordedCall[];
  usage: EngineResult["usage"];
  iterations: number;
}

function resolveModel(spec: ProviderSpec): LanguageModelV3 {
  const apiKey = process.env[spec.envVar]!;
  const resolver = buildModelResolver({ providers: { [spec.name]: { apiKey } } });
  return resolver(spec.modelString);
}

async function runRealScenario(spec: ProviderSpec): Promise<ScenarioResult> {
  const { model, calls } = recordingModel(resolveModel(spec));
  const engine = new AgentEngine(
    model,
    new StaticToolRouter([FACT_TOOL], (call) => ({
      content: textContent(`${String(call.input["topic"])} is a letter of the Greek alphabet.`),
      isError: false,
    })),
    new NoopEventSink(),
  );
  const config: EngineConfig = {
    model: spec.modelString,
    maxIterations: 12,
    maxInputTokens: 500_000,
    maxOutputTokens: 2_048,
  };
  const result = await engine.run(
    config,
    SYSTEM_PROMPT,
    [{ role: "user", content: [{ type: "text", text: USER_TASK }] }],
    [FACT_TOOL],
  );
  return { calls, usage: result.usage, iterations: result.iterations };
}

/** Realized cache-hit rate, mirroring the production admin-summary definition. */
function cacheHitRate(usage: EngineResult["usage"]): number {
  const read = usage.cacheReadTokens ?? 0;
  return usage.inputTokens > 0 ? read / usage.inputTokens : 0;
}

describe("token-shape eval — realized cross-provider cache", () => {
  for (const spec of PROVIDERS) {
    const apiKey = process.env[spec.envVar];

    describe(spec.name, () => {
      it.skipIf(!apiKey)(
        "holds shape invariants and reports realized cache usage",
        async () => {
          const { calls, usage, iterations } = await runRealScenario(spec);

          // The run must have actually looped (multiple model calls) for the
          // cache question to be meaningful.
          expect(calls.length).toBeGreaterThanOrEqual(2);

          // (1) Structural invariants hold even under the real model's pattern.
          // Tool-set churn (a real model may stop calling the tool) makes
          // tools-stable legitimately noisy, so we assert on the cache-correctness
          // invariants that must hold regardless: system stability, append-only
          // prefix, and — for Anthropic — anchor chaining.
          const violations = checkInvariants(calls, spec.cacheMode).filter(
            (v) => v.invariant !== "tools-stable" && v.invariant !== "anti-thrash-bounded",
          );
          expect(violations).toEqual([]);

          // (2) Realized cache health, tolerance-banded. Thresholds are starter
          // values to tune against the tracked time series — adjust as the
          // baseline settles.
          const read = usage.cacheReadTokens ?? 0;
          const write = usage.cacheWriteTokens ?? 0;
          const hitRate = cacheHitRate(usage);

          // Emit a single machine-greppable metrics line so a weekly cron can
          // append it to a time series and watch for drift.
          console.log(
            `[token-shape-eval] provider=${spec.name} model=${spec.modelString} ` +
              `iterations=${iterations} input=${usage.inputTokens} output=${usage.outputTokens} ` +
              `cacheRead=${read} cacheWrite=${write} hitRate=${hitRate.toFixed(3)} ` +
              `writeReadRatio=${read > 0 ? (write / read).toFixed(2) : "n/a"}`,
          );

          if (spec.cacheMode === "anthropic") {
            // Explicit breakpoints + a >1k-token stable prefix across a multi-
            // iteration run: the cache MUST be read back at least once, and
            // writes must not dominate reads (the thrash signature).
            expect(read).toBeGreaterThan(0);
            if (read > 0) expect(write / read).toBeLessThan(2);
          } else {
            // Auto-caching providers may or may not engage within a short test
            // window; don't hard-gate on it. Assert the usage pipeline is
            // populated and log the realized number for the time series.
            expect(usage.inputTokens).toBeGreaterThan(0);
          }
        },
        60_000,
      );

      if (!apiKey) {
        it.skip(`skipped: ${spec.envVar} not set`, () => {});
      }
    });
  }
});

// Keep the shape derivation reachable for ad-hoc inspection without an API key
// (e.g. `bun -e` against a recorded run): re-export the harness used above.
export { deriveShape };
