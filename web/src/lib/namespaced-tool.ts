// ---------------------------------------------------------------------------
// Namespaced tool name — web-side parser (Stage 2 / T013, Q2)
//
// Mirrors the contract of `src/tools/namespace.ts::parseNamespacedToolName`.
// Web cannot import from `src/` directly (the web tsconfig only includes
// `./src` and the vite alias only covers `@/* → ./src/*`), so this file is
// the web-tier source of truth for parsing `ws_<id>-<tool_name>` strings.
//
// Contract — kept in lockstep with the platform primitive via codegen:
//   - First `-` is the separator. Tool names may contain `-` themselves
//     (the trailing segment is preserved verbatim). Workspace ids can't
//     contain `-` per `WORKSPACE_ID_PATTERN`, so the first `-` is
//     always the workspace boundary.
//   - Why `-` and not `/`: LLM provider tool-name validators
//     constrain names to `[a-zA-Z0-9_-]{1,128}` (rejects `/`). `-` is
//     the only single-char that satisfies both that external regex
//     and the unambiguity requirement.
//   - `wsId` must match `WORKSPACE_ID_RE`. The pattern + flags come
//     from `web/src/_generated/workspace-id-pattern.ts`, emitted from
//     `src/workspace/workspace-id-pattern.ts` by `bun run codegen` —
//     so future server-side tightening propagates here automatically,
//     and CI's `check:codegen` catches drift between source and copy.
//   - No `??` / `||` fallback. Invalid shapes return `null` here (web
//     surfaces fall back to rendering the raw string per Q2 — "fall back
//     to raw if metadata missing"). The platform primitive throws; the
//     web primitive returns null so the transcript renderer can degrade
//     gracefully without an error boundary.
//
// Components must NEVER do `.split("-")` on a presumed namespaced name
// (task spec audit criterion "Namespace parsing via T002 only"). Use this
// helper or the platform primitive on the server side.
// ---------------------------------------------------------------------------

import { WORKSPACE_ID_FLAGS, WORKSPACE_ID_PATTERN } from "../_generated/workspace-id-pattern.ts";

const WORKSPACE_ID_RE = new RegExp(WORKSPACE_ID_PATTERN, WORKSPACE_ID_FLAGS);

/**
 * Parse a namespaced tool name into `{ wsId, toolName }`. Returns `null`
 * when the input is not a valid namespaced name — callers should render
 * the raw input in that case (Q2: "fall back to raw if metadata missing").
 *
 * Differs from the server-side `parseNamespacedToolName` in error
 * handling: the server throws (the orchestrator must fail loud to avoid
 * silent cross-workspace routing); the web parser returns null because
 * a transcript renderer that crashed on every tool call for a removed
 * workspace would break the chat history rather than degrade it.
 */
export function parseNamespacedToolName(s: string): { wsId: string; toolName: string } | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const sepIdx = s.indexOf("-");
  if (sepIdx < 0) return null;
  const wsId = s.slice(0, sepIdx);
  const toolName = s.slice(sepIdx + 1);
  if (wsId.length === 0 || toolName.length === 0) return null;
  if (!WORKSPACE_ID_RE.test(wsId)) return null;
  return { wsId, toolName };
}

/**
 * Build a namespaced tool name `ws_<id>-<toolName>`. Mirrors the
 * platform primitive `src/tools/namespace.ts::namespacedToolName` — same
 * `wsId` validation (via the codegen-shared `WORKSPACE_ID_RE`) and the
 * same single construction site discipline. Throws on invalid input.
 *
 * Used by the iframe bridge to prefix tool names before dispatching
 * `tools/call` against `/mcp` (Stage 2 / Q3: bridge auto-prefixes by
 * iframe-host workspace).
 */
export function namespacedToolName(wsId: string, toolName: string): string {
  if (typeof wsId !== "string" || wsId.length === 0) {
    throw new Error(`namespacedToolName: invalid wsId (empty)`);
  }
  if (!WORKSPACE_ID_RE.test(wsId)) {
    throw new Error(`namespacedToolName: invalid wsId "${wsId}" (failed WORKSPACE_ID_RE)`);
  }
  if (typeof toolName !== "string" || toolName.length === 0) {
    throw new Error(`namespacedToolName: invalid toolName (empty) for wsId "${wsId}"`);
  }
  return `${wsId}-${toolName}`;
}
