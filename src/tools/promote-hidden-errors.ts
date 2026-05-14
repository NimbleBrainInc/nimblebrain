import type { ContentBlock, ToolResult } from "../engine/types.ts";

/**
 * Detect upstream MCP errors that the server failed to flag via
 * `isError: true` and correct the result before it leaves the boundary.
 *
 * Why this exists: some MCP servers wrap their upstream HTTP errors in a
 * text content block but return the result with `isError: false`. Downstream
 * consumers — the agent loop's retry tracking, the run supervisor's failure
 * fingerprinting, the chat UI's error rendering — all key off `isError`. A
 * server lying about success makes every layer above operate on a false
 * premise.
 *
 * Patterns are matched against the concatenated text of all `text`-type
 * content blocks. Chosen to minimise false positives — phrases like
 * "AxiosError" or "Request failed with status code NNN" are effectively
 * never present in a legitimately successful tool response.
 *
 * Anchored patterns use the `m` flag so they match at the start of any
 * block (the join is `\n`-delimited), not just the very first character.
 * A vendor that emits `[{text:"Summary"}, {text:"Request failed..."}]`
 * should still be caught.
 */
const LIE_PATTERNS: readonly RegExp[] = [
  /^Ran into an error[:\s]/m,
  /AxiosError/,
  /^Request failed with status code \d{3}/m,
  /^Error[:\s].*status code \d{3}/im,
] as const;

export function promoteHiddenErrors(result: ToolResult): ToolResult {
  if (result.isError) return result;
  const text = result.content
    .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (LIE_PATTERNS.some((p) => p.test(text))) {
    return { ...result, isError: true };
  }
  return result;
}
