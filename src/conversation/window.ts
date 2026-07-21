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
 * Apply provider-specific replay policy for reasoning blocks.
 *
 * This is the single chokepoint for one invariant: **reasoning blocks are
 * RETAINED on replay — never stripped per turn.** It protects two providers for
 * two different reasons, so it's worth one named seam (and the regression test
 * that guards it):
 *   - OpenAI / Gemini *require* reasoning/thought metadata to stay paired with
 *     replayed tool calls (a correctness constraint).
 *   - Anthropic merely *permits* stripping older thinking blocks (a token
 *     optimization), but stripping here — per request, keyed on "is this the
 *     latest assistant message" — is incompatible with prompt caching: the
 *     moment a turn stops being the latest, its reasoning bytes change, which
 *     invalidates the cached prefix from that point. With the rolling
 *     step-anchor (see `model/cache-policy.ts`) that bust lands just behind the
 *     anchor on EVERY iteration, forcing a full re-write of the growing prefix —
 *     the exact pathology this effort removes. Retained reasoning is written to
 *     cache once and read back cheaply; the strip's savings are dwarfed by the
 *     re-writes it forced.
 *
 * The policy is uniform today (retain, regardless of `provider`), so this is a
 * passthrough — but it stays provider-keyed because that's the dispatch point a
 * future provider-specific replay transform plugs into. Bounded stripping, if it
 * ever returns, belongs at a stable compaction boundary (applied once to a
 * frozen prefix), not here per turn.
 */
export function applyReasoningReplayPolicy(
  messages: LanguageModelV3Message[],
  _provider: string,
): LanguageModelV3Message[] {
  return messages;
}

/**
 * Sliding window for conversation messages.
 * Keeps the first message (often system context/initial user message), the
 * current turn (the most recent atomic group — always retained), and as many of
 * the intervening recent messages as fit within the token budget.
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

  // Group everything after the anchor into atomic tool-call/result units.
  const rest = messages.slice(1);
  const groups = groupMessages(rest);

  // The final group is the CURRENT turn (+ any tool call/result it carries).
  // The model must always see it — dropping it makes the agent answer a stale
  // question — so reserve it FIRST and retain it unconditionally, even when the
  // anchor and tool schemas already exhaust the budget. It's an atomic group, so
  // this never orphans a tool-result.
  const lastGroup = groups.length > 0 ? groups[groups.length - 1]! : [];
  const lastGroupTokens = lastGroup.reduce((sum, m) => sum + estimateTokens(m), 0);
  let budget = maxTokens - lastGroupTokens;

  // If the anchor no longer fits alongside the current turn, drop the anchor —
  // a slightly-over-budget current turn (the engine's reactive budget-halving is
  // the backstop) beats answering the oldest turn alone.
  if (budget - firstTokens < 0) return lastGroup.length > 0 ? lastGroup : [first];
  budget -= firstTokens;

  // Walk backward from the second-to-last group, accumulating what still fits.
  const kept: LanguageModelV3Message[][] = [];
  for (let i = groups.length - 2; i >= 0; i--) {
    const groupTokens = groups[i]!.reduce((sum, m) => sum + estimateTokens(m), 0);
    if (budget - groupTokens < 0) break;
    budget -= groupTokens;
    kept.unshift(groups[i]!);
  }

  return [first, ...kept.flat(), ...lastGroup];
}
