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
 *    runtime, the native engine included, reads this one back. A segment cut
 *    at a tool call is `transcriptOnly`: usage is known only when the turn
 *    ends, so it is not a model call and nothing counts or prices it.
 *  - Tool calls are recorded from the tool projection, which dispatched them,
 *    not from the agent's `tool_call` updates, which describe them.
 *  - Usage is priced per model call when the driver reads the agent's calls
 *    (`AcpOutcome.calls`): each loop call is its own `llm.done`, as the engine
 *    records them, and each summary is billed as the door bills a fold. An agent
 *    that reports only ACP's turn total is priced as one call.
 */

import type * as acp from "@agentclientprotocol/sdk/unstable";
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import type {
  EngineResult,
  FinishReason,
  StopReason,
  ToolCall,
  ToolCallRecord,
} from "../../engine/types.ts";
import { log } from "../../observability/log.ts";
import { addUsage, emptyUsage, type TokenUsage } from "../../usage/types.ts";
import type { ResolvedRun, RunIO } from "../types.ts";
import type { AcpOutcome } from "./driver.ts";

export interface AcpRunRecorder {
  start(): void;
  /** One `session/update` from the agent. */
  update(update: acp.SessionUpdate): void;
  /** The tool projection is about to run a call: close the segment it ends. */
  callStarting(call: ToolCall): void;
  /** The turn ended with a response, and what the driver read from it. */
  finish(
    response: acp.PromptResponse,
    outcome: AcpOutcome,
    toolCalls: ToolCallRecord[],
  ): EngineResult;
  /** The turn was cancelled. */
  cancelled(): void;
  /** The turn failed. */
  failed(err: unknown): void;
  /** Whether the run's end (`run.done` or `run.error`) has been recorded. */
  ended(): boolean;
}

export function createAcpRunRecorder(
  run: ResolvedRun,
  io: Pick<RunIO, "events" | "billSummary">,
): AcpRunRecorder {
  const { events } = io;
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
    callModel: string = model,
  ) => {
    segments++;
    events.emit({
      type: "llm.done",
      data: {
        runId,
        model: callModel,
        content,
        usage,
        llmMs: 0,
        estimatedInputTokens: 0,
        finishReason: finish,
      },
    });
  };

  // A segment cut before the turn's usage is known: replayed, but not a model
  // call, so usage consumers neither count nor price it.
  const emitTranscript = (content: LanguageModelV4Content[], finish: FinishReason) => {
    segments++;
    events.emit({
      type: "llm.done",
      data: {
        runId,
        model,
        content,
        usage: emptyUsage(),
        llmMs: 0,
        estimatedInputTokens: 0,
        finishReason: finish,
        transcriptOnly: true,
      },
    });
  };

  // A model call's usage on its own, for a call whose content an earlier
  // segment already recorded: priced, but no segment of its own. Empty content
  // with finish `stop` replays as nothing (`reconstructMessages`); any other
  // finish would replay as a truncation marker.
  const emitUsage = (callModel: string, usage: TokenUsage) => {
    events.emit({
      type: "llm.done",
      data: {
        runId,
        model: callModel,
        content: [],
        usage,
        llmMs: 0,
        estimatedInputTokens: 0,
        finishReason: "stop",
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

  // The turn's closing segment and its usage: each reported model call priced
  // on its own, as the engine records them, or ACP's turn total on the last
  // segment. Summaries are billed as the door bills a fold.
  const recordUsage = (
    response: acp.PromptResponse,
    outcome: AcpOutcome,
    content: LanguageModelV4Content[],
    finishReason: FinishReason,
  ): { usage: TokenUsage; iterations: number } => {
    const reported = outcome.calls ?? [];
    for (const call of reported) {
      if (call.purpose === "summary") io.billSummary(call.model, call.usage, 0);
    }
    const loopCalls = reported.filter((c) => c.purpose === "turn");
    const last = loopCalls.at(-1);
    if (last) {
      for (const call of loopCalls.slice(0, -1)) emitUsage(call.model, call.usage);
      emitSegment(content, last.usage, finishReason, last.model);
      return { usage: sumUsage(loopCalls), iterations: loopCalls.length };
    }
    const usage = usageOf(response);
    if (content.length > 0 || segments === 0 || usage.inputTokens + usage.outputTokens > 0) {
      emitSegment(content, usage, finishReason);
    }
    return { usage, iterations: segments };
  };

  const done = (stopReason: StopReason, iterations = segments) => {
    ended = true;
    events.emit({
      type: "run.done",
      data: { runId, stopReason, iterations, totalMs: performance.now() - started },
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
      emitTranscript(
        [
          ...takeText(),
          {
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.name,
            input: JSON.stringify(call.input),
          },
        ],
        "tool-calls",
      );
    },

    finish(response, outcome, toolCalls) {
      const stopReason = outcome.stopReason ?? stopReasonOf(response.stopReason);
      const finishReason = finishReasonOf(response.stopReason);
      const { usage, iterations } = recordUsage(response, outcome, takeText(), finishReason);
      done(stopReason, iterations);
      return {
        output,
        toolCalls,
        iterations,
        usage,
        llmMs: performance.now() - started,
        stopReason,
        finishReason,
        finishReasonRaw: response.stopReason,
      };
    },

    cancelled() {
      const content = takeText();
      if (content.length > 0) emitTranscript(content, "other");
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

/** ACP's stop reason in the engine's terms, for an agent that reports none of its own. */
function stopReasonOf(stop: acp.StopReason): StopReason {
  switch (stop) {
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

function sumUsage(calls: { usage: TokenUsage }[]): TokenUsage {
  const total = emptyUsage();
  for (const call of calls) addUsage(total, call.usage);
  return total;
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
