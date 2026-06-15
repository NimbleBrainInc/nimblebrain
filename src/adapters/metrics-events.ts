import { recordLlmUsage, toolCallsTotal, toolPromotionsTotal } from "../api/metrics.ts";
import type { EngineEvent, EventSink } from "../engine/types.ts";
import type { TokenUsage } from "../usage/types.ts";

/**
 * Defensive cap on in-flight runs tracked for promoted-but-never-called. A run
 * is dropped on its `run.done`/`run.error`; this only bounds the leak from a
 * run whose terminator never fires (e.g. process death mid-run).
 */
const MAX_TRACKED_RUNS = 1000;

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
        const usage = data.usage as TokenUsage | undefined;
        if (usage) recordLlmUsage("main", (data.model as string) ?? "unknown", usage);
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
        if (oldest !== undefined) this.runs.delete(oldest);
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
