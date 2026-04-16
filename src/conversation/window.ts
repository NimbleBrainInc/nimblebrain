import type { LanguageModelV3Message } from "@ai-sdk/provider";

/**
 * Estimate token count for a message.
 * Uses ~4 characters per token (rough but fast).
 * V3 messages: system has string content, user/assistant/tool have content as array of parts.
 */
function estimateTokens(msg: LanguageModelV3Message): number {
  if (typeof msg.content === "string") {
    // system message
    return Math.ceil(msg.content.length / 4);
  }
  // content is an array of parts — serialize each part's text/output
  let length = 0;
  for (const part of msg.content) {
    if ("text" in part && typeof part.text === "string") {
      length += part.text.length;
    } else if ("input" in part) {
      // tool-call part
      length += JSON.stringify(part.input).length;
    } else if ("output" in part) {
      // tool-result part
      length += JSON.stringify(part.output).length;
    } else {
      length += JSON.stringify(part).length;
    }
  }
  return Math.ceil(length / 4);
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
