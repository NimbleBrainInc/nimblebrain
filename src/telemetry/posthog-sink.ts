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

/** Events that are either skipped outright or only used for accumulation. */
const SKIP_EVENTS = new Set([
  "text.delta",
  "tool.start",
  "tool.progress",
  "task.input_required",
  "data.changed",
  "config.changed",
]);

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

  constructor(telemetry: TelemetryManager) {
    this.telemetry = telemetry;
  }

  emit(event: EngineEvent): void {
    if (!this.telemetry.isEnabled()) return;

    const { type, data } = event;
    const runId = data.runId as string | undefined;

    // --- Accumulation (before skip check) ---

    if (type === "llm.done" && runId) {
      const metrics = this.runs.get(runId);
      if (metrics) {
        metrics.iterations++;
        metrics.llmMs += (data.llmMs as number) ?? 0;
        metrics.cacheTokens += (data.cacheReadTokens as number) ?? 0;
        metrics.inputTokens += (data.inputTokens as number) ?? 0;
        metrics.outputTokens += (data.outputTokens as number) ?? 0;
      }
      return;
    }

    if (type === "tool.done" && runId) {
      const metrics = this.runs.get(runId);
      if (metrics) {
        metrics.toolCalls++;
        metrics.toolMs += (data.ms as number) ?? 0;
      }
      return;
    }

    // --- Skip noisy events ---

    if (SKIP_EVENTS.has(type)) return;

    // --- Event-specific captures ---

    if (type === "run.start") {
      const metrics = createRunMetrics();
      if (runId) this.runs.set(runId, metrics);

      const tools = data.toolNames as string[] | undefined;
      this.telemetry.capture("agent.chat_started", {
        has_skill: Boolean(data.skill),
        tool_count: tools ? tools.length : 0,
        is_resume: Boolean(data.isResume),
      });
      return;
    }

    if (type === "run.done") {
      const metrics = runId ? this.runs.get(runId) : undefined;
      const totalMs = metrics ? Date.now() - metrics.startedAt : 0;

      this.telemetry.capture("agent.chat_completed", {
        iterations: metrics?.iterations ?? 0,
        tool_calls: metrics?.toolCalls ?? 0,
        stop_reason: data.stopReason as string,
        llm_latency_ms: metrics?.llmMs ?? 0,
        tool_latency_ms: metrics?.toolMs ?? 0,
        total_ms: totalMs,
        input_tokens: (data.inputTokens as number) ?? 0,
        output_tokens: (data.outputTokens as number) ?? 0,
      });

      if (runId) this.runs.delete(runId);
      return;
    }

    if (type === "run.error") {
      const error = data.error as { constructor?: { name?: string }; code?: string } | undefined;
      const errorType = error?.constructor?.name ?? "Unknown";
      const props: Record<string, unknown> = { error_type: errorType };
      if (error && typeof (error as Record<string, unknown>).code === "string") {
        props.error_code = (error as Record<string, unknown>).code;
      }

      this.telemetry.capture("agent.error", props);

      if (runId) this.runs.delete(runId);
      return;
    }

    if (type === "bundle.installed") {
      const source = detectSource(data);
      this.telemetry.capture("bundle.installed", {
        source,
        has_ui: Boolean(data.ui),
        trust_score: (data.trustScore as number) ?? 0,
      });
      return;
    }

    if (type === "bundle.uninstalled") {
      this.telemetry.capture("bundle.uninstalled", {
        source: detectSource(data),
      });
      return;
    }

    if (type === "bundle.crashed") {
      this.telemetry.capture("bundle.crashed", {
        source: detectSource(data),
        uptime_ms: (data.uptimeMs as number) ?? 0,
        restart_count: (data.restartCount as number) ?? 0,
      });
      return;
    }

    if (type === "bundle.recovered") {
      this.telemetry.capture("bundle.recovered", {
        source: detectSource(data),
        downtime_ms: (data.downtimeMs as number) ?? 0,
      });
      return;
    }

    if (type === "bundle.dead") {
      this.telemetry.capture("bundle.dead", {
        source: detectSource(data),
        restart_count: (data.restartCount as number) ?? 0,
      });
      return;
    }
  }
}
