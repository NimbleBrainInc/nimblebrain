import { dispatchEngineEvent, type EngineEventHandlers } from "../engine/event-dispatch.ts";
import type {
  ConnectorInstalledPayload,
  LlmDonePayload,
  RunDonePayload,
  RunErrorPayload,
  RunStartPayload,
  ToolDonePayload,
} from "../engine/schemas/events.ts";
import type { EngineEvent, EventSink } from "../engine/types.ts";
import type { TelemetryManager } from "./manager.ts";

/** Per-run metric accumulator. */
interface RunMetrics {
  startedAt: number;
  iterations: number;
  toolCalls: number;
  llmMs: number;
  toolMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
}

function createRunMetrics(): RunMetrics {
  return {
    startedAt: Date.now(),
    iterations: 0,
    toolCalls: 0,
    llmMs: 0,
    toolMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
  };
}

/**
 * EventSink that forwards anonymized, aggregate telemetry to PostHog
 * via TelemetryManager. Accumulates per-run metrics keyed by runId,
 * supporting concurrent runs without cross-contamination.
 *
 * CRITICAL: Never captures connector names, paths, tool names, error messages,
 * or any string that could contain PII.
 */
export class PostHogEventSink implements EventSink {
  private telemetry: TelemetryManager;
  private runs: Map<string, RunMetrics> = new Map();

  /**
   * Dispatch table keyed by engine event type. Accumulation events fold into
   * per-run metrics; capture events emit to PostHog. Event types absent here
   * (deltas, tool.start/progress, config.changed, and anything unknown)
   * are intentionally ignored.
   */
  private readonly handlers: EngineEventHandlers = {
    "llm.done": (data) => this.accumulateLlm(data),
    "tool.done": (data) => this.accumulateTool(data),
    "run.start": (data) => this.captureRunStart(data),
    "run.done": (data) => this.captureRunDone(data),
    "run.error": (data) => this.captureRunError(data),
    "connector.installed": (data) => this.captureConnectorInstalled(data),
    "connector.uninstalled": () => this.captureConnectorUninstalled(),
  };

  constructor(telemetry: TelemetryManager) {
    this.telemetry = telemetry;
  }

  emit(event: EngineEvent): void {
    if (!this.telemetry.isEnabled()) return;

    dispatchEngineEvent(this.handlers, event);
  }

  /** Fold an llm.done event's iteration count, latency, and token usage into the run's metrics. */
  private accumulateLlm(data: LlmDonePayload): void {
    const metrics = this.runs.get(data.runId);
    if (!metrics) return;

    metrics.iterations++;
    metrics.llmMs += data.llmMs;
    metrics.cacheTokens += data.usage.cacheReadTokens ?? 0;
    metrics.inputTokens += data.usage.inputTokens;
    metrics.outputTokens += data.usage.outputTokens;
  }

  /** Fold a tool.done event's call count and latency into the run's metrics. */
  private accumulateTool(data: ToolDonePayload): void {
    const metrics = this.runs.get(data.runId);
    if (!metrics) return;

    metrics.toolCalls++;
    metrics.toolMs += data.ms;
  }

  /** Start a per-run metrics accumulator and capture the chat-started event. */
  private captureRunStart(data: RunStartPayload): void {
    this.runs.set(data.runId, createRunMetrics());
    this.telemetry.capture("agent.chat_started", { tool_count: data.toolNames.length });
  }

  /** Capture the chat-completed event from the accumulated run metrics, then drop the accumulator. */
  private captureRunDone(data: RunDonePayload): void {
    const metrics = this.runs.get(data.runId);
    const totalMs = metrics ? Date.now() - metrics.startedAt : 0;

    // run.done event carries no token counts (it never has) — read the
    // run-level totals from the per-run metrics accumulator.
    this.telemetry.capture("agent.chat_completed", {
      iterations: metrics?.iterations ?? 0,
      tool_calls: metrics?.toolCalls ?? 0,
      stop_reason: data.stopReason,
      llm_latency_ms: metrics?.llmMs ?? 0,
      tool_latency_ms: metrics?.toolMs ?? 0,
      total_ms: totalMs,
      input_tokens: metrics?.inputTokens ?? 0,
      output_tokens: metrics?.outputTokens ?? 0,
      cache_tokens: metrics?.cacheTokens ?? 0,
    });

    this.runs.delete(data.runId);
  }

  /**
   * Capture an agent.error with the error's class name, then drop the
   * accumulator. Never the message: it can carry user content.
   */
  private captureRunError(data: RunErrorPayload): void {
    this.telemetry.capture("agent.error", { error_type: data.type });
    this.runs.delete(data.runId);
  }

  /** Capture connector.installed with UI presence. Every connector is remote. */
  private captureConnectorInstalled(data: ConnectorInstalledPayload): void {
    this.telemetry.capture("connector.installed", {
      source: "remote",
      has_ui: Boolean(data.ui),
    });
  }

  /** Capture connector.uninstalled. */
  private captureConnectorUninstalled(): void {
    this.telemetry.capture("connector.uninstalled", { source: "remote" });
  }
}
