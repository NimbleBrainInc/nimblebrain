import { isDeepStrictEqual } from "node:util";
import type { ContentBlock, ToolResult } from "../engine/types.ts";

/**
 * Give the model a remote tool's structured data.
 *
 * The model sees a tool result's text blocks only (`extractTextForModel`).
 * MCP asks a server that returns `structuredContent` to also return it as
 * serialized JSON in a text block, but the ask is a SHOULD: a server can send
 * its rows only in `structuredContent` with a one-line summary as the text,
 * and the model then gets the summary and none of the data. This does that
 * duplication on the server's behalf, appending the JSON as a text block when
 * no model-visible text block already carries it.
 *
 * Remote sources only. The platform's in-process tools are written knowing
 * only `content` reaches the model, and put in it what the model should read.
 *
 * An error result is left alone: its text is the error, and a structured
 * failure reason is for the engine (`errorReason`), not the prompt.
 */
export function withStructuredContentText(result: ToolResult): ToolResult {
  const structured = result.structuredContent;
  if (result.isError || !structured) return result;
  if (result.content.some((b) => carries(b, structured))) return result;
  const json: ContentBlock = { type: "text", text: JSON.stringify(structured) };
  return { ...result, content: [...result.content, json] };
}

/** A model-visible text block whose body is the structured content as JSON. */
function carries(block: ContentBlock, structured: Record<string, unknown>): boolean {
  if (block.type !== "text") return false;
  const text = (block as { text?: unknown }).text;
  if (typeof text !== "string") return false;
  const audience = (block as { annotations?: { audience?: unknown } }).annotations?.audience;
  if (Array.isArray(audience) && audience.includes("user") && !audience.includes("assistant")) {
    return false;
  }
  try {
    return isDeepStrictEqual(JSON.parse(text), structured);
  } catch {
    return false;
  }
}
