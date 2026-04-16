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
