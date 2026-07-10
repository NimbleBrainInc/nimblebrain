import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { log } from "../../src/observability/log.ts";
import { MAX_TRACKED_RUNS, MetricsEventSink } from "../../src/adapters/metrics-events.ts";
import type { Counter } from "prom-client";
import {
  bundleCrashedTotal,
  bundleUnhealthy,
  llmCallsTotal,
  llmErrorsTotal,
  llmRequestDurationSeconds,
  llmTokensTotal,
  llmTtftSeconds,
  recordBundleCrash,
  recordLlmUsage,
  registerBundleHealthGauge,
  toolCallsTotal,
  toolPromotionsTotal,
} from "../../src/api/metrics.ts";
import type { BundleHealth } from "../../src/tools/health-monitor.ts";

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
    const fresh = { direction: "input", kind: "fresh", ttl: "none", ...base };
    const cr = { direction: "input", kind: "cache_read", ttl: "none", ...base };
    // 300 writes with no 1h split reported → all-1h (the conservative tier).
    const cw = { direction: "input", kind: "cache_write", ttl: "1h", ...base };
    const out = { direction: "output", kind: "text", ttl: "none", ...base };

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

  it("tiers cache_write into 1h/5m when the engine reports the 1h portion", async () => {
    const base = { source: "main", model: "tm-ttl" };
    const cw1h = { direction: "input", kind: "cache_write", ttl: "1h", ...base };
    const cw5m = { direction: "input", kind: "cache_write", ttl: "5m", ...base };
    const before = { h: await read(llmTokensTotal, cw1h), m: await read(llmTokensTotal, cw5m) };

    // 500 cache writes, 200 on the 1h (stable-prefix) tier → 300 are the 5m remainder.
    recordLlmUsage("main", "tm-ttl", {
      inputTokens: 500,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 500,
      cacheWrite1hTokens: 200,
    });

    expect((await read(llmTokensTotal, cw1h)) - before.h).toBe(200);
    expect((await read(llmTokensTotal, cw5m)) - before.m).toBe(300);
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
  it("test_run_error_bundle_crashed_increments_counter_with_source_and_remote", async () => {
    const sink = new MetricsEventSink();
    const labels = { source: "com-dropbox-mcp", remote: "true" };
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
    const labels = { source: "synapse-crm", remote: "false" };
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

  it("test_unsafe_source_name_buckets_to_other", async () => {
    const labels = { source: "other", remote: "false" };
    const before = await read(bundleCrashedTotal, labels);
    recordBundleCrash("Weird Name!! /etc", false);
    recordBundleCrash(undefined, false);
    recordBundleCrash("", false);
    expect((await read(bundleCrashedTotal, labels)) - before).toBe(3);
  });
});

describe("bundle unhealthy gauge", () => {
  // Read one `nb_bundle_unhealthy` series; `.get()` triggers the collect
  // callback. Returns undefined when the series is absent (collect resets each
  // scrape, so a recovered source disappears entirely rather than going to 0).
  async function readGauge(source: string): Promise<number | undefined> {
    const metric = await bundleUnhealthy.get();
    for (const s of metric.values) {
      if (s.labels.source === source) return s.value;
    }
    return undefined;
  }

  const status = (...records: Array<Partial<BundleHealth> & { name: string; state: BundleHealth["state"] }>): BundleHealth[] =>
    records.map((r) => ({ uptime: null, restartCount: 0, ...r }));

  // Leave the gauge inert for other test files sharing the process-global
  // registry (a full-registry scrape elsewhere would otherwise invoke our
  // collect with a stale provider).
  afterAll(() => registerBundleHealthGauge(() => []));

  it("test_bundle_unhealthy_gauge_excludes_deliberately_stopped_dead_source", async () => {
    // `dead` is now reachable only via deliberate teardown (disconnect /
    // uninstall) — not an involuntary outage, so it must NOT page.
    registerBundleHealthGauge(() => status({ name: "com-dropbox-mcp", state: "dead" }));
    expect(await readGauge("com-dropbox-mcp")).toBeUndefined();
  });

  it("test_bundle_unhealthy_gauge_absent_for_healthy_source", async () => {
    registerBundleHealthGauge(() => status({ name: "synapse-crm", state: "healthy" }));
    expect(await readGauge("synapse-crm")).toBeUndefined();
  });

  it("test_bundle_unhealthy_gauge_excludes_restarting_source", async () => {
    // `restarting` is a transient burst (≤ MAX_RESTARTS attempts) — it should
    // not assert the down signal; only the settled down states do.
    registerBundleHealthGauge(() => status({ name: "ai-granola-mcp", state: "restarting" }));
    expect(await readGauge("ai-granola-mcp")).toBeUndefined();
  });

  it("test_bundle_unhealthy_gauge_reports_1_for_cooldown_source", async () => {
    // `cooldown` (crashed, spent its quick-retry budget, now on slow re-probe)
    // can stay down indefinitely, so it must keep the alert lit like `dead`.
    registerBundleHealthGauge(() => status({ name: "com-example-enrich-mcp", state: "cooldown" }));
    expect(await readGauge("com-example-enrich-mcp")).toBe(1);
  });

  it("test_bundle_unhealthy_gauge_resolves_when_source_recovers", async () => {
    registerBundleHealthGauge(() => status({ name: "com-dropbox-mcp", state: "cooldown" }));
    expect(await readGauge("com-dropbox-mcp")).toBe(1);
    // Source recovers → collect resets → series disappears → alert can resolve.
    registerBundleHealthGauge(() => status({ name: "com-dropbox-mcp", state: "healthy" }));
    expect(await readGauge("com-dropbox-mcp")).toBeUndefined();
  });

  it("test_bundle_unhealthy_gauge_separate_series_per_source", async () => {
    registerBundleHealthGauge(() =>
      status(
        { name: "com-dropbox-mcp", state: "cooldown" },
        { name: "ai-granola-mcp", state: "cooldown" },
        { name: "synapse-crm", state: "healthy" },
      ),
    );
    expect(await readGauge("com-dropbox-mcp")).toBe(1);
    expect(await readGauge("ai-granola-mcp")).toBe(1);
    expect(await readGauge("synapse-crm")).toBeUndefined();
  });

  it("test_bundle_unhealthy_gauge_unsafe_source_buckets_to_other", async () => {
    registerBundleHealthGauge(() => status({ name: "Weird Name!! /etc", state: "cooldown" }));
    expect(await readGauge("other")).toBe(1);
  });
});

describe("LLM latency + error metrics", () => {
  // Read a histogram's _sum / _count for a label-series. prom-client emits the
  // aggregate as sibling series named `<name>_sum` / `<name>_count`.
  async function readHistogram(
    suffix: "sum" | "count",
    labels: Record<string, string>,
  ): Promise<number> {
    const metric = await llmRequestDurationSeconds.get();
    const want = `nb_llm_request_duration_seconds_${suffix}`;
    for (const s of metric.values) {
      if (
        // biome-ignore lint/suspicious/noExplicitAny: prom-client value shape.
        (s as any).metricName === want &&
        Object.entries(labels).every(([k, v]) => s.labels[k] === v)
      ) {
        return s.value;
      }
    }
    return 0;
  }

  it("test_llm_done_observes_latency_histogram_seconds", async () => {
    const sink = new MetricsEventSink();
    const labels = { source: "main", model: "tm-latency" };
    const beforeCount = await readHistogram("count", labels);
    const beforeSum = await readHistogram("sum", labels);
    // 2400ms call → 2.4s observed.
    sink.emit({ type: "llm.done", data: { runId: "r1", model: "tm-latency", llmMs: 2400 } });
    expect((await readHistogram("count", labels)) - beforeCount).toBe(1);
    expect((await readHistogram("sum", labels)) - beforeSum).toBeCloseTo(2.4, 5);
  });

  it("test_llm_done_without_llmMs_does_not_observe", async () => {
    const sink = new MetricsEventSink();
    const labels = { source: "main", model: "tm-no-ms" };
    const before = await readHistogram("count", labels);
    // A malformed llm.done missing llmMs must not record a 0s (or NaN) sample.
    sink.emit({ type: "llm.done", data: { runId: "r1", model: "tm-no-ms" } });
    expect((await readHistogram("count", labels)) - before).toBe(0);
  });

  // Same shape as readHistogram, against the TTFT histogram.
  async function readTtft(
    suffix: "sum" | "count",
    labels: Record<string, string>,
  ): Promise<number> {
    const metric = await llmTtftSeconds.get();
    const want = `nb_llm_ttft_seconds_${suffix}`;
    for (const s of metric.values) {
      if (
        // biome-ignore lint/suspicious/noExplicitAny: prom-client value shape.
        (s as any).metricName === want &&
        Object.entries(labels).every(([k, v]) => s.labels[k] === v)
      ) {
        return s.value;
      }
    }
    return 0;
  }

  it("test_llm_done_observes_ttft_histogram_seconds", async () => {
    const sink = new MetricsEventSink();
    const labels = { source: "main", model: "tm-ttft" };
    const beforeCount = await readTtft("count", labels);
    const beforeSum = await readTtft("sum", labels);
    // 1800ms to first token → 1.8s observed; the long round-trip (60s) is the
    // decode this metric deliberately looks past.
    sink.emit({ type: "llm.done", data: { runId: "r1", model: "tm-ttft", llmMs: 60000, ttftMs: 1800 } });
    expect((await readTtft("count", labels)) - beforeCount).toBe(1);
    expect((await readTtft("sum", labels)) - beforeSum).toBeCloseTo(1.8, 5);
  });

  it("test_llm_done_without_ttftMs_does_not_observe_ttft", async () => {
    const sink = new MetricsEventSink();
    const labels = { source: "main", model: "tm-no-ttft" };
    const before = await readTtft("count", labels);
    // An empty completion (no output part) carries no ttftMs; it must not record
    // a 0s (or NaN) TTFT sample. The round-trip latency still observes.
    sink.emit({ type: "llm.done", data: { runId: "r1", model: "tm-no-ttft", llmMs: 5000 } });
    expect((await readTtft("count", labels)) - before).toBe(0);
  });

  it("test_llm_error_increments_errors_counter_with_model", async () => {
    const sink = new MetricsEventSink();
    const labels = { source: "main", model: "tm-err" };
    const before = await read(llmErrorsTotal, labels);
    sink.emit({ type: "llm.error", data: { runId: "r1", model: "tm-err" } });
    expect((await read(llmErrorsTotal, labels)) - before).toBe(1);
  });

  it("test_llm_done_does_not_increment_error_counter", async () => {
    const sink = new MetricsEventSink();
    const before = await readTotal(llmErrorsTotal);
    sink.emit({ type: "llm.done", data: { runId: "r1", model: "tm-err", llmMs: 100 } });
    expect((await readTotal(llmErrorsTotal)) - before).toBe(0);
  });
});
