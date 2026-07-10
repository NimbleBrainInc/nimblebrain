import {
  llmErrorsTotal,
  llmRequestDurationSeconds,
  llmTtftSeconds,
  recordBundleCrash,
  recordLlmUsage,
  toolCallsTotal,
  toolPromotionsTotal,
} from "../api/metrics.ts";
import type { EngineEvent, EngineEventType, EventSink } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import type { TokenUsage } from "../usage/types.ts";

/** Payload envelope carried by every engine event (`EngineEvent.data`). */
type EventData = EngineEvent["data"];

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

  /** Per-event-type metric handlers; event types with no metric are absent. */
  private readonly handlers: Partial<Record<EngineEventType, (data: EventData) => void>> = {
    "llm.done": (data) => this.onLlmDone(data),
    "llm.error": (data) => this.onLlmError(data),
    "tool.done": (data) => this.onToolDone(data),
    "tool.promoted": (data) => this.onToolPromoted(data),
    "run.done": (data) => this.onRunDone(data),
    "run.error": (data) => this.onRunError(data),
  };

  emit(event: EngineEvent): void {
    this.handlers[event.type]?.(event.data);
  }

  /** Record main-loop LLM usage and per-call latency for a completed provider call. */
  private onLlmDone(data: EventData): void {
    const model = (data.model as string) ?? "unknown";
    const usage = data.usage as TokenUsage | undefined;
    if (usage) recordLlmUsage("main", model, usage);
    // Per-call latency for the p99 alert. `llmMs` is set on every llm.done
    // (engine measures it around the provider call); guard the type anyway.
    const llmMs = data.llmMs;
    if (typeof llmMs === "number") {
      llmRequestDurationSeconds.observe({ source: "main", model }, llmMs / 1000);
    }
    // Time-to-first-token (connect + prefill), the prefill-vs-decode
    // discriminator. Absent when the call emitted no output part — skip rather
    // than record a misleading 0.
    const ttftMs = data.ttftMs;
    if (typeof ttftMs === "number") {
      llmTtftSeconds.observe({ source: "main", model }, ttftMs / 1000);
    }
  }

  /** Count a terminal provider failure toward the LLM error rate. */
  private onLlmError(data: EventData): void {
    // Terminal provider failure after retries (aborts excluded upstream).
    // Pairs with nb_llm_calls_total to form the error rate.
    llmErrorsTotal.inc({ source: "main", model: (data.model as string) ?? "unknown" });
  }

  /** Count the tool call and note it as called for its run's promotion tracking. */
  private onToolDone(data: EventData): void {
    toolCallsTotal.inc({ ok: data.ok === false ? "false" : "true" });
    const runId = data.runId as string | undefined;
    const name = data.name as string | undefined;
    if (runId && name) this.run(runId).called.add(name);
  }

  /** Track a tool promotion so run end can label it used-or-not. */
  private onToolPromoted(data: EventData): void {
    const runId = data.runId as string | undefined;
    const toolName = data.toolName as string | undefined;
    if (runId && toolName) this.run(runId).promoted.add(toolName);
  }

  /** Flush the run's promotion samples on normal completion. */
  private onRunDone(data: EventData): void {
    this.finalizeRun(data.runId as string | undefined);
  }

  /** Record a bundle crash when signaled, then flush the run's promotion samples. */
  private onRunError(data: EventData): void {
    // The HealthMonitor reports bundle/connector liveness via `run.error`
    // with a nested `event` discriminator (bundle.crashed / restarting /
    // cooldown / recovered) and no runId. `bundle.crashed` is the canonical
    // crash signal and counting here is 1:1 with a real detection — counts
    // once per HealthMonitor sweep a source is found down, the per-sweep
    // cadence the alert thresholds on.
    if (data.event === "bundle.crashed") {
      recordBundleCrash(data.source as string | undefined, data.remote === true);
    }
    this.finalizeRun(data.runId as string | undefined);
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
