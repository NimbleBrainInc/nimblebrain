/**
 * Event-to-message reconstructor.
 *
 * Converts ConversationEvent[] to StoredMessage[] — the core of the
 * "derive at read time" strategy used by history(), the LLM context
 * builder, and the web client.
 */

import type { LanguageModelV3Content } from "@ai-sdk/provider";
import { estimateCost } from "../engine/cost.ts";
import type { ConversationEvent, LlmResponseEvent, StoredMessage, ToolDoneEvent } from "./types.ts";

/**
 * Per-finishReason placeholder text for empty turns. The marker becomes
 * the assistant message body so the model sees honest context on its
 * next turn ("your last attempt was cut off") and the UI has something
 * to render (the friendly banner is keyed off `metadata.finishReason`).
 */
const TRUNCATION_MARKERS: Record<string, string> = {
  length: "[Previous turn was cut off at the output-token limit before producing visible content.]",
  "content-filter": "[Previous turn was blocked by content filtering.]",
  error: "[Previous turn ended with a model error.]",
  "tool-calls": "[Previous turn declared tool calls but emitted none.]",
  other: "[Previous turn ended without producing content.]",
  stop: "[Previous turn ended without producing content.]",
};

/**
 * Parse tool-call input from its persisted form.
 * The AI SDK V3 stream emits tool-call input as a JSON string, which gets
 * written to the JSONL event log as-is. When reconstructing messages for
 * the LLM API, input must be a parsed object (dictionary), not a string.
 */
function parseToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (input && typeof input === "object") return input as Record<string, unknown>;
  return {};
}

/** Mutable conversation metadata derived from append-only metadata events. */
export interface DerivedConversationMeta {
  title: string | null;
  visibility: "private" | "shared" | undefined;
  participants: string[] | undefined;
}

/**
 * Derive mutable conversation metadata from metadata events.
 * Scans for metadata.title, metadata.visibility, and metadata.participants events.
 * Falls back to `defaults` (from line 1) for backward compat with old files.
 */
export function deriveConversationMeta(
  events: readonly ConversationEvent[],
  defaults: DerivedConversationMeta,
): DerivedConversationMeta {
  let { title, visibility, participants } = defaults;

  for (const event of events) {
    if (event.type === "metadata.title") {
      title = event.title;
    } else if (event.type === "metadata.visibility") {
      visibility = event.visibility;
    } else if (event.type === "metadata.participants") {
      participants = event.participants;
    }
  }

  return { title, visibility, participants };
}

/** Aggregate usage metrics derived from llm.response events. */
export interface UsageMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  lastModel: string | null;
}

/**
 * Reconstruct StoredMessage[] from a chronological list of ConversationEvents.
 *
 * Algorithm:
 * 1. Walk events in order.
 * 2. `user.message` → emit a user-role StoredMessage.
 * 3. For each `run.start`→`run.done` span, process inner events:
 *    - `llm.response` with tool-call content → assistant message (tool calls in metadata)
 *    - `tool.done` events → tool-result messages (role: "tool")
 *    - `llm.response` with text content → assistant message with text
 * 4. Per-run metrics accumulate into assistant message metadata.
 */
