import { describe, expect, it } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { AgentEngine } from "../../src/engine/engine.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { EngineConfig, ToolSchema } from "../../src/engine/types.ts";
import { createEchoModel, type EchoModelResponse } from "../helpers/echo-model.ts";
import { recordingModel, type RecordedCall } from "../helpers/recording-model.ts";
import { checkInvariants, deriveShape } from "../helpers/token-shape.ts";

// --- fixed scenario inputs (deterministic; the whole point is reproducibility) ---

// A representative, multi-line system prompt. Held constant so its hash is
// stable across steps and across runs — a real edit here is meant to show up as
// a golden diff.
const SYSTEM_PROMPT = [
  "You are a helpful research assistant operating inside the NimbleBrain runtime.",
  "Use the available tools to gather evidence before answering.",
  "Prefer primary sources. Cite what you used. Stop once the question is answered.",
].join("\n");

const SEARCH_TOOL: ToolSchema = {
  name: "search",
  description: "Search the corpus for a query string.",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};

/**
 * Script an N-step tool loop: N tool-call turns, then a final text turn that
 * ends the run. The query VARIES per step (`q00`, `q01`, …) so the loop
 * supervisor sees forward progress and keeps the tool active — an identical
 * query every turn would (correctly) trip the non-advancing guard and release
 * the tool, which isn't the agentic shape we're fingerprinting. Fixed-width ids
 * and queries keep every step byte-identical in size, so the per-step write
 * delta is exactly flat — the crispest possible signal if the rolling anchor
 * ever regresses. (Steps must stay < 100 for the 2-digit padding to hold.)
 */
function toolLoopResponses(steps: number): EchoModelResponse[] {
  const responses: EchoModelResponse[] = Array.from({ length: steps }, (_, i) => {
    const pad = String(i).padStart(2, "0");
    return {
      text: "Looking into it.",
      toolCalls: [{ toolCallId: `call_${pad}`, toolName: "search", input: `{"q":"q${pad}"}` }],
    };
  });
  responses.push({ text: "All done. Nothing else remains." });
  return responses;
}

async function runToolLoop(model: string, steps: number, maxIterations = 25): Promise<RecordedCall[]> {
  const echo = createEchoModel({
    provider: "anthropic",
    modelId: "scenario",
    responses: toolLoopResponses(steps),
  });
  const { model: recording, calls } = recordingModel(echo);
  const engine = new AgentEngine(
    recording,
    new StaticToolRouter([SEARCH_TOOL], () => ({ content: textContent("ok"), isError: false })),
    new NoopEventSink(),
  );
  const config: EngineConfig = {
    model,
    maxIterations,
    maxInputTokens: 500_000,
    maxOutputTokens: 16_384,
  };
  await engine.run(
    config,
    SYSTEM_PROMPT,
    [{ role: "user", content: [{ type: "text", text: "Find the thing." }] }],
    [SEARCH_TOOL],
  );
  return calls;
}

// --- golden snapshot helper ---------------------------------------------------

async function assertGolden(name: string, shape: unknown): Promise<void> {
  const path = `${import.meta.dir}/__golden__/${name}.json`;
  const serialized = `${JSON.stringify(shape, null, 2)}\n`;
  if (process.env["TOKEN_SHAPE_UPDATE"]) {
    await Bun.write(path, serialized);
    return;
  }
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `Missing golden "${name}". Generate it with: TOKEN_SHAPE_UPDATE=1 bun test test/unit/token-shape.test.ts`,
    );
  }
  const golden = JSON.parse(await file.text());
  // A mismatch means the token shape changed. If intentional, regenerate with
  // TOKEN_SHAPE_UPDATE=1 and review the diff; if not, you just caught a regression.
  expect(shape).toEqual(golden);
}

// --- tests --------------------------------------------------------------------

describe("token-shape regression (Tier 1: deterministic, no provider API)", () => {
  it("Anthropic 10-step tool loop holds every cache-shape invariant", async () => {
    const calls = await runToolLoop("anthropic:claude-sonnet-4-6", 10);
    expect(calls.length).toBe(11); // 10 tool turns + 1 final text turn
    expect(checkInvariants(calls, "anthropic")).toEqual([]);
  });

  it("Anthropic 10-step shape matches the committed golden", async () => {
    const calls = await runToolLoop("anthropic:claude-sonnet-4-6", 10);
    await assertGolden("anthropic-10step", deriveShape(calls));
  });

  it("post-anchor write delta stays flat across the run (no cache-write thrash)", async () => {
    const calls = await runToolLoop("anthropic:claude-sonnet-4-6", 12);
    const deltas = deriveShape(calls)
      .map((s) => s.deltaTokensAfterAnchor)
      .filter((d): d is number => d !== null);
    expect(deltas.length).toBeGreaterThanOrEqual(10);
    // Uniform steps ⇒ every per-turn write delta is identical. A growing delta
    // would mean the prefix is re-written each turn instead of appended.
    expect(new Set(deltas).size).toBe(1);
  });

  it("final-step hint rides the tail, never mutating the cached system block", async () => {
    // Force the loop to its iteration cap so the engine injects the final-step
    // reminder. The reminder must land in the tail (5m region), leaving the 1h
    // system block byte-identical — otherwise the final call of every run busts
    // the whole cached prefix.
    const calls = await runToolLoop("anthropic:claude-sonnet-4-6", 10, 4);
    const shapes = deriveShape(calls);
    const sys0 = shapes[0]!.system.hash;
    expect(shapes.every((s) => s.system.hash === sys0)).toBe(true);

    const lastPrompt = calls[calls.length - 1]!.prompt;
    const systemHead = lastPrompt[0]!;
    const systemText =
      systemHead.role === "system" && typeof systemHead.content === "string"
        ? systemHead.content
        : JSON.stringify(systemHead.content);
    expect(systemText).not.toContain("final step");
    const tail = lastPrompt[lastPrompt.length - 1] as LanguageModelV3Message;
    expect(JSON.stringify(tail)).toContain("final step");
  });

  it("OpenAI passthrough: no inline cache markers, prefix still append-only", async () => {
    const calls = await runToolLoop("openai:gpt-4o", 10);
    expect(checkInvariants(calls, "passthrough")).toEqual([]);
  });
});
