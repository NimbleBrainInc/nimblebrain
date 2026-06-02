import { MAX_TOOL_RESULT_CHARS } from "../limits.ts";
import type { ContentBlock, TextContent } from "./types.ts";

/** A resource_link content block surfaced from an MCP tool result. */
export interface ResourceLinkInfo {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

/**
 * Collect `resource_link` content blocks from a ContentBlock array.
 *
 * Per the MCP spec (2025-11-25), tools may return `resource_link` blocks that
 * point to resources fetched separately via `resources/read`. We surface the
 * bare metadata so UIs can render viewers without pulling the full payload
 * through the agent loop.
 */
export function extractResourceLinks(blocks: ContentBlock[]): ResourceLinkInfo[] {
  const links: ResourceLinkInfo[] = [];
  for (const block of blocks) {
    if ((block as { type?: string }).type !== "resource_link") continue;
    const b = block as Record<string, unknown>;
    const uri = typeof b.uri === "string" ? b.uri : undefined;
    if (!uri) continue;
    const link: ResourceLinkInfo = { uri };
    if (typeof b.name === "string") link.name = b.name;
    if (typeof b.mimeType === "string") link.mimeType = b.mimeType;
    if (typeof b.description === "string") link.description = b.description;
    links.push(link);
  }
  return links;
}

/** Wrap a plain string in a single TextContent block. */
export function textContent(text: string): ContentBlock[] {
  return [{ type: "text" as const, text }];
}

/** Extract all text from ContentBlock[], joining with newline. Skips non-text blocks. */
export function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter(
      (b): b is TextContent => b.type === "text" && typeof (b as TextContent).text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

/**
 * Check whether a content block is intended for the user only (not the model).
 *
 * Uses the MCP spec (2025-06-18) `annotations.audience` field:
 * - `["user"]` → user-only, exclude from model context
 * - `["assistant"]` → model-only
 * - `["user", "assistant"]` → both
 * - absent → no hint, include by default
 */
function isUserOnly(block: ContentBlock): boolean {
  const annotations = (block as Record<string, unknown>).annotations as
    | { audience?: string[] }
    | undefined;
  if (!annotations?.audience || !Array.isArray(annotations.audience)) return false;
  return annotations.audience.includes("user") && !annotations.audience.includes("assistant");
}

/**
 * Estimate the total char-level size of a ContentBlock array.
 * Used to guard against oversized tool results before they propagate
 * through event emission, hooks, and history accumulation.
 */
export function estimateContentSize(blocks: ContentBlock[]): number {
  let size = 0;
  for (const block of blocks) {
    if (block.type === "text" && "text" in block) {
      size += (block as TextContent).text.length;
    } else if (block.type === "image" && "data" in block) {
      size += ((block as Record<string, unknown>).data as string)?.length ?? 0;
    } else if (block.type === "resource" && "resource" in block) {
      const res = (block as Record<string, unknown>).resource as
        | Record<string, unknown>
        | undefined;
      if (typeof res?.text === "string") size += res.text.length;
      else if (typeof res?.blob === "string") size += res.blob.length;
    } else {
      size += JSON.stringify(block).length;
    }
  }
  return size;
}

/**
 * Extract text for the model, filtering out user-only content blocks.
 *
 * Respects MCP `annotations.audience` — blocks marked `["user"]` are excluded
 * so they don't consume model context tokens. Blocks without annotations or
 * with `["assistant"]` / `["user", "assistant"]` are included.
 */
export function extractTextForModel(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => !isUserOnly(b))
    .filter(
      (b): b is TextContent => b.type === "text" && typeof (b as TextContent).text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

/**
 * Trim `text` to at most `limit` chars, preferring a newline boundary so a
 * record/JSON line is never cut in half. Falls back to a hard slice when the
 * first line alone already exceeds the limit (e.g. minified JSON on one line).
 */
function sliceOnLineBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastNewline = slice.lastIndexOf("\n");
  // Only honor the boundary when it still keeps a meaningful chunk; otherwise
  // a single huge first line would collapse the result to almost nothing.
  if (lastNewline > limit * 0.5) return slice.slice(0, lastNewline);
  return slice;
}

/**
 * Bound a tool result's text to the model-context budget.
 *
 * Tool results are persisted in full (for the UI and the conversation
 * record), but they must be bounded before they enter MODEL context — both
 * in the live engine loop AND on history replay. Without a bound on replay,
 * a large result re-enters the prompt on every subsequent turn and dominates
 * token cost (and, with prompt caching, gets re-written into the cache each
 * time the prefix lapses). This is the single source of truth for that
 * bound: the engine and the history reconstructor both call it, so the
 * model's live view and its replayed view of a result are identical.
 *
 * Pure and deterministic — the same input always yields the same output, so
 * the replayed prompt prefix stays byte-stable and cacheable.
 *
 * - Text at or under `limit` is returned unchanged.
 * - With an inline-UI resource, the model gets a short pointer instead of the
 *   payload (the UI renders the full result), matching the existing inline-UI
 *   truncation behavior.
 * - Otherwise the text is trimmed on a line boundary up to `limit`, with an
 *   explicit, actionable marker so the model knows the result was bounded,
 *   that the full version is on the user's screen, and how to retrieve
 *   specific items (filter / narrower scope / pagination) without blindly
 *   re-calling the same tool.
 */
export function boundToolResultForModel(
  text: string,
  opts: { hasUiResource?: boolean; limit?: number } = {},
): string {
  const limit = opts.limit ?? MAX_TOOL_RESULT_CHARS;
  if (limit <= 0 || text.length <= limit) return text;

  // Pin the locale so the marker is byte-stable regardless of host locale —
  // this text lands in the cached prompt prefix on replay, and a locale-
  // dependent separator would shift the prefix and bust the cache.
  const n = (v: number) => v.toLocaleString("en-US");

  if (opts.hasUiResource) {
    return (
      `[Tool completed successfully. Result (${n(text.length)} chars) is ` +
      `displayed in the inline UI. Do not ask the user to view it separately — it is ` +
      `already visible.]`
    );
  }

  const head = sliceOnLineBoundary(text, limit);
  const omitted = text.length - head.length;
  return (
    head +
    `\n\n[Result bounded for model context: showing ${n(head.length)} of ` +
    `${n(text.length)} chars (${n(omitted)} omitted). The full ` +
    `result is on the user's screen. Re-query with a filter, a narrower scope, or a ` +
    `pagination cursor to bring specific items into context.]`
  );
}
