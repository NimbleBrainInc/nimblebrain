import { describe, expect, it } from "bun:test";
import { RunMetricsCollector } from "../../src/engine/run-metrics.ts";
import type { EngineEvent } from "../../src/engine/types.ts";

describe("RunMetricsCollector", () => {
  it("starts at zero", () => {
    const collector = new RunMetricsCollector();
    expect(collector.cacheReadTokens).toBe(0);
    expect(collector.totalLlmMs).toBe(0);
  });

  it("accumulates cacheReadTokens from multiple llm.done events", () => {
    const collector = new RunMetricsCollector();
    collector.emit({
      type: "llm.done",
      data: { cacheReadTokens: 100, llmMs: 0 },
    });
    collector.emit({
      type: "llm.done",
      data: { cacheReadTokens: 250, llmMs: 0 },
    });
    expect(collector.cacheReadTokens).toBe(350);
  });

  it("accumulates totalLlmMs from multiple llm.done events", () => {
    const collector = new RunMetricsCollector();
    collector.emit({
      type: "llm.done",
      data: { cacheReadTokens: 0, llmMs: 120 },
    });
    collector.emit({
      type: "llm.done",
      data: { cacheReadTokens: 0, llmMs: 80 },
    });
    expect(collector.totalLlmMs).toBe(200);
  });

  it("ignores non-llm.done events", () => {
    const collector = new RunMetricsCollector();
    const events: EngineEvent[] = [
      { type: "tool.start", data: { name: "bash", id: "t1" } },
      { type: "text.delta", data: { text: "hello" } },
      { type: "run.start", data: { runId: "r1" } },
      { type: "tool.done", data: { name: "bash", id: "t1", ok: true, ms: 50 } },
      { type: "run.done", data: { runId: "r1", stopReason: "complete" } },
    ];
    for (const event of events) {
      collector.emit(event);
    }
    expect(collector.cacheReadTokens).toBe(0);
    expect(collector.totalLlmMs).toBe(0);
  });
});
