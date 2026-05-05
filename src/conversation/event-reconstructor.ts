/**
 * Event-to-message reconstructor.
 *
 * Converts ConversationEvent[] to StoredMessage[] — the core of the
 * "derive at read time" strategy used by history(), the LLM context
 * builder, and the web client.
 */

import type { LanguageModelV3Content, LanguageModelV3ReasoningPart } from "@ai-sdk/provider";
import { normalizeForReplay } from "../model/inbound-fit.ts";
import { estimateCost } from "../usage/cost.ts";
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
 * Marker for the case where the LLM produced tool calls but the run was
 * cut short before any of them executed (process death, abort, stalled
 * call). Without this placeholder the reconstructed history would skip
 * the turn entirely, producing two adjacent `user` messages on the next
 * append — which Anthropic rejects with
 * `"This model does not support assistant message prefill."`. The marker
 * preserves the role-alternation invariant and tells the model honestly
 * what happened.
 */
const ORPHANED_TOOL_CALLS_MARKER =
  "[Previous turn called tools but tool execution did not complete (the run was cut short before any tool returned). The tool calls were dropped on reload.]";

/**
 * Generic marker for a run scope that emitted no messages at all (no
 * llm.response events between `run.start` and the run's terminator —
 * process died before any model call returned, or some other edge case).
 * Used by the final invariant pass to repair user→user adjacency that
 * the per-run logic didn't catch.
 */
const ABANDONED_RUN_MARKER = "[Previous turn ended without producing any response.]";

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
  const messages = buildMessagesFromEvents(events);
  return ensureRoleAlternation(messages);
}

function buildMessagesFromEvents(events: readonly ConversationEvent[]): StoredMessage[] {
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

        // Implicit run end: a new user.message or run.start means the
        // previous run never closed cleanly (process died, abort fired
        // without emitting a terminal event). Break out — but DO NOT
        // increment `i`, so the outer loop processes the event itself.
        // Without this, subsequent user messages get swallowed by the
        // run loop and the conversation appears to skip turns on reload.
        if (inner.type === "user.message" || inner.type === "run.start") {
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

      // Now produce messages from llm.response events in order.
      //
      // Faithful replay shape: each llm.response becomes ONE assistant
      // message whose content array preserves the provider's original
      // block ordering — text, reasoning, and executed tool-calls in the
      // exact order Anthropic returned them. Unexecuted (orphaned) tool-
      // calls are filtered out (the API rejects orphans), but no other
      // reordering happens.
      //
      // Why ordering matters: Anthropic validates the LATEST assistant
      // message byte-for-byte ("thinking blocks in the latest assistant
      // message cannot be modified"). An older implementation grouped
      // content by category (reasoning / text / tool-call) and emitted
      // them as separate messages — convenient for UI rendering but a
      // 400 on multi-iteration runs with thinking enabled. The chat UI
      // consumes its own projection from src/bundles/conversations/src/
      // jsonl-reader.ts; this function is the LLM-replay projection.
      for (const llmResp of runLlmResponses) {
        const baseMetadata = () => ({
          usage: llmResp.usage,
          model: llmResp.model,
          llmMs: llmResp.llmMs,
          iterations: runLlmResponses.length,
          ...(llmResp.finishReason ? { finishReason: llmResp.finishReason } : {}),
        });

        const executedToolCalls = llmResp.content.filter(
          (c): c is LanguageModelV3Content & { type: "tool-call" } =>
            c.type === "tool-call" && runToolDones.has(c.toolCallId),
        );
        const totalToolCalls = llmResp.content.filter((c) => c.type === "tool-call").length;
        const hasOrphanedToolCalls = totalToolCalls > executedToolCalls.length;

        // Filter out orphaned tool-calls; preserve all other blocks in
        // their original order. normalizeForReplay then handles the
        // stream→prompt shape mismatches (reasoning providerMetadata→
        // providerOptions, tool-call input string→object).
        const replayContent = normalizeForReplay(
          llmResp.content.filter((c) => c.type !== "tool-call" || runToolDones.has(c.toolCallId)),
        );

        // Tool-call metadata for the chat UI (input/output rendering).
        // Carried on the assistant message; not part of the LLM replay.
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

        const hasRealContent =
          replayContent.some((c) => c.type === "text") || executedToolCalls.length > 0;

        if (hasRealContent) {
          // Normal path: one assistant message, original block order.
          // Orphaned tool-calls (if any) were already filtered out of
          // replayContent — text alongside them survives as the visible
          // assistant turn, no placeholder needed.
          const assistantMsg: StoredMessage = {
            role: "assistant",
            content: replayContent,
            timestamp: llmResp.ts,
            metadata: {
              ...baseMetadata(),
              ...(toolCallsMeta.length > 0 ? { toolCalls: toolCallsMeta } : {}),
            },
          };
          messages.push(assistantMsg);

          // Tool-result message per executed tool-call (one per result so
          // role alternation alternates assistant→tool→tool→… cleanly).
          for (const tc of executedToolCalls) {
            const done = runToolDones.get(tc.toolCallId)!;
            const toolMsg: StoredMessage = {
              role: "tool",
              content: [
                {
                  type: "tool-result" as const,
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  output: { type: "text", value: done.output ?? "" },
                },
              ],
              timestamp: done.ts ?? llmResp.ts,
            };
            messages.push(toolMsg);
          }
          continue;
        }

        // Step 4a — replay honesty.
        // No real content emitted above. Reasons:
        //   1. The turn produced reasoning only (extended thinking that
        //      ran out of budget before any visible content).
        //   2. The turn produced literally nothing AND the model didn't
        //      end cleanly (length / content_filter / error).
        //   3. The turn produced tool calls that NEVER executed (process
        //      death, abort, stalled call). Without a placeholder, the
        //      next user message lands directly after the prior user
        //      message and Anthropic rejects the conversation on reload
        //      with "model does not support assistant message prefill".
        //
        // Reasoning content is ONLY usable as the placeholder body when
        // it carries provider metadata that lets it round-trip (e.g.
        // Anthropic's signature). Without that, the AI SDK provider
        // drops the block on the next prompt → content: [] → API 400.
        // For the orphaned-tool-calls case we always use marker text:
        // the reasoning may end mid-tool-call-intent, and the marker is
        // the load-bearing signal to the model on retry.
        //
        // Behavior change vs. the pre-block-ordering reconstructor: when
        // a turn has both signed and unsigned reasoning blocks, only the
        // signed ones are kept in the placeholder. The old code kept all
        // reasoning blocks as long as ANY had a signature; the unsigned
        // blocks would then be silently dropped by the AI SDK provider on
        // the next prompt with an "unsupported reasoning metadata" warning.
        // Filtering up-front is more honest — the reconstructed message
        // accurately reflects what the next call will actually send.
        const reasoningWithMeta = replayContent.filter(
          (c): c is LanguageModelV3ReasoningPart =>
            c.type === "reasoning" && c.providerOptions != null,
        );
        const hasAbnormalFinish = llmResp.finishReason != null && llmResp.finishReason !== "stop";
        const hasAnyReasoning = replayContent.some((c) => c.type === "reasoning");
        const shouldEmitPlaceholder = hasOrphanedToolCalls || hasAnyReasoning || hasAbnormalFinish;

        if (!shouldEmitPlaceholder) continue;

        const placeholderText = hasOrphanedToolCalls
          ? ORPHANED_TOOL_CALLS_MARKER
          : (TRUNCATION_MARKERS[llmResp.finishReason ?? "other"] ?? TRUNCATION_MARKERS.other!);
        const reasoningRoundTrips = !hasOrphanedToolCalls && reasoningWithMeta.length > 0;
        // Inferred type: ReasoningPart[] | [{type:"text",text:string}].
        // Both are assignable to the assistant variant's content union;
        // an explicit `LanguageModelV3Content[]` annotation here is the
        // wrong type (stream-side, doesn't include `providerOptions`).
        const placeholderContent = reasoningRoundTrips
          ? reasoningWithMeta
          : [{ type: "text" as const, text: placeholderText }];

        const assistantMsg: StoredMessage = {
          role: "assistant",
          content: placeholderContent,
          timestamp: llmResp.ts,
          metadata: baseMetadata(),
        };
        messages.push(assistantMsg);
      }

      continue;
    }

    // Skip events outside a run context (shouldn't normally happen)
    i++;
  }

  return messages;
}

