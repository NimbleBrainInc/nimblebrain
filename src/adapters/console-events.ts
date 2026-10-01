import { dispatchEngineEvent, type EngineEventHandlers } from "../engine/event-dispatch.ts";
import type {
  ConnectorHealthPayload,
  LlmDonePayload,
  RunDonePayload,
  RunErrorPayload,
  ToolDonePayload,
  ToolStartPayload,
} from "../engine/schemas/events.ts";
import type { EngineEvent, EventSink } from "../engine/types.ts";

/** Logs the start of an engine run. */
function logRunStart(): void {
  console.error("[engine] run started");
}

/** Logs a tool invocation, noting the UI resource when the tool declares one. */
function logToolStart(data: ToolStartPayload): void {
  console.error(
    `[engine] tool.start: ${data.name}${data.resourceUri ? ` (ui: ${data.resourceUri})` : ""}`,
  );
}

/** Logs a tool completion with its ok/error status and duration. */
function logToolDone(data: ToolDonePayload): void {
  console.error(
    `[engine] tool.done: ${data.name} (${data.ok ? "ok" : "error"}, ${Math.round(data.ms)}ms)`,
  );
}

/** Logs an LLM call completion with token usage and latency. */
function logLlmDone(data: LlmDonePayload): void {
  // Append TTFT only when present — an empty completion has no first-output
  // timestamp, and `Math.round(undefined)` would print `NaNms ttft`.
  const ttft = data.ttftMs !== undefined ? `, ${Math.round(data.ttftMs)}ms ttft` : "";
  // The pre-flight estimate for this call, next to the provider's actual `in`.
  // Reading the two together is how estimator drift is diagnosed on a specific
  // slow call; the aggregate lives in `nb_llm_input_tokens_estimated_total`.
  const est = `, ${data.estimatedInputTokens} est`;
  console.error(
    `[engine] llm.done: ${data.model} (${data.usage.inputTokens} in, ${data.usage.outputTokens} out, ${Math.round(data.llmMs)}ms${ttft}${est})`,
  );
}

/** Logs the run's terminal stop reason. */
function logRunDone(data: RunDonePayload): void {
  console.error(`[engine] run done: ${data.stopReason}`);
}

/** Logs an engine-run failure. */
function logRunError(data: RunErrorPayload): void {
  console.error(`[engine] error: ${data.error}`);
}

/**
 * Logs a connector source's liveness change. A crash prints on the same
 * `[engine] error:` line as a run failure, which is what log queries for a
 * crashed source match; a restart is a recovery and prints as one.
 */
function logConnectorHealth(data: ConnectorHealthPayload): void {
  if (data.event === "source.restarted") {
    console.error(`[engine] source restarted: ${data.source}`);
    return;
  }
  console.error(`[engine] error: ${data.error ?? data.event}`);
}

/**
 * Per-event-type log handlers. Event types absent from this map are
 * intentionally not logged — e.g. `text.delta`, which is too noisy.
 */
const HANDLERS: EngineEventHandlers = {
  "run.start": logRunStart,
  "tool.start": logToolStart,
  "tool.done": logToolDone,
  "llm.done": logLlmDone,
  "run.done": logRunDone,
  "run.error": logRunError,
  "connector.health": logConnectorHealth,
};

/** Logs engine events to stderr. Useful for CLI/development. */
export class ConsoleEventSink implements EventSink {
  emit(event: EngineEvent): void {
    dispatchEngineEvent(HANDLERS, event);
  }
}
