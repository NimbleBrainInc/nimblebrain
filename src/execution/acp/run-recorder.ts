/**
 * An ACP turn, recorded in the engine's own event vocabulary.
 *
 * The conversation log and the browser stream read `run.*`, `text.delta`,
 * `llm.done` and `tool.*` events and nothing else. The recorder emits exactly
 * those for an agent the engine never saw, stamped with the door's run id, so
 * neither can tell which runtime ran the turn:
 *
 *  - Message chunks stream as `text.delta`. Thought chunks stream as
 *    `reasoning.delta` and are never persisted: an external agent's private
 *    reasoning is not conversation content.
 *  - A turn is cut into segments at each tool call, and each segment is one
 *    `llm.done` holding its text and the `tool-call` that ends it. That is the
 *    shape history replays from (`reconstructMessages`), so a later turn on any
 *    runtime, the native engine included, reads this one back.
 *  - Tool calls are recorded from the tool projection, which dispatched them,
 *    not from the agent's `tool_call` updates, which describe them.
 */

import type * as acp from "@agentclientprotocol/sdk/unstable";
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import type {
  EngineResult,
  EventSink,
  FinishReason,
  StopReason,
  ToolCall,
  ToolCallRecord,
} from "../../engine/types.ts";
import { log } from "../../observability/log.ts";
import { emptyUsage, type TokenUsage } from "../../usage/types.ts";
import type { ResolvedRun } from "../types.ts";
import { STOP_REASON_META_KEY } from "./nimblebrain-extension.ts";

const STOP_REASONS = new Set<StopReason>([
  "complete",
  "max_iterations",
  "max_input_tokens",
  "spend_limit",
  "length",
  "content_filter",
  "error",
  "other",
  "cancelled",
]);

export interface AcpRunRecorder {
  start(): void;
  /** One `session/update` from the agent. */
  update(update: acp.SessionUpdate): void;
  /** The tool projection is about to run a call: close the segment it ends. */
  callStarting(call: ToolCall): void;
  /** The turn ended with a response. */
  finish(response: acp.PromptResponse, toolCalls: ToolCallRecord[]): EngineResult;
  /** The turn was cancelled. */
  cancelled(): void;
  /** The turn failed. */
  failed(err: unknown): void;
  /** Whether the run's end (`run.done` or `run.error`) has been recorded. */
  ended(): boolean;
}

export function createAcpRunRecorder(run: ResolvedRun, events: EventSink): AcpRunRecorder {
  const { runId } = run;
  const model = run.config.model;
  const started = performance.now();
  let segmentText = "";
  // The run's whole reply, joined the way the engine joins its turns.
  let output = "";
  let segments = 0;
  let ended = false;

  const emitSegment = (
    content: LanguageModelV4Content[],
    usage: TokenUsage,
    finish: FinishReason,
  ) => {
    segments++;
    events.emit({
      type: "llm.done",
      data: {
        runId,
        model,
        content,
        usage,
        llmMs: 0,
        estimatedInputTokens: 0,
        finishReason: finish,
      },
    });
  };

  const takeText = (): LanguageModelV4Content[] => {
    if (!segmentText) return [];
    if (output.length > 0 && !output.endsWith("\n")) output += "\n\n";
    output += segmentText;
    const text: LanguageModelV4Content = { type: "text", text: segmentText };
    segmentText = "";
    return [text];
  };

  const done = (stopReason: StopReason) => {
    ended = true;
    events.emit({
      type: "run.done",
      data: { runId, stopReason, iterations: segments, totalMs: performance.now() - started },
    });
  };

  return {
    start() {
      const { messages, tools, system } = run;
      events.emit({
        type: "run.start",
        data: {
          runId,
          model,
          maxIterations: run.config.maxIterations,
          maxOutputTokens: run.config.maxOutputTokens,
          maxInputTokens: run.config.maxInputTokens,
          toolCount: tools.length,
          toolNames: tools.map((t) => t.name),
          systemPromptLength: system.length,
          systemPrompt: system,
          messageCount: messages.length,
          messageRoles: messages.map((m) => m.role),
          estimatedMessageTokens: Math.ceil(JSON.stringify(messages).length / 4),
        },
      });
      const meta = run.config.runMetadata;
      if (meta?.skillsLoaded) {
        events.emit({ type: "skills.loaded", data: { runId, ...meta.skillsLoaded } });
      }
      if (meta?.contextAssembled) {
        events.emit({ type: "context.assembled", data: { runId, ...meta.contextAssembled } });
      }
    },

    update(update) {
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (update.content.type === "text") {
            segmentText += update.content.text;
            events.emit({ type: "text.delta", data: { runId, text: update.content.text } });
          }
          return;
        case "agent_thought_chunk":
          if (update.content.type === "text") {
            events.emit({ type: "reasoning.delta", data: { runId, text: update.content.text } });
          }
          return;
        case "tool_call":
        case "tool_call_update":
          // The projection records every call that reached a NimbleBrain tool.
          // A call it never saw ran inside the agent, outside the platform.
          log.debug("execution", `[acp] agent ${update.sessionUpdate} ${update.toolCallId}`, {
            runId,
            status: update.status ?? undefined,
          });
          return;
        default:
          return;
      }
    },

    callStarting(call) {
      emitSegment(
        [
          ...takeText(),
          {
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.name,
            input: JSON.stringify(call.input),
          },
        ],
        emptyUsage(),
        "tool-calls",
      );
    },

    finish(response, toolCalls) {
      const stopReason = stopReasonOf(response);
      const usage = usageOf(response);
      const finishReason = finishReasonOf(response.stopReason);
      const content = takeText();
      // The turn's usage rides its last segment, so the run is priced once.
      if (content.length > 0 || segments === 0 || usage.inputTokens + usage.outputTokens > 0) {
        emitSegment(content, usage, finishReason);
      }
      done(stopReason);
      return {
        output,
        toolCalls,
        iterations: segments,
        usage,
        llmMs: performance.now() - started,
        stopReason,
        finishReason,
        finishReasonRaw: response.stopReason,
      };
    },

    cancelled() {
      const content = takeText();
      if (content.length > 0) emitSegment(content, emptyUsage(), "other");
      done("cancelled");
    },

    ended: () => ended,

    failed(err) {
      ended = true;
      events.emit({
        type: "run.error",
        data: {
          runId,
          error: err instanceof Error ? err.message : String(err),
          type: err instanceof Error ? err.constructor.name : typeof err,
        },
      });
    },
  };
}

/** The agent's own finer stop reason when it reports one, else ACP's mapped. */
function stopReasonOf(response: acp.PromptResponse): StopReason {
  const own = response._meta?.[STOP_REASON_META_KEY];
  if (typeof own === "string" && STOP_REASONS.has(own as StopReason)) return own as StopReason;
  switch (response.stopReason) {
    case "end_turn":
      return "complete";
    case "max_tokens":
      return "length";
    case "max_turn_requests":
      return "max_iterations";
    case "refusal":
      return "content_filter";
    case "cancelled":
      return "cancelled";
    default:
      return "other";
  }
}

function finishReasonOf(stop: acp.StopReason): FinishReason {
  switch (stop) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content-filter";
    default:
      return "other";
  }
}

/** The turn's usage, when the agent reports it (an unstable ACP field). */
function usageOf(response: acp.PromptResponse): TokenUsage {
  const u = response.usage;
  if (!u) return emptyUsage();
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cachedReadTokens ?? 0,
    cacheWriteTokens: u.cachedWriteTokens ?? 0,
    reasoningTokens: u.thoughtTokens ?? 0,
  };
}
