import { describe, expect, it } from "bun:test";
import { MetricsEventSink } from "../../src/adapters/metrics-events.ts";
import type { Counter } from "prom-client";
import {
  llmCallsTotal,
  llmTokensTotal,
  recordLlmUsage,
  toolCallsTotal,
  toolPromotionsTotal,
} from "../../src/api/metrics.ts";

// Read one label-series value off a counter. Tests use deltas (read → act →
// read) rather than reset(), so they're robust to the shared process-global
// registry that other test files also touch.
// biome-ignore lint/suspicious/noExplicitAny: prom-client's generic Counter is awkward to type structurally here.
async function read(counter: Counter<any>, labels: Record<string, string> = {}): Promise<number> {
  const metric = await counter.get();
  for (const s of metric.values) {
    if (Object.entries(labels).every(([k, v]) => s.labels[k] === v)) return s.value;
  }
  return 0;
}

describe("recordLlmUsage", () => {
  it("splits input into fresh/cache_read/cache_write and counts output + calls", async () => {
    const base = { source: "compaction", model: "tm-record" };
    const fresh = { direction: "input", kind: "fresh", ...base };
    const cr = { direction: "input", kind: "cache_read", ...base };
    const cw = { direction: "input", kind: "cache_write", ...base };
    const out = { direction: "output", kind: "text", ...base };

    const before = {
      fresh: await read(llmTokensTotal, fresh),
      cr: await read(llmTokensTotal, cr),
      cw: await read(llmTokensTotal, cw),
      out: await read(llmTokensTotal, out),
      calls: await read(llmCallsTotal, base),
    };

    // fresh = 1000 - 600 - 300 = 100
    recordLlmUsage("compaction", "tm-record", {
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 600,
      cacheWriteTokens: 300,
    });

    expect((await read(llmTokensTotal, fresh)) - before.fresh).toBe(100);
    expect((await read(llmTokensTotal, cr)) - before.cr).toBe(600);
    expect((await read(llmTokensTotal, cw)) - before.cw).toBe(300);
    expect((await read(llmTokensTotal, out)) - before.out).toBe(50);
    expect((await read(llmCallsTotal, base)) - before.calls).toBe(1);
  });
});

describe("MetricsEventSink", () => {
  it("records main-loop tokens, tool outcomes, and promotions", async () => {
    const sink = new MetricsEventSink();
    const fresh = { direction: "input", kind: "fresh", source: "main", model: "tm-sink" };

    const before = {
      fresh: await read(llmTokensTotal, fresh),
      okTrue: await read(toolCallsTotal, { ok: "true" }),
      okFalse: await read(toolCallsTotal, { ok: "false" }),
      promo: await read(toolPromotionsTotal),
    };

    sink.emit({
      type: "llm.done",
      data: {
        model: "tm-sink",
        usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
    sink.emit({ type: "tool.done", data: { ok: true } });
    sink.emit({ type: "tool.done", data: { ok: false } });
    sink.emit({ type: "tool.promoted", data: { toolName: "x" } });

    expect((await read(llmTokensTotal, fresh)) - before.fresh).toBe(200);
    expect((await read(toolCallsTotal, { ok: "true" })) - before.okTrue).toBe(1);
    expect((await read(toolCallsTotal, { ok: "false" })) - before.okFalse).toBe(1);
    expect((await read(toolPromotionsTotal)) - before.promo).toBe(1);
  });

  it("ignores events it doesn't track", async () => {
    const sink = new MetricsEventSink();
    // Must not throw on an unrelated event.
    expect(() => sink.emit({ type: "run.start", data: { runId: "r1" } })).not.toThrow();
  });
});
