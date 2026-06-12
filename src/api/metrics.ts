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
import { Counter, collectDefaultMetrics, Histogram, Registry } from "prom-client";

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
// cache_write/text), `source` (main + the forked fast-slot calls), `model`
// (the catalog set), `ok` (true/false). No tool names or ids — those would be
// client-unbounded and aren't needed for fleet-level optimization. Per-tenant
// breakdown comes for free from the scrape (one pod per tenant); these are not
// labeled by tenant. Purely observe-only and process-local: they increment in
// memory whether or not anything scrapes `/metrics`, so they work identically
// in a local `bun run dev` with no Prometheus.
// ---------------------------------------------------------------------------

/**
 * LLM tokens processed. `kind` splits input into fresh / cache_read / cache_write
 * (the cache-cost story: a large `cache_read` next to small `fresh` is the
 * cheap-re-read pattern; a spike in `cache_write` is a prefix re-write).
 */
export const llmTokensTotal = new Counter({
  name: "nb_llm_tokens_total",
  help: "LLM tokens processed, by direction, cache kind, call source, and model.",
  labelNames: ["direction", "kind", "source", "model"] as const,
  registers: [metricsRegistry],
});

/** LLM calls, by source (main loop vs forked fast-slot) and model. */
export const llmCallsTotal = new Counter({
  name: "nb_llm_calls_total",
  help: "LLM calls, by source and model.",
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

/** Tools promoted into the active set (progressive-disclosure discovery). */
export const toolPromotionsTotal = new Counter({
  name: "nb_tool_promotions_total",
  help: "Tools promoted into the active set (progressive disclosure).",
  registers: [metricsRegistry],
});

/** Token usage subset needed for metrics — a structural slice of `TokenUsage`. */
interface UsageForMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Record one LLM call's usage: a call increment plus token counts split into
 * fresh / cache_read / cache_write / output. Called for both the main agentic
 * loop (`source: "main"`) and the forked fast-slot calls (`compaction` /
 * `title` / `briefing`), so fleet token spend is attributable by origin.
 */
export function recordLlmUsage(source: string, model: string, usage: UsageForMetrics): void {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(usage.inputTokens - cacheRead - cacheWrite, 0);

  llmCallsTotal.inc({ source, model });
  if (fresh > 0) llmTokensTotal.inc({ direction: "input", kind: "fresh", source, model }, fresh);
  if (cacheRead > 0)
    llmTokensTotal.inc({ direction: "input", kind: "cache_read", source, model }, cacheRead);
  if (cacheWrite > 0)
    llmTokensTotal.inc({ direction: "input", kind: "cache_write", source, model }, cacheWrite);
  if (usage.outputTokens > 0)
    llmTokensTotal.inc({ direction: "output", kind: "text", source, model }, usage.outputTokens);
}
