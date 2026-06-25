import {
  llmErrorsTotal,
  llmRequestDurationSeconds,
  recordBundleCrash,
  recordLlmUsage,
  toolCallsTotal,
  toolPromotionsTotal,
} from "../api/metrics.ts";
import type { EngineEvent, EventSink } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import type { TokenUsage } from "../usage/types.ts";

/**
 * Defensive cap on in-flight runs tracked for promoted-but-never-called. A run
 * is dropped on its `run.done`/`run.error`; this only bounds the leak from a
 * run whose terminator never fires (e.g. process death mid-run).
 */
export const MAX_TRACKED_RUNS = 1000;

/**
 * Translates engine events into Prometheus counters (see `api/metrics.ts`).
 *
 * Observe-only and process-local: it only increments in-memory counters, so it
 * is always safe to wire in — in-cluster the counters are scraped per tenant
 * pod, and in a local `bun run dev` they simply accumulate, unscraped, with no
 * Prometheus or k8s required.
 *
 * Covers the main agentic loop. The forked fast-slot calls (compaction
 * summarizer, auto-title, briefing) run outside the engine and emit no
 * `llm.done`, so their usage is recorded at their own call sites via
 * `recordLlmUsage(source, ...)`.
 *
 * Promotions are counted at run end, not at promote time, so each is labeled by
 * whether the model actually called the promoted tool — the wasted-promotion
 * signal. State is keyed by `runId` and dropped on the run terminator.
 */
export class MetricsEventSink implements EventSink {
  private readonly runs = new Map<string, { promoted: Set<string>; called: Set<string> }>();

  emit(event: EngineEvent): void {
    const { type, data } = event;
    switch (type) {
      case "llm.done": {
        const model = (data.model as string) ?? "unknown";
        const usage = data.usage as TokenUsage | undefined;
        if (usage) recordLlmUsage("main", model, usage);
        // Per-call latency for the p99 alert. `llmMs` is set on every llm.done
        // (engine measures it around the provider call); guard the type anyway.
        const llmMs = data.llmMs;
        if (typeof llmMs === "number") {
          llmRequestDurationSeconds.observe({ source: "main", model }, llmMs / 1000);
        }
        break;
      }
      case "llm.error": {
        // Terminal provider failure after retries (aborts excluded upstream).
        // Pairs with nb_llm_calls_total to form the error rate.
        llmErrorsTotal.inc({ source: "main", model: (data.model as string) ?? "unknown" });
        break;
      }
      case "tool.done": {
        toolCallsTotal.inc({ ok: data.ok === false ? "false" : "true" });
        const runId = data.runId as string | undefined;
        const name = data.name as string | undefined;
        if (runId && name) this.run(runId).called.add(name);
        break;
      }
      case "tool.promoted": {
        const runId = data.runId as string | undefined;
        const toolName = data.toolName as string | undefined;
        if (runId && toolName) this.run(runId).promoted.add(toolName);
        break;
      }
      case "run.done":
      case "run.error": {
        // The HealthMonitor reports bundle/connector liveness via `run.error`
        // with a nested `event` discriminator (bundle.crashed / restarting /
        // dead / recovered) and no runId. `bundle.crashed` is the canonical
        // crash signal: the lifecycle's own `bundle.crashed` event *type* is
        // emitted only by `recordCrash`, which currently has no callers, so
        // counting here is 1:1 with a real detection and can't double-count.
        // (If `recordCrash` is ever wired as the canonical emit, move the count
        // there and drop it here.) Counts once per HealthMonitor sweep a source
        // is found down — the per-sweep cadence the alert thresholds on.
        if (type === "run.error" && data.event === "bundle.crashed") {
          recordBundleCrash(data.source as string | undefined, data.remote === true);
        }
        this.finalizeRun(data.runId as string | undefined);
        break;
      }
      default:
        break;
    }
  }

  /** Get (or lazily create) the per-run promoted/called tracking state. */
  private run(runId: string): { promoted: Set<string>; called: Set<string> } {
    let r = this.runs.get(runId);
    if (!r) {
      r = { promoted: new Set(), called: new Set() };
      this.runs.set(runId, r);
      if (this.runs.size > MAX_TRACKED_RUNS) {
        const oldest = this.runs.keys().next().value;
        if (oldest !== undefined) {
          this.runs.delete(oldest);
          // Should be unreachable in practice (run terminators always fire, so
          // tracked runs drain). Surface it rather than dropping the evicted
          // run's promotion samples silently — a leak this big means a
          // regressed terminator, not normal load.
          log.warn(
            `[metrics] tracked-run cap (${MAX_TRACKED_RUNS}) exceeded; dropping run ${oldest} — its promotion metrics are lost. A run terminator (run.done/run.error) likely failed to fire.`,
          );
        }
      }
    }
    return r;
  }

  /** Emit one promotion sample per promoted tool, labeled used=true|false. */
  private finalizeRun(runId: string | undefined): void {
    if (!runId) return;
    const r = this.runs.get(runId);
    if (!r) return;
    for (const tool of r.promoted) {
      toolPromotionsTotal.inc({ used: r.called.has(tool) ? "true" : "false" });
    }
    this.runs.delete(runId);
  }
}
