/**
 * Prometheus metrics for the platform API.
 *
 * Exposed at bare `GET /metrics` (see routes/metrics.ts) and scraped in-cluster
 * by the kube-prometheus-stack ServiceMonitor on the platform service's `http`
 * port. It is NOT public: the ingress targets the web (Caddy) service, and the
 * Caddyfile only proxies `/v1/*`, `/mcp*`, and `/.well-known/*` to the
 * platform — `/metrics` falls through to the SPA catch-all and never reaches
 * this process from outside the cluster. Keep this endpoint at `/metrics`, NOT
 * `/v1/metrics`, or Caddy would proxy it publicly.
 *
 * Uses a dedicated Registry (not the global default) so importing this module
 * has no global side effects (importing it must not register the GC
 * PerformanceObserver that collectDefaultMetrics installs — that perturbs
 * timing-sensitive tests). Default process metrics are opt-in via
 * enableDefaultMetrics(), called once at server start.
 */
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";
import type { BundleHealth } from "../tools/health-monitor.ts";

export const metricsRegistry = new Registry();

let defaultMetricsEnabled = false;

/**
 * Enable process/runtime metrics (CPU, memory, GC). Idempotent — safe to call
 * on every createApp(); only the first call registers the collectors. Call at
 * server start, never at import time.
 */
export function enableDefaultMetrics(): void {
  if (defaultMetricsEnabled) return;
  collectDefaultMetrics({ register: metricsRegistry });
  defaultMetricsEnabled = true;
}

/**
 * RED: request count by method, matched route pattern, and status code.
 *
 * `route` is the *matched route pattern* (e.g. `/v1/chat`), never the raw path,
 * so path params like conversation ids don't explode label cardinality.
 * `method` is clamped to the standard verb set (else "OTHER") and `route`
 * collapses unmatched paths to "/*", so neither label is client-unbounded.
 */
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled by the platform API.",
  labelNames: ["method", "route", "status"] as const,
  registers: [metricsRegistry],
});

/** RED: request duration in seconds, same label set. */
export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Domain metrics — LLM tokens, calls, tool execution, and tool promotion.
//
// All labels are bounded: `direction` (input/output), `kind` (fresh/cache_read/
// cache_write/text), `ttl` (none/1h/5m — the cache-write TTL tier; `none` for
// non-write kinds), `source` (main + the forked fast-slot calls), `model`
// (the catalog set — bounded by deployment config today; if custom model ids
// ever become user-settable, this label would need capping), `ok`
// (true/false). No tool names or ids — those would be client-unbounded and
// aren't needed for fleet-level optimization. Per-tenant
// breakdown comes for free from the scrape (one pod per tenant); these are not
// labeled by tenant. Purely observe-only and process-local: they increment in
// memory whether or not anything scrapes `/metrics`, so they work identically
// in a local `bun run dev` with no Prometheus.
// ---------------------------------------------------------------------------

/**
 * LLM tokens processed. `kind` splits input into fresh / cache_read / cache_write
 * (the cache-cost story: a large `cache_read` next to small `fresh` is the
 * cheap-re-read pattern; a spike in `cache_write` is a prefix re-write). For
 * `cache_write`, `ttl` tiers the write by breakpoint stability: `1h` = the stable
 * prefix (system + tools), `5m` = the rolling history (see `model/cache-policy.ts`).
 * A high `cache_write{ttl="1h"}` rate is the smoking gun for a system-prompt prefix
 * rewritten every turn (see hq research/SPEC-skill-system.md §3.2). `ttl="none"` on
 * non-write kinds. `sum`ing `kind="cache_write"` without grouping by `ttl` still
 * yields the total, so existing queries are unaffected.
 */
export const llmTokensTotal = new Counter({
  name: "nb_llm_tokens_total",
  help: "LLM tokens processed, by direction, cache kind, cache-write TTL tier, call source, and model.",
  labelNames: ["direction", "kind", "ttl", "source", "model"] as const,
  registers: [metricsRegistry],
});

