import { describe, expect, it } from "bun:test";
import type { LanguageModelV4Message, LanguageModelV4ToolCall } from "@ai-sdk/provider";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { AgentEngine, resolveMaxParallelToolCallsPerSource } from "../../src/engine/engine.ts";
import type { EngineConfig, ToolCall, ToolResult, ToolSchema } from "../../src/engine/types.ts";
import { createMockModel } from "../helpers/mock-model.ts";

const config: EngineConfig = {
  model: "test-model",
  maxIterations: 10,
  maxInputTokens: 500_000,
  maxOutputTokens: 16_384,
};

const USER: LanguageModelV4Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

/** A tool that changes nothing: its calls in one response may run together. */
function readSchema(name: string): ToolSchema {
  return { ...schema(name), annotations: { readOnlyHint: true } };
}

/** A tool with no annotations, which the MCP spec reads as one that may write. */
function schema(name: string): ToolSchema {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

function toolCall(id: string, toolName: string): LanguageModelV4ToolCall {
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
function twoTurnModel(calls: LanguageModelV4ToolCall[]) {
  let turn = 0;
  return createMockModel(async () => {
    turn++;
    if (turn === 1) return { content: calls };
    return { content: [{ type: "text" as const, text: "done" }] };
  });
}

describe("engine tool-call fan-out is bounded per source", () => {
  // Only read-only calls fan out (writes run in the model's order, below), so
  // the bound is exercised on reads.
  it("caps simultaneous calls to one source without serializing them", async () => {
    // A large batch of reads against a single connector. Unbounded, all 25 hit
    // that one server at once — and because the source is shared, one rejection
    // that trips transport recovery takes the in-flight siblings down with it.
    const tools = [readSchema("people__list_contacts")];
    const { router, peak } = trackingRouter(tools);
    const calls = Array.from({ length: 25 }, (_, i) => toolCall(`c${i}`, "people__list_contacts"));

    const engine = new AgentEngine(twoTurnModel(calls), router, new NoopEventSink());
    await engine.run(config, "system", USER, tools);

    // Read the SAME source the engine reads (process.env), not the hardcoded
    // default — otherwise this goes red on correct code in any shell that
    // exports the knob, which operators are invited to do.
    // Clamped to the group size, since that is the real ceiling on in-flight.
    // Exact, not a range: with 25 calls queued behind it the pool starts `cap`
    // workers immediately, so peak IS the cap. Stronger than `<= cap` (which a
    // serial implementation would also satisfy) and correct at every knob value,
    // including `cap = 1` where "still parallel" would be false by definition.
    const cap = Math.min(resolveMaxParallelToolCallsPerSource(), 25);
    expect(peak.get("people") ?? 0).toBe(cap);
  });

  it("does not let one source's depth throttle a different source", async () => {
    // Capacity belongs to the server being called, so sources are budgeted
    // independently: a batch touching three connectors must not serialize the
    // small groups behind the large one.
    const tools = [readSchema("people__read"), readSchema("memory__get"), readSchema("web__fetch")];
    const { router, peak, order } = trackingRouter(tools);
    const calls = [
      ...Array.from({ length: 20 }, (_, i) => toolCall(`p${i}`, "people__read")),
      ...Array.from({ length: 3 }, (_, i) => toolCall(`m${i}`, "memory__get")),
      ...Array.from({ length: 2 }, (_, i) => toolCall(`w${i}`, "web__fetch")),
    ];

    const engine = new AgentEngine(twoTurnModel(calls), router, new NoopEventSink());
    await engine.run(config, "system", USER, tools);

    // Every expectation is derived from the live cap, so this stays meaningful
    // whether an operator has raised the knob or lowered it. A group smaller
    // than the cap runs at full width; a group larger than it runs at the cap.
    const cap = resolveMaxParallelToolCallsPerSource();
    const peopleWidth = Math.min(cap, 20);
    const memoryWidth = Math.min(cap, 3);
    const webWidth = Math.min(cap, 2);
    expect(peak.get("people") ?? 0).toBeLessThanOrEqual(peopleWidth);

    // THE per-source assertion. Peak-within-a-group cannot see this: under a
    // single global cap the small groups are simply delayed behind the 20-call
    // one, and their peaks still reach 3 and 2 once slots free. Dispatch ORDER
    // can see it — and unlike wall-clock it needs no timing assumptions.
    //
    // The first wave is every call dispatched before anything completes: `cap`
    // from `people` plus ALL of `memory` and `web`, because their groups are
    // smaller than the cap and hold their own budgets. A global bound puts `cap`
    // people calls there and nothing else.
    const firstWave = order.slice(0, peopleWidth + memoryWidth + webWidth);
    expect(firstWave.filter((s) => s === "memory")).toHaveLength(memoryWidth);
    expect(firstWave.filter((s) => s === "web")).toHaveLength(webWidth);
    expect(firstWave.filter((s) => s === "people")).toHaveLength(peopleWidth);

    // Kept as a secondary check: the small groups do run at their full width.
    expect(peak.get("memory")).toBe(memoryWidth);
    expect(peak.get("web")).toBe(webWidth);
  });

  it("returns results in call order regardless of completion order", async () => {
    // `buildToolResults` pairs results to calls positionally, so the bound must
    // preserve index even though workers finish out of order.
    const execute = async (call: ToolCall): Promise<ToolResult> => {
      const n = Number(call.name.slice(-1));
      await new Promise((resolve) => setTimeout(resolve, (5 - n) * 4));
      return { content: textContent("ok"), isError: false };
    };
    const numbered = Array.from({ length: 5 }, (_, i) => readSchema(`people__read${i}`));
    const router = new StaticToolRouter(numbered, execute);
    const calls = numbered.map((s, i) => toolCall(`c${i}`, s.name));

    const engine = new AgentEngine(twoTurnModel(calls), router, new NoopEventSink());
    const result = await engine.run(config, "system", USER, numbered);

    expect(result.toolCalls.map((c) => c.name)).toEqual(numbered.map((s) => s.name));
  });
});

// ---------------------------------------------------------------------------
// Writes keep the model's order
// ---------------------------------------------------------------------------

/**
 * A router whose every call waits until the test releases it, so a test
 * decides when each call ends and reads exactly which calls have started.
 * `state` is a value a write sets as it ends and a read returns as it starts.
 */
function gatedRouter(tools: ToolSchema[]) {
  const started: string[] = [];
  const ended: string[] = [];
  const gates = new Map<string, () => void>();
  const startWaiters = new Map<string, () => void>();
  let state = "before";

  const execute = async (call: ToolCall): Promise<ToolResult> => {
    started.push(call.id);
    const seen = state;
    await new Promise<void>((resolve) => {
      gates.set(call.id, resolve);
      startWaiters.get(call.id)?.();
    });
    if (call.name.endsWith("__record")) state = `after:${call.id}`;
    ended.push(call.id);
    return { content: textContent(`${call.id} saw ${seen}`), isError: false };
  };

  return {
    router: new StaticToolRouter(tools, execute),
    started,
    ended,
    /** Resolves once `id` is running and waiting for its release. */
    running(id: string): Promise<void> {
      if (gates.has(id)) return Promise.resolve();
      return new Promise((resolve) => startWaiters.set(id, resolve));
    },
    release(id: string): void {
      const gate = gates.get(id);
      if (!gate) throw new Error(`${id} is not running`);
      gate();
    },
  };
}

/**
 * Let every pending promise and I/O callback run, so any call the engine would
 * start now has started. Turn-based, not a clock: nothing here waits on time.
 */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("engine runs a write in the model's order", () => {
  const RECORD = schema("crm__record");
  const STATUS = readSchema("crm__status");
  const LIST = readSchema("crm__list");

  it("starts a read after the write before it ends, and the read sees the write", async () => {
    const tools = [RECORD, STATUS];
    const gated = gatedRouter(tools);
    const calls = [toolCall("w", "crm__record"), toolCall("r", "crm__status")];
    const engine = new AgentEngine(twoTurnModel(calls), gated.router, new NoopEventSink());
    const run = engine.run(config, "system", USER, tools);

    await gated.running("w");
    await drain();
    expect(gated.started).toEqual(["w"]);

    gated.release("w");
    await gated.running("r");
    expect(gated.ended).toEqual(["w"]);
    gated.release("r");
    const result = await run;

    expect(result.toolCalls.map((c) => c.id)).toEqual(["w", "r"]);
    expect(result.toolCalls[1]?.output).toContain("r saw after:w");
  });

  it("runs read, read together, then the write, then the read after it", async () => {
    const tools = [RECORD, STATUS, LIST];
    const gated = gatedRouter(tools);
    const calls = [
      toolCall("r1", "crm__status"),
      toolCall("r2", "crm__list"),
      toolCall("w", "crm__record"),
      toolCall("r3", "crm__status"),
    ];
    const engine = new AgentEngine(twoTurnModel(calls), gated.router, new NoopEventSink());
    const run = engine.run(config, "system", USER, tools);

    // Both reads are running at once: neither has been released.
    await gated.running("r1");
    await gated.running("r2");
    await drain();
    expect(gated.started).toEqual(["r1", "r2"]);

    // The write waits for every read before it, not just the first to end.
    gated.release("r2");
    await drain();
    expect(gated.started).toEqual(["r1", "r2"]);
    gated.release("r1");
    await gated.running("w");
    expect(gated.ended).toEqual(["r2", "r1"]);

    // The read after the write waits for it.
    await drain();
    expect(gated.started).toEqual(["r1", "r2", "w"]);
    gated.release("w");
    await gated.running("r3");
    gated.release("r3");
    const result = await run;

    // Results stay in call order whatever order the calls ended in.
    expect(result.toolCalls.map((c) => c.id)).toEqual(["r1", "r2", "w", "r3"]);
    expect(result.toolCalls[0]?.output).toContain("r1 saw before");
    expect(result.toolCalls[3]?.output).toContain("r3 saw after:w");
  });

  it("runs a response of reads only all at once", async () => {
    const tools = [STATUS, LIST];
    const gated = gatedRouter(tools);
    const ids = ["a", "b", "c", "d"];
    const calls = ids.map((id, i) => toolCall(id, i % 2 ? "crm__list" : "crm__status"));
    const engine = new AgentEngine(twoTurnModel(calls), gated.router, new NoopEventSink());
    const run = engine.run(config, "system", USER, tools);

    // Every read is running before any is released.
    for (const id of ids) await gated.running(id);
    expect([...gated.started].sort()).toEqual(ids);

    for (const id of [...ids].reverse()) gated.release(id);
    const result = await run;
    expect(result.toolCalls.map((c) => c.id)).toEqual(ids);
  });

  it("treats a tool with no annotations as a write", async () => {
    const tools = [schema("crm__note")];
    const gated = gatedRouter(tools);
    const calls = [toolCall("n1", "crm__note"), toolCall("n2", "crm__note")];
    const engine = new AgentEngine(twoTurnModel(calls), gated.router, new NoopEventSink());
    const run = engine.run(config, "system", USER, tools);

    await gated.running("n1");
    await drain();
    expect(gated.started).toEqual(["n1"]);
    gated.release("n1");
    await gated.running("n2");
    gated.release("n2");
    const result = await run;
    expect(result.toolCalls.map((c) => c.id)).toEqual(["n1", "n2"]);
  });

  it("starts no later call once the run is cancelled", async () => {
    const tools = [RECORD, STATUS];
    const gated = gatedRouter(tools);
    const calls = [toolCall("w", "crm__record"), toolCall("r", "crm__status")];
    const engine = new AgentEngine(twoTurnModel(calls), gated.router, new NoopEventSink());
    const abort = new AbortController();
    const run = engine.run({ ...config, signal: abort.signal }, "system", USER, tools);

    await gated.running("w");
    abort.abort();
    gated.release("w");
    await expect(run).rejects.toThrow();

    expect(gated.started).toEqual(["w"]);
  });

  it("treats readOnlyHint: false as a write", async () => {
    const tools = [{ ...schema("crm__save"), annotations: { readOnlyHint: false } }, STATUS];
    const gated = gatedRouter(tools);
    const calls = [toolCall("s", "crm__save"), toolCall("r", "crm__status")];
    const engine = new AgentEngine(twoTurnModel(calls), gated.router, new NoopEventSink());
    const run = engine.run(config, "system", USER, tools);

    await gated.running("s");
    await drain();
    expect(gated.started).toEqual(["s"]);
    gated.release("s");
    await gated.running("r");
    gated.release("r");
    await run;
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
