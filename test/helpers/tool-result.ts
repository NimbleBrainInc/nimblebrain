import type { ToolCallResponse } from "../../src/api/schemas/responses.ts";
import type { ToolResult } from "../../src/engine/types.ts";

/** The text of a tool result's first content block, or `""` when it is not text. */
export function resultText(result: Pick<ToolResult, "content"> | ToolCallResponse): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

/** A tool result's structured payload, falling back to its first text block parsed as JSON. */
export function parseResult(result: ToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(resultText(result));
}