/** LLM calls, by source (main loop vs forked fast-slot) and model. */
export const llmCallsTotal = new Counter({
  name: "nb_llm_calls_total",
  help: "LLM calls, by source and model.",
  labelNames: ["source", "model"] as const,
  registers: [metricsRegistry],
});

/**
 * LLM request latency in seconds — the wall-clock of one provider round-trip
 * (streaming included), observed on the main agentic loop's `llm.done`. Drives
 * the p99-latency alert. Buckets run long (to 120s): an agentic call with a
 * large context and tool streaming sits far right of an HTTP histogram, so the
 * 0.005–10s bucket set used for `http_request_duration_seconds` would clip the
 * tail the alert cares about. Forked fast-slot calls (compaction / title /
 * briefing) are not observed here — they emit no `llm.done` and record usage at
 * their own call sites (same boundary as the token counters).
 *
 * Completed-calls SLI: only successful calls (`llm.done`) are sampled. A call
 * that fails terminally records no latency sample — it bumps `nb_llm_errors_total`
 * instead — so this is "p99 of completed calls" and the latency alert is
 * intentionally blind to slow-then-failed calls. That degradation surfaces via
 * the error rate, not here; keeping failures out preserves the success-latency
 * semantics (no `outcome` label needed).
 */
export const llmRequestDurationSeconds = new Histogram({
  name: "nb_llm_request_duration_seconds",
  help: "LLM request latency in seconds, by call source and model.",
  labelNames: ["source", "model"] as const,
  buckets: [0.25, 0.5, 1, 2, 5, 10, 20, 30, 45, 60, 90, 120],
  registers: [metricsRegistry],
});

/**
 * LLM calls that failed terminally — the provider call threw and the engine's
 * in-call retry (3 attempts with backoff) was exhausted, or a context overflow
 * could not be recovered. User-initiated cancellations (abort signal) are NOT
 * counted — they aren't provider failures. Pairs with `nb_llm_calls_total`
 * (which counts successes) to form the error rate `errors / (errors + calls)`
 * the alert thresholds on. No error dimension, to keep cardinality bounded; a
 * bounded `kind` (rate_limit / timeout / server) can be added later if triage
 * needs it.
 */
export const llmErrorsTotal = new Counter({
  name: "nb_llm_errors_total",
  help: "LLM calls that failed terminally (provider error after retries), by source and model.",
  labelNames: ["source", "model"] as const,
  registers: [metricsRegistry],
});

/** Tool executions, by outcome. */
export const toolCallsTotal = new Counter({
  name: "nb_tool_calls_total",
  help: "Tool executions, by outcome.",
  labelNames: ["ok"] as const,
  registers: [metricsRegistry],
});

/**
 * Tools promoted into the active set (progressive-disclosure discovery),
 * labeled by whether the promoted tool was actually called later in the same
 * run. `used="false"` is the wasted-promotion signal — a cache-prefix re-write
 * for a tool the model never used — that validates the auto-promote policy:
 * `used="false" / total` is the promoted-but-never-called rate. Counted at run
 * end (not at promote time) so the correlation is known.
 */
export const toolPromotionsTotal = new Counter({
  name: "nb_tool_promotions_total",
  help: "Tools promoted into the active set, by whether the tool was used in the run.",
  labelNames: ["used"] as const,
  registers: [metricsRegistry],
});

/**
 * Host resolutions of `artifact://` resource links, by outcome. `result` is a
 * closed set: `ok` | `not_found` | `too_large` | `malformed` | `error`.
 *
 * The `not_found` rate is the high-signal detector: the host emitted a
 * `resource_link` and then could not resolve it — most often a cross-workspace
 * reference whose artifact lives in a workspace the viewing read token can't
 * reach (RLS-denied, collapsed to 404). That failure is otherwise silent (the
 * data plane returns a deliberate 404, the host renders a benign banner), so
 * this counter is the only fleet-level signal it happened. No tenant/workspace
 * label — one pod per tenant, so the scrape namespace attributes it, and a
 * workspace label would be client-unbounded.
 */
