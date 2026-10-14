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

/**
 * A tool result's `structuredContent` as the output type its tool declares. The
 * wire types the payload `Record<string, unknown>`; the caller names the tool's
 * output type. Throws when the result carries no structured payload.
 */
export function structuredOutput<T extends object>(
  result: Pick<ToolResult, "structuredContent">,
): T {
  if (!result.structuredContent) throw new Error("tool result has no structuredContent");
  // The wire's Record<string, unknown>, read as the tool's declared output type.
  return result.structuredContent as T;
}
