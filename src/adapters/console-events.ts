import type { EngineEvent, EngineEventType, EventSink } from "../engine/types.ts";

/** Logs the start of an engine run. */
function logRunStart(): void {
  console.error("[engine] run started");
}

/** Logs a tool invocation, noting the UI resource when the tool declares one. */
function logToolStart(event: EngineEvent): void {
  console.error(
    `[engine] tool.start: ${event.data.name}${event.data.resourceUri ? ` (ui: ${event.data.resourceUri})` : ""}`,
  );
}

/** Logs a tool completion with its ok/error status and duration. */
function logToolDone(event: EngineEvent): void {
  console.error(
    `[engine] tool.done: ${event.data.name} (${event.data.ok ? "ok" : "error"}, ${Math.round(event.data.ms as number)}ms)`,
  );
}

/** Logs an LLM call completion with token usage and latency. */
function logLlmDone(event: EngineEvent): void {
  const usage = (event.data.usage ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
  };
  // Append TTFT only when present — an empty completion has no first-output
  // timestamp, and `Math.round(undefined)` would print `NaNms ttft`.
  const ttftMs = event.data.ttftMs;
  const ttft = typeof ttftMs === "number" ? `, ${Math.round(ttftMs)}ms ttft` : "";
  console.error(
    `[engine] llm.done: ${event.data.model} (${usage.inputTokens ?? 0} in, ${usage.outputTokens ?? 0} out, ${Math.round(event.data.llmMs as number)}ms${ttft})`,
  );
}

/** Logs the run's terminal stop reason. */
function logRunDone(event: EngineEvent): void {
  console.error(`[engine] run done: ${event.data.stopReason}`);
}

/** Logs an engine-run failure, or — for a reused lifecycle event — a source restart. */
function logRunError(event: EngineEvent): void {
  // `run.error` is overloaded: genuine engine-run failures carry an `error`
  // message, while McpSource lifecycle events reuse the type with an `event`
  // discriminator. `source.restarted` is a *successful* crash-recovery (no
  // error field) — render it as info rather than a misleading "error: undefined".
  if (event.data.event === "source.restarted") {
    console.error(`[engine] source restarted: ${event.data.source}`);
    return;
  }
  // Never print a bare `undefined`: fall back to the event discriminator
  // (e.g. "source.crashed") and finally a generic label.
  const message = event.data.error ?? event.data.event ?? "unknown error";
  console.error(`[engine] error: ${message}`);
  // Render bundle stderr tail (if any) immediately after the error line,
  // dimmed and indented so it's visually nested under the crash. Issue #116:
  // keeps the cause-of-death visible without reproducing the failure outside NB.
  const tail = event.data.stderrTail;
  if (typeof tail === "string" && tail.length > 0) {
    for (const line of tail.split("\n")) {
      console.error(`\x1b[2m  | ${line}\x1b[0m`);
    }
  }
}

/**
 * Per-event-type log handlers. Event types absent from this map are
 * intentionally not logged — e.g. `text.delta`, which is too noisy.
 */
const HANDLERS: Partial<Record<EngineEventType, (event: EngineEvent) => void>> = {
  "run.start": logRunStart,
  "tool.start": logToolStart,
  "tool.done": logToolDone,
  "llm.done": logLlmDone,
  "run.done": logRunDone,
  "run.error": logRunError,
};

/** Logs engine events to stderr. Useful for CLI/development. */
export class ConsoleEventSink implements EventSink {
  emit(event: EngineEvent): void {
    HANDLERS[event.type]?.(event);
  }
}
