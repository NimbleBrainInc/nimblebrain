import type { EngineEvent, EventSink } from "../engine/types.ts";

/** Logs engine events to stderr. Useful for CLI/development. */
export class ConsoleEventSink implements EventSink {
  emit(event: EngineEvent): void {
    switch (event.type) {
      case "run.start":
        console.error("[engine] run started");
        break;
      case "text.delta":
        // Don't log text deltas — too noisy
        break;
      case "tool.start":
        console.error(
          `[engine] tool.start: ${event.data.name}${event.data.resourceUri ? ` (ui: ${event.data.resourceUri})` : ""}`,
        );
        break;
      case "tool.done":
        console.error(
          `[engine] tool.done: ${event.data.name} (${event.data.ok ? "ok" : "error"}, ${Math.round(event.data.ms as number)}ms)`,
        );
        break;
      case "llm.done":
        console.error(
          `[engine] llm.done: ${event.data.model} (${event.data.inputTokens} in, ${event.data.outputTokens} out, ${Math.round(event.data.llmMs as number)}ms)`,
        );
        break;
      case "run.done":
        console.error(`[engine] run done: ${event.data.stopReason}`);
        break;
      case "run.error":
        console.error(`[engine] error: ${event.data.error}`);
        break;
    }
  }
}