export function reconstructMessages(events: readonly ConversationEvent[]): StoredMessage[] {
  const messages: StoredMessage[] = [];

  for (let i = 0; i < events.length; ) {
    const event = events[i];
    if (!event) {
      i++;
      continue;
    }

    if (event.type === "user.message") {
      const msg: StoredMessage = {
        role: "user",
        content: event.content.map(toMessageContentPart).filter(isTextPart),
        timestamp: event.ts,
        ...(event.userId ? { userId: event.userId } : {}),
        ...(event.files ? { metadata: { files: event.files } } : {}),
      };
      messages.push(msg);
      i++;
      continue;
    }

    if (event.type === "run.start") {
      const runId = event.runId;
      i++;

      // Collect events within this run
      const runLlmResponses: LlmResponseEvent[] = [];
      const runToolDones: Map<string, ToolDoneEvent> = new Map();
      const runToolInputs: Map<string, unknown> = new Map();

      while (i < events.length) {
        const inner = events[i];
        if (!inner) {
          i++;
          continue;
        }

        if (inner.type === "run.done" && inner.runId === runId) {
          i++;
          break;
        }

        if (inner.type === "run.error" && inner.runId === runId) {
          // Run errored — we still emit messages collected so far
          i++;
          break;
        }

        if (inner.type === "llm.response" && inner.runId === runId) {
          runLlmResponses.push(inner);
        } else if (inner.type === "tool.done" && inner.runId === runId) {
          runToolDones.set(inner.id, inner);
        } else if (inner.type === "tool.start" && inner.runId === runId) {
          if (inner.input !== undefined) {
            runToolInputs.set(inner.id, inner.input);
          }
        }
        // tool.progress and other events are skipped for reconstruction

        i++;
      }

      // If we ran out of events without run.done/run.error, still emit what we have
      // (handles incomplete runs)

      // Now produce messages from llm.response events in order
      for (const llmResp of runLlmResponses) {
        const toolCallParts = llmResp.content.filter(
          (c): c is LanguageModelV3Content & { type: "tool-call" } => c.type === "tool-call",
        );
        const textParts = llmResp.content.filter(
          (c): c is LanguageModelV3Content & { type: "text" } => c.type === "text",
        );
        const reasoningParts = llmResp.content.filter(
          (c): c is LanguageModelV3Content & { type: "reasoning" } => c.type === "reasoning",
        );

        const baseMetadata = () => ({
          inputTokens: llmResp.inputTokens,
          outputTokens: llmResp.outputTokens,
          cacheReadTokens: llmResp.cacheReadTokens,
          model: llmResp.model,
          llmMs: llmResp.llmMs,
          iterations: runLlmResponses.length,
          costUsd: estimateCost(llmResp.model, {
            inputTokens: llmResp.inputTokens,
            outputTokens: llmResp.outputTokens,
            cacheReadTokens: llmResp.cacheReadTokens,
          }),
          ...(llmResp.finishReason ? { finishReason: llmResp.finishReason } : {}),
        });

        // Reasoning attaches to the FIRST emitted message of this turn,
        // so the UI renders a single collapsed reasoning block above the
        // assistant's tool call or text. Subsequent messages from the
        // same turn omit it to avoid duplication.
        //
        // Provider metadata (e.g. Anthropic's thinking signature) is
        // promoted from `providerMetadata` (the V3Content output shape)
        // to `providerOptions` (the V3ReasoningPart prompt shape) so
        // the reasoning block survives a conversation reload + replay.
        // Without this, the AI SDK Anthropic provider drops the block as
        // "unsupported reasoning metadata" and Anthropic 400s the call.
        const reasoningContent = reasoningParts.map((r) => ({
          type: "reasoning" as const,
          text: r.text,
          ...(r.providerMetadata ? { providerOptions: r.providerMetadata } : {}),
        }));
        let reasoningEmitted = false;

        if (toolCallParts.length > 0) {
          // Only include tool calls that were actually executed (have a tool.done event).
          // Unexecuted calls happen when a run is cut short (abort, crash, etc.)
          // before tools could run. Including them would create orphaned tool_use blocks
          // that the Claude API rejects, or fake empty tool results that confuse the model.
          const executedToolCalls = toolCallParts.filter((tc) => runToolDones.has(tc.toolCallId));

          if (executedToolCalls.length > 0) {
            const toolCallsMeta = executedToolCalls.map((tc) => {
              const done = runToolDones.get(tc.toolCallId)!;
              return {
                id: tc.toolCallId,
                name: tc.toolName,
                input: (runToolInputs.get(tc.toolCallId) ?? parseToolInput(tc.input)) as Record<
                  string,
                  unknown
                >,
                output: done.output ?? "",
                ok: done.ok ?? true,
                ms: done.ms ?? 0,
              };
            });

            const assistantMsg: StoredMessage = {
              role: "assistant",
              content: [
                ...(reasoningEmitted ? [] : reasoningContent),
                ...executedToolCalls.map((tc) => ({
                  type: "tool-call" as const,
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  input: parseToolInput(tc.input),
                })),
              ],
              timestamp: llmResp.ts,
              metadata: { ...baseMetadata(), toolCalls: toolCallsMeta },
            };
            reasoningEmitted = true;
            messages.push(assistantMsg);

            // Emit tool-result messages for each executed tool call
            for (const tc of executedToolCalls) {
              const done = runToolDones.get(tc.toolCallId)!;
              const toolMsg: StoredMessage = {
                role: "tool",
                content: [
                  {
                    type: "tool-result" as const,
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    output: {
                      type: "text",
                      value: done.output ?? "",
                    },
                  },
                ],
                timestamp: done.ts ?? llmResp.ts,
              };
              messages.push(toolMsg);
            }
          }
        }

        if (textParts.length > 0) {
          const assistantMsg: StoredMessage = {
            role: "assistant",
            content: [
              ...(reasoningEmitted ? [] : reasoningContent),
              ...textParts.map((t) => ({ type: "text" as const, text: t.text })),
            ],
            timestamp: llmResp.ts,
            metadata: baseMetadata(),
          };
          reasoningEmitted = true;
          messages.push(assistantMsg);
        }

        // Step 4a — replay honesty.
        // No tool-call, no text. Two reasons we can land here:
        //   1. The turn produced reasoning only (extended thinking that
        //      ran out of budget before any visible content).
        //   2. The turn produced literally nothing AND the model didn't
        //      end cleanly (length / content_filter / error).
        // Either way, dropping the message silently — the pre-existing
        // behavior — leaves the operator looking at a conversation that
        // skips a turn that actually happened. Emit a placeholder
        // assistant message carrying finishReason in metadata so the UI
        // can render the truncation banner and the reasoning (if any).
        //
        // Reasoning content is ONLY usable as the placeholder body when
        // it carries provider metadata that lets it round-trip (e.g.
        // Anthropic's signature). Without that, the AI SDK provider
        // drops the block on the next prompt → content: [] → API 400.
        // Fall back to marker text whenever the reasoning can't be
        // safely replayed.
        if (
          toolCallParts.length === 0 &&
          textParts.length === 0 &&
          (reasoningContent.length > 0 || (llmResp.finishReason && llmResp.finishReason !== "stop"))
        ) {
          const placeholderText =
            TRUNCATION_MARKERS[llmResp.finishReason ?? "other"] ?? TRUNCATION_MARKERS.other!;
          const reasoningRoundTrips = reasoningContent.some(
            (r) => "providerOptions" in r && r.providerOptions != null,
          );
          const placeholderContent = reasoningRoundTrips
            ? reasoningContent
            : [{ type: "text" as const, text: placeholderText }];
          const assistantMsg: StoredMessage = {
            role: "assistant",
            content: placeholderContent,
            timestamp: llmResp.ts,
            metadata: baseMetadata(),
          };
          messages.push(assistantMsg);
        }
      }

      continue;
    }

    // Skip events outside a run context (shouldn't normally happen)
    i++;
  }

  return messages;
}

/**
 * Derive aggregate usage metrics from a list of conversation events.
 * Scans all `llm.response` events and sums tokens, computes total cost.
 */
export function deriveUsageMetrics(events: readonly ConversationEvent[]): UsageMetrics {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let lastModel: string | null = null;

  for (const event of events) {
    if (event.type === "llm.response") {
      totalInputTokens += event.inputTokens;
      totalOutputTokens += event.outputTokens;
      lastModel = event.model;
      totalCostUsd += estimateCost(event.model, {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
      });
    }
  }

  return { totalInputTokens, totalOutputTokens, totalCostUsd, lastModel };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toMessageContentPart(c: LanguageModelV3Content): { type: "text"; text: string } | null {
  if (c.type === "text") return { type: "text", text: c.text };
  return null;
}

function isTextPart(p: { type: "text"; text: string } | null): p is { type: "text"; text: string } {
  return p !== null;
}
