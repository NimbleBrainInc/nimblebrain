import type { EngineEvent, EventSink } from "./types.ts";

/**
 * Lightweight per-run metrics collector.
 * Captures cache tokens and LLM latency from llm.done events.
 * Create a new instance for each chat turn.
 */
export class RunMetricsCollector implements EventSink {
  cacheReadTokens = 0;
  totalLlmMs = 0;

  emit(event: EngineEvent): void {
    if (event.type === "llm.done") {
      this.cacheReadTokens += (event.data.cacheReadTokens as number) ?? 0;
      this.totalLlmMs += (event.data.llmMs as number) ?? 0;
    }
  }
}
