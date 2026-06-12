import { recordLlmUsage, toolCallsTotal, toolPromotionsTotal } from "../api/metrics.ts";
import type { EngineEvent, EventSink } from "../engine/types.ts";
import type { TokenUsage } from "../usage/types.ts";

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
 */
export class MetricsEventSink implements EventSink {
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
        break;
      }
      case "tool.promoted": {
        toolPromotionsTotal.inc();
        break;
      }
      default:
        break;
    }
  }
}
