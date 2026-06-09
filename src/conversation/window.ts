import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { estimateMessageTokens } from "../engine/token-estimate.ts";

/**
 * Estimate token count for a message.
 *
 * Routed through the part-aware `estimateMessageTokens` (shared with the
 * `context.assembled` telemetry path) so the windowing decision and the
 * reported token count agree on the same numbers. The previous local
 * `chars/4` heuristic over-counted by ~3 tokens per byte for any message
 * carrying a rehydrated `file` part (a `Uint8Array` serialized as
 * `{"0":n,"1":n,…}`), which caused excessive trimming when images were
 * present even though the provider would charge the image ~1.5K tokens.
 */
function estimateTokens(msg: LanguageModelV3Message): number {
  return estimateMessageTokens(msg);
}

/**
 * Check whether a message contains tool-call parts (assistant calling tools).
 */
function hasToolUse(msg: LanguageModelV3Message): boolean {
  if (typeof msg.content === "string") return false;
  return (
    Array.isArray(msg.content) && msg.content.some((b) => "type" in b && b.type === "tool-call")
  );
}

/**
 * Check whether a message contains tool-result parts (tool providing results).
 */
function hasToolResult(msg: LanguageModelV3Message): boolean {
  if (typeof msg.content === "string") return false;
  return (
    Array.isArray(msg.content) && msg.content.some((b) => "type" in b && b.type === "tool-result")
  );
}

/**
 * Group messages into atomic units for windowing.
 * An assistant message with tool-call parts + ALL consecutive following tool
 * messages with tool-result parts form an atomic group that must not be split.
 * This handles parallel tool calls where the reconstructor emits one tool
 * message per tool call (e.g., 4 parallel tool calls → 1 assistant + 4 tool messages).
 * Regular messages are groups of size 1.
 */
function groupMessages(messages: LanguageModelV3Message[]): LanguageModelV3Message[][] {
  const groups: LanguageModelV3Message[][] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (
      msg.role === "assistant" &&
      hasToolUse(msg) &&
      i + 1 < messages.length &&
      messages[i + 1]?.role === "tool" &&
      hasToolResult(messages[i + 1]!)
    ) {
      // Collect all consecutive tool-result messages that follow this assistant
      const group: LanguageModelV3Message[] = [msg];
      let j = i + 1;
      while (j < messages.length && messages[j]?.role === "tool" && hasToolResult(messages[j]!)) {
        group.push(messages[j]!);
        j++;
      }
      groups.push(group);
      i = j;
    } else {
      groups.push([msg]);
      i++;
    }
  }
  return groups;
}

/**
 * Strip reasoning blocks from assistant messages older than the most recent
 * assistant turn.
 *
 * Anthropic's guidance for extended thinking: pass thinking blocks from the
 * most recent turn back to the API unchanged; strip thinking blocks from
 * older turns to reduce token usage. The reasoning blocks attached to the
 * last assistant message are still load-bearing — they pair with any
 * tool-use chain currently in flight — but every earlier assistant message's
 * reasoning is historical and replays as opaque signature bytes that bloat
 * the prompt linearly with turn count.
 *
 * In production conv_e00606c7aab7423d we saw 100+ KB `llm.response` events
 * dominated by Anthropic signatures with empty `text`. This is the seam
 * where that growth is cut.
 *
 * Edge case: an assistant message that contains ONLY reasoning blocks is a
 * legitimate placeholder for a turn that produced reasoning-only output
 * (see `event-reconstructor.ts` step 4a). Stripping its only content would
 * leave an empty assistant message that Anthropic rejects on replay, so
 * those placeholders are kept intact.
 */
export function stripOlderReasoning(messages: LanguageModelV3Message[]): LanguageModelV3Message[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx <= 0) return messages;

  let changed = false;
  const out = messages.map((msg, idx) => {
    if (idx === lastAssistantIdx) return msg;
    if (msg.role !== "assistant") return msg;
    if (typeof msg.content === "string") return msg;
    const nonReasoning = msg.content.filter((part) => part.type !== "reasoning");
    if (nonReasoning.length === msg.content.length) return msg;
    if (nonReasoning.length === 0) return msg; // pure-reasoning placeholder
    changed = true;
    return { ...msg, content: nonReasoning };
  });
  return changed ? out : messages;
}

/**
 * Apply provider-specific replay policy for reasoning blocks.
 *
 * Reasoning blocks are RETAINED for every provider. OpenAI and Gemini require
 * reasoning/thought metadata to stay paired with replayed tool calls, so their
 * history must be intact. Anthropic *permits* stripping older thinking blocks
 * (an optional token optimization), but doing it here — per request, keyed on
 * "is this the latest assistant message" — is incompatible with prompt caching:
 * the moment a turn stops being the latest, its reasoning bytes change, which
 * invalidates the cached prefix from that point. With the rolling step-anchor
 * (see `model/cache-policy.ts`) that bust lands just behind the anchor on EVERY
 * iteration, forcing a full re-write of the growing prefix — the exact pathology
 * this whole effort removes. Under caching, retained reasoning is written to
 * cache once and read back at the cache-read rate; the strip's token savings are
 * dwarfed by the re-writes it forces.
 *
 * Stripping is only cache-safe beyond a STABLE frozen boundary that advances
 * rarely (i.e. at compaction). `stripOlderReasoning` is kept for that future
 * use — applied once to a compacted prefix, not per turn. Until then, retain.
 */
export function applyReasoningReplayPolicy(
  messages: LanguageModelV3Message[],
  _provider: string,
): LanguageModelV3Message[] {
  return messages;
}

/**
 * Limit conversation history by message group count.
 * Keeps the first message (initial user request) plus the most recent
 * `maxGroups` message groups. Tool call/result pairs count as one group.
 *
 * Applied before token-based windowing as a fast, predictable cut.
 */
export function sliceHistory(
  messages: LanguageModelV3Message[],
  maxGroups: number,
): LanguageModelV3Message[] {
  if (messages.length <= 2) return messages;

  const first = messages[0]!;
  const rest = messages.slice(1);
  const groups = groupMessages(rest);

  if (groups.length <= maxGroups) return messages;

  const kept = groups.slice(-maxGroups);
  return [first, ...kept.flat()];
}

/**
 * Sliding window for conversation messages.
 * Keeps the first message (often system context/initial user message) and
 * the most recent messages that fit within the token budget.
 *
 * Tool call/result pairs are kept atomic — an assistant message with tool-call
 * parts is never separated from its corresponding tool message with tool-result parts.
 */
export function windowMessages(
  messages: LanguageModelV3Message[],
  maxTokens: number,
): LanguageModelV3Message[] {
  if (messages.length === 0) return [];

  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  if (totalTokens <= maxTokens) return messages;

  // Keep at least 2 messages (first + last)
  if (messages.length <= 2) return messages;

  const first = messages[0]!;
  const firstTokens = estimateTokens(first);
  let budget = maxTokens - firstTokens;

  if (budget <= 0) return [first];

  // Group remaining messages (index 1+) into atomic units
  const rest = messages.slice(1);
  const groups = groupMessages(rest);

  // Walk backward from end, accumulating groups that fit
  const kept: LanguageModelV3Message[][] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const groupTokens = groups[i]?.reduce((sum, m) => sum + estimateTokens(m), 0) ?? 0;
    if (budget - groupTokens < 0) break;
    budget -= groupTokens;
    kept.unshift(groups[i]!);
  }

  return [first, ...kept.flat()];
}
