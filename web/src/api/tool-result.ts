import type { ToolCallResult } from "../types";

/**
 * Decode a `tools/call` response into typed structured data.
 *
 * Lifted from seven copy-pasted `parseToolResponse` helpers across the
 * settings tabs. The shape contract is the platform's own:
 *
 *   1. `isError === true` → throw with the human-readable text.
 *   2. `structuredContent` present → use it (the canonical typed payload).
 *   3. Otherwise fall back to JSON-parsing `content[0].text`.
 *   4. Empty response → throw.
 *
 * Callers that want soft-fail semantics (e.g. AboutTab's "show empty state
 * if list_apps fails") should catch and handle.
 */
export function parseToolResult<T>(res: ToolCallResult): T {
  if (res.isError) {
    throw new Error(res.content?.[0]?.text ?? "Operation failed");
  }
  if (res.structuredContent) {
    return res.structuredContent as T;
  }
  const text = res.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(text);
    }
  }
  throw new Error("Empty tool response");
}