/**
 * Defense-in-depth invariant pass: ensure the reconstructed message list
 * never has two adjacent `user` messages. Anthropic rejects such a
 * sequence on the next append with
 * `"This model does not support assistant message prefill."`.
 *
 * The per-run step-4a handler covers the cases we've seen in production
 * (orphaned tool-calls, length-truncated empty turns). This pass catches
 * anything we haven't enumerated — e.g. a run scope that emitted zero
 * `llm.response` events because the process died before the model
 * returned. Cheap O(n) scan; never fires on healthy data.
 */
function ensureRoleAlternation(messages: StoredMessage[]): StoredMessage[] {
  if (messages.length < 2) return messages;

  const result: StoredMessage[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (prev?.role === "user" && msg.role === "user") {
      // Place the synthetic turn 1ms after the previous user message so it
      // sorts between the two user turns instead of collapsing onto the
      // next user's timestamp (the UI sorts strictly by `timestamp`, and a
      // tied-timestamp placeholder rendered after the user it precedes
      // looks like the user replied to themselves). Clamp to the next
      // message's timestamp when it's already <1ms ahead — clock skew or
      // tight bursts can produce equal/backwards timestamps.
      const prevTime = Date.parse(prev.timestamp);
      const msgTime = Date.parse(msg.timestamp);
      const placeholderTs =
        Number.isFinite(prevTime) && Number.isFinite(msgTime)
          ? new Date(Math.min(prevTime + 1, msgTime)).toISOString()
          : msg.timestamp;
      result.push({
        role: "assistant",
        content: [{ type: "text" as const, text: ABANDONED_RUN_MARKER }],
        timestamp: placeholderTs,
        // Carry minimal metadata so the chat UI can render the same
        // truncation banner it uses for length / content-filter cases.
        // `finishReason: "other"` is the closest enum value — there was no
        // real LLM call, so the categorical reasons (length, error, etc.)
        // don't apply.
        metadata: {
          finishReason: "other",
          usage: { inputTokens: 0, outputTokens: 0 },
          llmMs: 0,
          iterations: 0,
        },
      });
    }
    result.push(msg);
  }
  return result;
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
    // Pre-unification events stored token counts as flat fields and have
    // no `usage` struct. We deliberately do not migrate them — they
    // contribute zero to derived totals — but we must not crash on them.
    if (event.type === "llm.response" && event.usage) {
      totalInputTokens += event.usage.inputTokens;
      totalOutputTokens += event.usage.outputTokens;
      lastModel = event.model;
      totalCostUsd += estimateCost(event.model, event.usage);
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
