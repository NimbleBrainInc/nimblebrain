import type { LanguageModelV4Message } from "@ai-sdk/provider";
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
function estimateTokens(msg: LanguageModelV4Message): number {
  return estimateMessageTokens(msg);
}

/**
 * Check whether a message contains tool-call parts (assistant calling tools).
 */
function hasToolUse(msg: LanguageModelV4Message): boolean {
  if (typeof msg.content === "string") return false;
  return (
    Array.isArray(msg.content) && msg.content.some((b) => "type" in b && b.type === "tool-call")
  );
}

/**
 * Check whether a message contains tool-result parts (tool providing results).
 */
function hasToolResult(msg: LanguageModelV4Message): boolean {
  if (typeof msg.content === "string") return false;
  return (
    Array.isArray(msg.content) && msg.content.some((b) => "type" in b && b.type === "tool-result")
  );
}

/**
 * Group messages into atomic units — the units anything that cuts a history
 * has to cut between, whether it drops the middle (windowing, below) or folds
 * the front into a summary (`runtime/mid-turn-compaction.ts`).
 *
 * An assistant message with tool-call parts + ALL consecutive following tool
 * messages with tool-result parts form an atomic group that must not be split.
 * This handles parallel tool calls where the reconstructor emits one tool
 * message per tool call (e.g., 4 parallel tool calls → 1 assistant + 4 tool messages).
 * Regular messages are groups of size 1.
 */
export function groupMessages(messages: LanguageModelV4Message[]): LanguageModelV4Message[][] {
  const groups: LanguageModelV4Message[][] = [];
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
      const group: LanguageModelV4Message[] = [msg];
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
  messages: LanguageModelV4Message[],
  _provider: string,
): LanguageModelV4Message[] {
  return messages;
}

/**
 * Sliding window for conversation messages.
 * Always keeps the first message (the anchor — the conversation's leading user
 * turn), the current turn's request (the latest user message), and the last
 * atomic group, so a model mid-tool-loop still sees what it was asked. The rest
 * fills the remaining budget newest first: the current turn's earlier calls,
 * then older turns. An exhausted budget therefore never collapses to the oldest
 * turn, and never drops the request being worked on.
 *
 * Tool call/result pairs are kept atomic — an assistant message with tool-call
 * parts is never separated from its corresponding tool message with tool-result parts.
 * `mandatoryOverBudget` reports when the anchor, the request, and the last
 * group alone exceed the budget; those messages cannot be removed by a tighter window.
 */
export interface WindowMessagesResult {
  messages: LanguageModelV4Message[];
  mandatoryOverBudget: boolean;
}

export function windowMessages(
  messages: LanguageModelV4Message[],
  maxTokens: number,
): WindowMessagesResult {
  if (messages.length === 0) return { messages, mandatoryOverBudget: false };

  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  if (totalTokens <= maxTokens) return { messages, mandatoryOverBudget: false };

  // One or two messages are all mandatory; neither can be windowed away.
  if (messages.length <= 2) return { messages, mandatoryOverBudget: true };

  const first = messages[0]!;
  const firstTokens = estimateTokens(first);

  // Group everything after the anchor into atomic tool-call/result units.
  // messages.length > 2 here, so rest has >= 2 messages and groups is non-empty.
  const rest = messages.slice(1);
  const groups = groupMessages(rest);

  // Mandatory: the anchor, the last atomic group (so a tool-result is never
  // orphaned), and the current turn's request (the latest user message after
  // the anchor). Mid-tool-loop, a model that loses its request redoes an older
  // turn, so the request outranks everything but the anchor and the last group.
  const sum = (ms: LanguageModelV4Message[]) => ms.reduce((t, m) => t + estimateTokens(m), 0);
  const last = groups.length - 1;
  const lastGroup = groups[last]!;
  const req = groups.findLastIndex((g) => g[0]!.role === "user");
  const request = req >= 0 && req < last ? groups[req]! : [];

  // Reserve the anchor (kept unconditionally — the leading message must be the
  // user turn, which Anthropic requires), the request, and the last group; the
  // remainder is for the rest. It can go negative — e.g. a single large tool
  // result exceeds the budget on a small-context model, an ordinary case. Keep
  // the mandatory messages intact and report that a tighter window cannot
  // shrink them, so the engine can avoid a futile provider-overflow retry.
  const budget = maxTokens - firstTokens - sum(request) - sum(lastGroup);
  const mandatoryOverBudget = budget < 0;

  // Fill newest first: the current turn's earlier calls, then older turns.
  // Stop at the first group that does not fit, so what is kept stays contiguous.
  const turnStart = req >= 0 && req < last ? req + 1 : last;
  const turn = fillNewestFirst(groups.slice(turnStart, last), budget);
  const oldEnd = req >= 0 && req < last ? req : last;
  const old = turn.full ? [] : fillNewestFirst(groups.slice(0, oldEnd), turn.budget).kept;

  return {
    messages: [first, ...old.flat(), ...request, ...turn.kept.flat(), ...lastGroup],
    mandatoryOverBudget,
  };
}

/**
 * Keep the newest groups that fit in `budget`, stopping at the first that does
 * not, so what is kept is a contiguous suffix. `full` reports that one did not fit.
 */
function fillNewestFirst(
  groups: LanguageModelV4Message[][],
  budget: number,
): { kept: LanguageModelV4Message[][]; budget: number; full: boolean } {
  const kept: LanguageModelV4Message[][] = [];
  let left = budget;
  for (let i = groups.length - 1; i >= 0; i--) {
    const groupTokens = groups[i]!.reduce((t, m) => t + estimateTokens(m), 0);
    if (left - groupTokens < 0) return { kept, budget: left, full: true };
    left -= groupTokens;
    kept.unshift(groups[i]!);
  }
  return { kept, budget: left, full: false };
}
