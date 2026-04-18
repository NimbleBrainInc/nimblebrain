/**
 * Handler for conversations__export tool.
 *
 * Export a conversation as markdown or JSON.
 */

import type { ConversationIndex } from "../index-cache.ts";
import { type DisplayMessage, readConversation } from "../jsonl-reader.ts";

export interface ExportInput {
  id: string;
  format: "markdown" | "json";
}

/** Truncate a string to maxLen, appending "..." if truncated. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...`;
}

/** Summarize tool call input as a short string. */
function summarizeInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return truncate(json, 100);
}

/** Pull the first text block out of an MCP tool result, or "" if none. */
function extractResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

/** Render a single message as markdown. */
function renderMessage(msg: DisplayMessage): string {
  const heading = msg.role === "user" ? "## User" : "## Assistant";
  const parts: string[] = [heading, ""];

  if (msg.content) {
    parts.push(msg.content);
  }

  // Render tool calls as blockquotes
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      parts.push("");
      parts.push(`> **Tool call:** ${tc.name}`);
      parts.push(`> Input: ${summarizeInput(tc.input)}`);
      parts.push(`> Result: ${truncate(extractResultText(tc.result), 200)}`);
    }
  }

  return parts.join("\n");
}

/** Export a conversation as markdown. */
function exportMarkdown(
  title: string | null,
  createdAt: string,
  messageCount: number,
  inputTokens: number,
  outputTokens: number,
  messages: DisplayMessage[],
): string {
  const lines: string[] = [];

  lines.push(`# Conversation: ${title || "Untitled"}`);
  lines.push("");
  lines.push(`**Created:** ${createdAt}`);
  lines.push(`**Messages:** ${messageCount}`);
  lines.push(`**Tokens:** ${inputTokens} in / ${outputTokens} out`);
  lines.push("");
  lines.push("---");

  for (const msg of messages) {
    lines.push("");
    lines.push(renderMessage(msg));
    lines.push("");
    lines.push("---");
  }

  return lines.join("\n");
}

export async function handleExport(input: ExportInput, index: ConversationIndex): Promise<object> {
  const entry = index.get(input.id);
  if (!entry) {
    throw new Error(`Conversation not found: ${input.id}`);
  }

  const conv = await readConversation(entry.filePath);
  if (!conv) {
    throw new Error(`Failed to read conversation file: ${input.id}`);
  }

  if (input.format === "json") {
    return {
      content: JSON.stringify(conv.messages, null, 2),
    };
  }

  // Markdown format
  const md = exportMarkdown(
    conv.meta.title,
    conv.meta.createdAt,
    conv.messageCount,
    conv.meta.totalInputTokens,
    conv.meta.totalOutputTokens,
    conv.messages,
  );

  return {
    content: md,
  };
}
