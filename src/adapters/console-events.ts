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
      case "llm.done": {
        const usage = (event.data.usage ?? {}) as {
          inputTokens?: number;
          outputTokens?: number;
        };
        console.error(
          `[engine] llm.done: ${event.data.model} (${usage.inputTokens ?? 0} in, ${usage.outputTokens ?? 0} out, ${Math.round(event.data.llmMs as number)}ms)`,
        );
        break;
      }
      case "run.done":
        console.error(`[engine] run done: ${event.data.stopReason}`);
        break;
      case "run.error": {
        console.error(`[engine] error: ${event.data.error}`);
        // Render bundle stderr tail (if any) immediately after the error
        // line, dimmed and indented so it's visually nested under the
        // crash. Issue #116: keeps the cause-of-death visible without
        // requiring the developer to reproduce the failure outside NB.
        const tail = event.data.stderrTail;
        if (typeof tail === "string" && tail.length > 0) {
          for (const line of tail.split("\n")) {
            console.error(`\x1b[2m  | ${line}\x1b[0m`);
          }
        }
        break;
      }
    }
  }
}
