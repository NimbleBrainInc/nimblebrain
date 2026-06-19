import { describe, expect, it, spyOn } from "bun:test";
import { log } from "../../src/cli/log.ts";
import { MAX_TRACKED_RUNS, MetricsEventSink } from "../../src/adapters/metrics-events.ts";
import type { Counter } from "prom-client";
import {
  bundleCrashedTotal,
  llmCallsTotal,
  llmTokensTotal,
  recordBundleCrash,
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

// Sum across every label-series of a counter — for asserting "nothing changed".
// biome-ignore lint/suspicious/noExplicitAny: same as read().
async function readTotal(counter: Counter<any>): Promise<number> {
  const metric = await counter.get();
  return metric.values.reduce((acc, s) => acc + s.value, 0);
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
    };

    sink.emit({
      type: "llm.done",
      data: {
        model: "tm-sink",
        usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
    sink.emit({ type: "tool.done", data: { runId: "r-sink", name: "a", ok: true } });
    sink.emit({ type: "tool.done", data: { runId: "r-sink", name: "b", ok: false } });

    expect((await read(llmTokensTotal, fresh)) - before.fresh).toBe(200);
    expect((await read(toolCallsTotal, { ok: "true" })) - before.okTrue).toBe(1);
    expect((await read(toolCallsTotal, { ok: "false" })) - before.okFalse).toBe(1);
  });

  it("labels promotions used=true when the promoted tool is called, false otherwise", async () => {
    const sink = new MetricsEventSink();
    const beforeTrue = await read(toolPromotionsTotal, { used: "true" });
    const beforeFalse = await read(toolPromotionsTotal, { used: "false" });

    // Run 1: promote two tools, call only one, then finish.
    sink.emit({ type: "tool.promoted", data: { runId: "r1", toolName: "used-tool" } });
    sink.emit({ type: "tool.promoted", data: { runId: "r1", toolName: "unused-tool" } });
    sink.emit({ type: "tool.done", data: { runId: "r1", name: "used-tool", ok: true } });
    // Nothing should be counted until the run terminates.
    expect((await read(toolPromotionsTotal, { used: "true" })) - beforeTrue).toBe(0);
    sink.emit({ type: "run.done", data: { runId: "r1" } });

    expect((await read(toolPromotionsTotal, { used: "true" })) - beforeTrue).toBe(1);
    expect((await read(toolPromotionsTotal, { used: "false" })) - beforeFalse).toBe(1);
  });

  it("does not double-count or leak across interleaved runs; run.error finalizes too", async () => {
    const sink = new MetricsEventSink();
    const beforeFalse = await read(toolPromotionsTotal, { used: "false" });

    // Interleaved runs, neither tool called; one ends via run.error.
    sink.emit({ type: "tool.promoted", data: { runId: "rA", toolName: "tA" } });
    sink.emit({ type: "tool.promoted", data: { runId: "rB", toolName: "tB" } });
    sink.emit({ type: "run.done", data: { runId: "rA" } });
    sink.emit({ type: "run.error", data: { runId: "rB" } });
    // A second terminator for an already-finalized run is a no-op.
    sink.emit({ type: "run.done", data: { runId: "rA" } });

    expect((await read(toolPromotionsTotal, { used: "false" })) - beforeFalse).toBe(2);
  });

  it("warns (not silently) and drops the oldest run when the tracked-run cap is exceeded", async () => {
    const sink = new MetricsEventSink();
    const warnings: string[] = [];
    const warnSpy = spyOn(log, "warn").mockImplementation((msg?: unknown) => {
      warnings.push(String(msg));
    });
    try {
      const before = await read(toolPromotionsTotal, { used: "false" });
      // The first run is the oldest, so it's evicted once the cap is exceeded.
      sink.emit({ type: "tool.promoted", data: { runId: "evict-me", toolName: "t" } });
      for (let i = 0; i <= MAX_TRACKED_RUNS; i++) {
        sink.emit({ type: "tool.promoted", data: { runId: `filler-${i}`, toolName: "t" } });
      }
      // Its terminator now finds no state → no sample recorded (the loss the
      // warn surfaces).
      sink.emit({ type: "run.done", data: { runId: "evict-me" } });

      expect((await read(toolPromotionsTotal, { used: "false" })) - before).toBe(0);
      expect(warnings.some((w) => w.includes("evict-me"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("ignores events it doesn't track", async () => {
    const sink = new MetricsEventSink();
    // Must not throw on an unrelated event.
    expect(() => sink.emit({ type: "run.start", data: { runId: "r1" } })).not.toThrow();
  });
});

describe("bundle crash metric", () => {
  it("test_run_error_bundle_crashed_increments_counter_with_connector_and_remote", async () => {
    const sink = new MetricsEventSink();
    const labels = { connector: "com-dropbox-mcp", remote: "true" };
    const before = await read(bundleCrashedTotal, labels);
    // Mirrors HealthMonitor's emission: run.error with a nested bundle.crashed
    // event, a `source` name, and `remote: true`. No runId.
    sink.emit({
      type: "run.error",
      data: { source: "com-dropbox-mcp", event: "bundle.crashed", remote: true },
    });
    expect((await read(bundleCrashedTotal, labels)) - before).toBe(1);
  });

  it("test_local_source_bundle_crashed_records_remote_false", async () => {
    const sink = new MetricsEventSink();
    const labels = { connector: "synapse-crm", remote: "false" };
    const before = await read(bundleCrashedTotal, labels);
    // A local stdio bundle: HealthMonitor omits the `remote` field entirely.
    sink.emit({
      type: "run.error",
      data: { source: "synapse-crm", event: "bundle.crashed" },
    });
    expect((await read(bundleCrashedTotal, labels)) - before).toBe(1);
  });

  it("test_run_error_without_bundle_crashed_does_not_increment", async () => {
    const sink = new MetricsEventSink();
    const before = await readTotal(bundleCrashedTotal);
    // An ordinary run error and a normal run completion must not touch the
    // crash counter — only the nested bundle.crashed discriminator counts.
    sink.emit({ type: "run.error", data: { runId: "r1" } });
    sink.emit({ type: "run.done", data: { runId: "r2" } });
    sink.emit({
      type: "run.error",
      data: { source: "com-dropbox-mcp", event: "bundle.restarting", remote: true },
    });
    expect((await readTotal(bundleCrashedTotal)) - before).toBe(0);
  });

  it("test_unsafe_connector_name_buckets_to_other", async () => {
    const labels = { connector: "other", remote: "false" };
    const before = await read(bundleCrashedTotal, labels);
    recordBundleCrash("Weird Name!! /etc", false);
    recordBundleCrash(undefined, false);
    recordBundleCrash("", false);
    expect((await read(bundleCrashedTotal, labels)) - before).toBe(3);
  });
});
