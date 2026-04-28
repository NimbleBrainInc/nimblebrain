/**
 * Decode the result envelope from `POST /v1/tools/call`.
 *
 * Tools return both a human-readable `content` array and an optional
 * `structuredContent` object. We prefer `structuredContent` when present
 * since it carries the typed payload; the JSON-parse fallback exists for
 * older tools that haven't migrated yet.
 *
 * On `isError: true` we throw with the error text so callers can
 * surface it to the operator without having to inspect the envelope
 * shape themselves.
 */
export function parseToolResponse<T>(res: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}): T {
  if (res.isError) {
    const msg = res.content?.[0]?.text ?? "Operation failed";
    throw new Error(msg);
  }
  if (res.structuredContent) return res.structuredContent as T;
  if (res.content?.[0]?.text) {
    try {
      return JSON.parse(res.content[0].text) as T;
    } catch {
      throw new Error(res.content[0].text);
    }
  }
  throw new Error("Empty response");
}
