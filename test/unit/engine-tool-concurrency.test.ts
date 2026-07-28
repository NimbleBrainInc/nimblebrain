import type { LanguageModelV3Message, LanguageModelV3ToolCall } from "@ai-sdk/provider";
import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import {
  AgentEngine,
  resolveMaxParallelToolCallsPerSource,
} from "../../src/engine/engine.ts";
import type { EngineConfig, ToolCall, ToolResult, ToolSchema } from "../../src/engine/types.ts";
import { createMockModel } from "../helpers/mock-model.ts";

const config: EngineConfig = {
  model: "test-model",
  maxIterations: 10,
  maxInputTokens: 500_000,
  maxOutputTokens: 16_384,
};

const USER: LanguageModelV3Message[] = [
  { role: "user", content: [{ type: "text", text: "go" }] },
];

function schema(name: string): ToolSchema {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

function toolCall(id: string, toolName: string): LanguageModelV3ToolCall {
  return { type: "tool-call", toolCallId: id, toolName, input: "{}" };
}

/**
 * A router that records peak simultaneous in-flight calls per source, so a test
 * can assert the bound rather than infer it from timing.
 */
function trackingRouter(tools: ToolSchema[]) {
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  /** Source of each call, in dispatch order — see the first-wave assertion. */
  const order: string[] = [];

  const execute = async (call: ToolCall): Promise<ToolResult> => {
    const sep = call.name.indexOf("__");
    const source = sep === -1 ? call.name : call.name.slice(0, sep);
    order.push(source);
    const now = (inFlight.get(source) ?? 0) + 1;
    inFlight.set(source, now);
    peak.set(source, Math.max(peak.get(source) ?? 0, now));
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight.set(source, (inFlight.get(source) ?? 1) - 1);
    return { content: textContent(`ok:${call.name}`), isError: false };
  };

  const router = new StaticToolRouter(tools, execute);
  return { router, peak, order };
}

/** One assistant turn emitting `calls`, then a plain text answer. */
function twoTurnModel(calls: LanguageModelV3ToolCall[]) {
  let turn = 0;
  return createMockModel(async () => {
    turn++;
    if (turn === 1) return { content: calls };
    return { content: [{ type: "text" as const, text: "done" }] };
  });
}

describe("engine tool-call fan-out is bounded per source", () => {
  it("caps simultaneous calls to one source without serializing them", async () => {
    // The production shape: the model emits a large batch of writes against a
    // single connector. Unbounded, all 25 hit that one server at once — and
    // because the source is shared, one rejection that trips transport recovery
    // takes the in-flight siblings down with it.
    const tools = [schema("people__log_interaction")];
    const { router, peak } = trackingRouter(tools);
    const calls = Array.from({ length: 25 }, (_, i) =>
      toolCall(`c${i}`, "people__log_interaction"),
    );

    const engine = new AgentEngine(twoTurnModel(calls), router, new NoopEventSink());
    await engine.run(config, "system", USER, tools);

    const cap = resolveMaxParallelToolCallsPerSource({});
    const observed = peak.get("people") ?? 0;
    expect(observed).toBeLessThanOrEqual(cap);
    // Still parallel — the bound is a cap, not a queue of one.
    expect(observed).toBeGreaterThan(1);
  });

  it("does not let one source's depth throttle a different source", async () => {
    // Capacity belongs to the server being called, so sources are budgeted
    // independently: a batch touching three connectors must not serialize the
    // small groups behind the large one.
    const tools = [schema("people__write"), schema("memory__note"), schema("web__fetch")];
    const { router, peak, order } = trackingRouter(tools);
    const calls = [
      ...Array.from({ length: 20 }, (_, i) => toolCall(`p${i}`, "people__write")),
      ...Array.from({ length: 3 }, (_, i) => toolCall(`m${i}`, "memory__note")),
      ...Array.from({ length: 2 }, (_, i) => toolCall(`w${i}`, "web__fetch")),
    ];

    const engine = new AgentEngine(twoTurnModel(calls), router, new NoopEventSink());
    await engine.run(config, "system", USER, tools);

    const cap = resolveMaxParallelToolCallsPerSource({});
    expect(peak.get("people") ?? 0).toBeLessThanOrEqual(cap);

    // THE per-source assertion. Peak-within-a-group cannot see this: under a
    // single global cap the small groups are simply delayed behind the 20-call
    // one, and their peaks still reach 3 and 2 once slots free. Dispatch ORDER
    // can see it — and unlike wall-clock it needs no timing assumptions.
    //
    // The first wave is every call dispatched before anything completes: `cap`
    // from `people` plus ALL of `memory` and `web`, because their groups are
    // smaller than the cap and hold their own budgets. A global bound puts `cap`
    // people calls there and nothing else.
    const firstWave = order.slice(0, cap + 3 + 2);
    expect(firstWave.filter((s) => s === "memory")).toHaveLength(3);
    expect(firstWave.filter((s) => s === "web")).toHaveLength(2);
    expect(firstWave.filter((s) => s === "people")).toHaveLength(cap);

    // Kept as a secondary check: the small groups do run at full width.
    expect(peak.get("memory")).toBe(3);
    expect(peak.get("web")).toBe(2);
  });

  it("returns results in call order regardless of completion order", async () => {
    // `buildToolResults` pairs results to calls positionally, so the bound must
    // preserve index even though workers finish out of order.
    const execute = async (call: ToolCall): Promise<ToolResult> => {
      const n = Number(call.name.slice(-1));
      await new Promise((resolve) => setTimeout(resolve, (5 - n) * 4));
      return { content: textContent("ok"), isError: false };
    };
    const numbered = Array.from({ length: 5 }, (_, i) => schema(`people__write${i}`));
    const router = new StaticToolRouter(numbered, execute);
    const calls = numbered.map((s, i) => toolCall(`c${i}`, s.name));

    const engine = new AgentEngine(twoTurnModel(calls), router, new NoopEventSink());
    const result = await engine.run(config, "system", USER, numbered);

    expect(result.toolCalls.map((c) => c.name)).toEqual(numbered.map((s) => s.name));
  });
});

// ---------------------------------------------------------------------------
// The operator knob
// ---------------------------------------------------------------------------

describe("resolveMaxParallelToolCallsPerSource", () => {
  // Takes an env record so the fallback semantics are observable: the module
  // resolves its constant once at load, so nothing else in this file can reach
  // this branch.
  const KEY = "NB_MAX_PARALLEL_TOOL_CALLS_PER_SOURCE";

  it("defaults to 6 when unset", () => {
    expect(resolveMaxParallelToolCallsPerSource({})).toBe(6);
  });

  it("defaults to 6 for an empty string", () => {
    expect(resolveMaxParallelToolCallsPerSource({ [KEY]: "" })).toBe(6);
  });

  it("honors a valid positive integer", () => {
    expect(resolveMaxParallelToolCallsPerSource({ [KEY]: "12" })).toBe(12);
  });

  it("accepts 1 (fully serial against any one source)", () => {
    expect(resolveMaxParallelToolCallsPerSource({ [KEY]: "1" })).toBe(1);
  });

  it("truncates a fractional value rather than rounding up", () => {
    expect(resolveMaxParallelToolCallsPerSource({ [KEY]: "6.9" })).toBe(6);
  });

  it("falls back to the default on zero, negatives, and garbage", () => {
    // Never 0 or Infinity: removing the bound is not a sane reading of a typo,
    // and it is the exact failure this whole change exists to prevent.
    for (const bad of ["0", "-2", "abc", "NaN", "Infinity", "1e400"]) {
      expect(resolveMaxParallelToolCallsPerSource({ [KEY]: bad })).toBe(6);
    }
  });
});