export const artifactResolutionsTotal = new Counter({
  name: "nb_artifact_resolutions_total",
  help: "Host artifact:// resolutions, by result.",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

/**
 * Remote/local MCP bundle (connector) crashes detected by the HealthMonitor
 * liveness loop, by connector and transport kind. A "crash" here is one
 * HealthMonitor sweep finding a source down (transport gone) that was NOT
 * deliberately stopped — so a connector that stays down increments once per
 * sweep (~30s) until it recovers or escalates to dead. That per-sweep cadence
 * is exactly the alertable signal: a sustained nonzero rate for one connector
 * is a real liveness problem the host would otherwise only learn about from a
 * user noticing failed tool calls.
 *
 * `source` is the MCP source name, sanitized to a bounded charset (see
 * recordBundleCrash) so a malformed/unbounded name can't explode cardinality.
 * `remote` separates remote (HTTP/SSE) connectors from local stdio bundles.
 * No tenant/workspace label — one pod per tenant, so the scrape namespace
 * attributes it (same rationale as nb_artifact_resolutions_total).
 *
 * This is a crash-RATE signal (good for dashboards / spotting active
 * crash-looping). It is NOT the right primitive for "is this connector down
 * right now": the HealthMonitor stops emitting once a source exhausts its
 * restarts and is marked dead-terminal, so the counter goes flat while the
 * connector stays down. Use `nb_bundle_unhealthy` (below) for down-alerting.
 */
export const bundleCrashedTotal = new Counter({
  name: "nb_bundle_crashed_total",
  help: "MCP bundle/connector crashes detected by the health monitor, by source and transport kind.",
  labelNames: ["source", "remote"] as const,
  registers: [metricsRegistry],
});

/**
 * MCP source names allowed through as a metric label unmodified. The curated
 * connector ids are lower kebab/dot tokens (e.g. `com-dropbox-mcp`,
 * `synapse-crm`), so this is generous; anything else buckets to "other" so an
 * unexpectedly-shaped name can't mint an unbounded series.
 */
const SAFE_SOURCE = /^[a-z0-9_.-]+$/;

/**
 * Record one health-monitor-detected bundle crash. `source` is the MCP source
 * name (sanitized to a bounded label); `remote` is true for HTTP/SSE connectors
 * and false for local stdio bundles. Defensive: a missing/empty/odd name
 * buckets to "other".
 */
export function recordBundleCrash(source: string | undefined, remote: boolean): void {
  const safe = source && SAFE_SOURCE.test(source) ? source : "other";
  bundleCrashedTotal.inc({ source: safe, remote: remote ? "true" : "false" });
}

/**
 * Gauge: which MCP bundles/connectors are currently DOWN — HealthMonitor state
 * `dead` — by source. `1` = down.
 *
 * Why a gauge, not the `nb_bundle_crashed_total` counter: a down source emits a
 * crash event each ~30s HealthMonitor sweep only until it exhausts its restarts
 * (`MAX_RESTARTS`), at which point it's marked `dead` and the monitor stops
 * touching it ("dead is terminal"). So the counter records a short burst then
 * goes flat — an `increase()`-based alert would auto-resolve minutes into a
 * multi-day outage. This gauge instead stays asserted for the entire outage and
 * clears only when the source recovers, so `== 1 for: Nm` is a correct
 * "connector has been down for N minutes" signal.
 *
 * Excludes `restarting` (transient: at most `MAX_RESTARTS` attempts over a few
 * minutes before the source is either healthy again or `dead`). Driven at
 * scrape time from the live HealthMonitor via {@link registerBundleHealthGauge};
 * the collect callback resets first, so a recovered source's series disappears.
 *
 * No tenant/workspace label — one pod per tenant, scrape namespace attributes it.
 */
export const bundleUnhealthy = new Gauge({
  name: "nb_bundle_unhealthy",
  help: 'MCP bundles currently down (HealthMonitor state "dead"), by source. 1 = down.',
  labelNames: ["source"] as const,
  registers: [metricsRegistry],
  collect() {
    // Runs at scrape time (prom-client invokes this in `.get()`). Reset so a
    // source that has since recovered drops out of the series entirely (the
    // gauge is absent for healthy sources), letting the alert resolve.
    this.reset();
    const status = healthStatusProvider?.() ?? [];
    for (const b of status) {
      if (b.state !== "dead") continue;
      const safe = b.name && SAFE_SOURCE.test(b.name) ? b.name : "other";
      this.set({ source: safe }, 1);
    }
  },
});

/**
 * Live HealthMonitor status provider read by the `nb_bundle_unhealthy` gauge's
 * collect callback. `null` until wired (e.g. local dev with no server start, or
 * a test that hasn't registered one), in which case the gauge reports nothing.
 */
let healthStatusProvider: (() => BundleHealth[]) | null = null;

/**
 * Wire the `nb_bundle_unhealthy` gauge to a live HealthMonitor. Call once at
 * server start, right after the HealthMonitor is constructed, with
 * `() => healthMonitor.getStatus()`. Last registration wins (so tests can swap
 * in a stub); the gauge reads through this provider at every scrape.
 */
export function registerBundleHealthGauge(getStatus: () => BundleHealth[]): void {
  healthStatusProvider = getStatus;
}

/** Token usage subset needed for metrics — a structural slice of `TokenUsage`. */
interface UsageForMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * 1-hour-TTL portion of `cacheWriteTokens` (the stable system+tools prefix).
   * Absent = no split reported; treated as all-1h (mirrors `usage/cost.ts`) so
   * 1h-tier thrash is never undercounted. The 5-minute remainder is derived.
   */
  cacheWrite1hTokens?: number;
}

/**
 * Origin of an LLM call. Closed set by design — the whole point of these
 * metrics is bounded label cardinality, so a typo at a call site is a compile
 * error rather than a silently-minted new series.
 */
export type LlmUsageSource = "main" | "title" | "compaction" | "briefing";

/**
 * Record one LLM call's usage: a call increment plus token counts split into
 * fresh / cache_read / cache_write / output. Called for both the main agentic
 * loop (`source: "main"`) and the forked fast-slot calls (`compaction` /
 * `title` / `briefing`), so fleet token spend is attributable by origin.
 */
export function recordLlmUsage(
  source: LlmUsageSource,
  model: string,
  usage: UsageForMetrics,
): void {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(usage.inputTokens - cacheRead - cacheWrite, 0);
  // TTL split mirrors `usage/cost.ts`: an absent 1h figure means "no split
  // reported", treated as all-1h (the conservative tier) so 1h thrash is never
  // undercounted. The 5-minute remainder is derived.
  const cacheWrite1h = Math.min(usage.cacheWrite1hTokens ?? cacheWrite, cacheWrite);
  const cacheWrite5m = Math.max(cacheWrite - cacheWrite1h, 0);

  llmCallsTotal.inc({ source, model });
  if (fresh > 0)
    llmTokensTotal.inc({ direction: "input", kind: "fresh", ttl: "none", source, model }, fresh);
  if (cacheRead > 0)
    llmTokensTotal.inc(
      { direction: "input", kind: "cache_read", ttl: "none", source, model },
      cacheRead,
    );
  if (cacheWrite1h > 0)
    llmTokensTotal.inc(
      { direction: "input", kind: "cache_write", ttl: "1h", source, model },
      cacheWrite1h,
    );
  if (cacheWrite5m > 0)
    llmTokensTotal.inc(
      { direction: "input", kind: "cache_write", ttl: "5m", source, model },
      cacheWrite5m,
    );
  if (usage.outputTokens > 0)
    llmTokensTotal.inc(
      { direction: "output", kind: "text", ttl: "none", source, model },
      usage.outputTokens,
    );
}
