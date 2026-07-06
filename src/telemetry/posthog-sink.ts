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
 * Detect bundle source from event data.
 * - Has a `url` property -> "remote"
 * - Name starts with "@" -> "mpak"
 * - Otherwise -> "local"
 */
function detectSource(data: Record<string, unknown>): "mpak" | "local" | "remote" {
  if (typeof data.url === "string") return "remote";
  const name = data.name as string | undefined;
  if (name?.startsWith("@")) return "mpak";
  return "local";
}

/** Handles one engine event: accumulates per-run metrics or captures a telemetry event. */
type EventHandler = (data: Record<string, unknown>, runId: string | undefined) => void;

/**
 * EventSink that forwards anonymized, aggregate telemetry to PostHog
 * via TelemetryManager. Accumulates per-run metrics keyed by runId,
 * supporting concurrent runs without cross-contamination.
 *
 * CRITICAL: Never captures bundle names, paths, tool names, error messages,
 * or any string that could contain PII.
 */
export class PostHogEventSink implements EventSink {
  private telemetry: TelemetryManager;
  private runs: Map<string, RunMetrics> = new Map();

  /**
   * Dispatch table keyed by engine event type. Accumulation events fold into
   * per-run metrics; capture events emit to PostHog. Event types absent here
   * (deltas, tool.start/progress, config/data.changed, and anything unknown)
   * are intentionally ignored.
   */
  private readonly handlers: Record<string, EventHandler> = {
    "llm.done": (data, runId) => this.accumulateLlm(data, runId),
    "tool.done": (data, runId) => this.accumulateTool(data, runId),
    "run.start": (data, runId) => this.captureRunStart(data, runId),
    "run.done": (data, runId) => this.captureRunDone(data, runId),
    "run.error": (data, runId) => this.captureRunError(data, runId),
    "bundle.installed": (data) => this.captureBundleInstalled(data),
    "bundle.uninstalled": (data) => this.captureBundleUninstalled(data),
  };

  constructor(telemetry: TelemetryManager) {
    this.telemetry = telemetry;
  }

  emit(event: EngineEvent): void {
    if (!this.telemetry.isEnabled()) return;

    const { type, data } = event;
    const runId = data.runId as string | undefined;
    this.handlers[type]?.(data, runId);
  }

  /** Fold an llm.done event's iteration count, latency, and token usage into the run's metrics. */
  private accumulateLlm(data: Record<string, unknown>, runId: string | undefined): void {
    if (!runId) return;
    const metrics = this.runs.get(runId);
    if (!metrics) return;

    metrics.iterations++;
    metrics.llmMs += (data.llmMs as number) ?? 0;
    // Token counts live under `data.usage` (canonical TokenUsage),
    // not as flat siblings — mirrored from the engine's llm.done
    // emission in src/engine/engine.ts.
    const usage = (data.usage ?? {}) as {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
    };
    metrics.cacheTokens += usage.cacheReadTokens ?? 0;
    metrics.inputTokens += usage.inputTokens ?? 0;
    metrics.outputTokens += usage.outputTokens ?? 0;
  }

  /** Fold a tool.done event's call count and latency into the run's metrics. */
  private accumulateTool(data: Record<string, unknown>, runId: string | undefined): void {
    if (!runId) return;
    const metrics = this.runs.get(runId);
    if (!metrics) return;

    metrics.toolCalls++;
    metrics.toolMs += (data.ms as number) ?? 0;
  }

  /** Start a per-run metrics accumulator and capture the chat-started event. */
  private captureRunStart(data: Record<string, unknown>, runId: string | undefined): void {
    const metrics = createRunMetrics();
    if (runId) this.runs.set(runId, metrics);

    const tools = data.toolNames as string[] | undefined;
    this.telemetry.capture("agent.chat_started", {
      has_skill: Boolean(data.skill),
      tool_count: tools ? tools.length : 0,
      is_resume: Boolean(data.isResume),
    });
  }

  /** Capture the chat-completed event from the accumulated run metrics, then drop the accumulator. */
  private captureRunDone(data: Record<string, unknown>, runId: string | undefined): void {
    const metrics = runId ? this.runs.get(runId) : undefined;
    const totalMs = metrics ? Date.now() - metrics.startedAt : 0;

    // run.done event carries no token counts (it never has) — read the
    // run-level totals from the per-run metrics accumulator.
    this.telemetry.capture("agent.chat_completed", {
      iterations: metrics?.iterations ?? 0,
      tool_calls: metrics?.toolCalls ?? 0,
      stop_reason: data.stopReason as string,
      llm_latency_ms: metrics?.llmMs ?? 0,
      tool_latency_ms: metrics?.toolMs ?? 0,
      total_ms: totalMs,
      input_tokens: metrics?.inputTokens ?? 0,
      output_tokens: metrics?.outputTokens ?? 0,
      cache_tokens: metrics?.cacheTokens ?? 0,
    });

    if (runId) this.runs.delete(runId);
  }

  /** Capture an agent.error with the error's type and optional code, then drop the accumulator. */
  private captureRunError(data: Record<string, unknown>, runId: string | undefined): void {
    const error = data.error as { constructor?: { name?: string }; code?: string } | undefined;
    const errorType = error?.constructor?.name ?? "Unknown";
    const props: Record<string, unknown> = { error_type: errorType };
    if (error && typeof (error as Record<string, unknown>).code === "string") {
      props.error_code = (error as Record<string, unknown>).code;
    }

    this.telemetry.capture("agent.error", props);

    if (runId) this.runs.delete(runId);
  }

  /** Capture bundle.installed with detected source, UI presence, and trust score. */
  private captureBundleInstalled(data: Record<string, unknown>): void {
    const source = detectSource(data);
    this.telemetry.capture("bundle.installed", {
      source,
      has_ui: Boolean(data.ui),
      trust_score: (data.trustScore as number) ?? 0,
    });
  }

  /** Capture bundle.uninstalled with the detected source. */
  private captureBundleUninstalled(data: Record<string, unknown>): void {
    this.telemetry.capture("bundle.uninstalled", {
      source: detectSource(data),
    });
  }
}
