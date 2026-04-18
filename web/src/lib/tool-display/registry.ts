/**
 * Tool-renderer registry — the extension point for Tier 2/3.
 *
 * Apps register a `ToolRenderer` to customize how specific tool calls are
 * described. The generic Tier 0 describer falls back automatically when no
 * renderer matches. First-registered wins; `match` can use any predicate
 * (exact name, prefix, regex).
 *
 * This module is intentionally tiny — the complexity lives in the renderers
 * themselves, not in the registry.
 */

import type { ToolCallDisplay } from "../../hooks/useChat.ts";
import type { ToolDescription } from "./types.ts";

export interface ToolRenderer {
  /** True if this renderer handles the given (stripped or raw) tool name. */
  match(toolName: string): boolean;
  describe(call: ToolCallDisplay): ToolDescription;
}

const renderers: ToolRenderer[] = [];

/** Register a renderer. Later registrations take precedence. */
export function registerToolRenderer(renderer: ToolRenderer): void {
  renderers.unshift(renderer);
}

/** Find the first renderer that matches a tool name, or null. */
export function findRenderer(toolName: string): ToolRenderer | null {
  for (const r of renderers) {
    if (r.match(toolName)) return r;
  }
  return null;
}

/** Test helper — clear the registry. Not exported from index.ts. */
export function clearRenderersForTest(): void {
  renderers.length = 0;
}
