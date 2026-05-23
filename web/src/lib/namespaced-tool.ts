// ---------------------------------------------------------------------------
// Namespaced tool name — web-side parser (Stage 2 / T013, Q2)
//
// Mirrors the contract of `src/tools/namespace.ts::parseNamespacedToolName`.
// Web cannot import from `src/` directly (the web tsconfig only includes
// `./src` and the vite alias only covers `@/* → ./src/*`), so this file is
// the web-tier source of truth for parsing `ws_<id>/<tool_name>` strings.
//
// Contract — kept in lockstep with the platform primitive:
//   - First `/` is the separator. Tool names may contain `/` (the
//     trailing segment is preserved verbatim).
//   - `wsId` must match `WORKSPACE_ID_RE` (`^ws_[a-zA-Z0-9_-]+$`).
//   - No `??` / `||` fallback. Invalid shapes return `null` here (web
//     surfaces fall back to rendering the raw string per Q2 — "fall back
//     to raw if metadata missing"). The platform primitive throws; the
//     web primitive returns null so the transcript renderer can degrade
//     gracefully without an error boundary.
//
// Components must NEVER do `.split("/")` on a presumed namespaced name
// (task spec audit criterion "Namespace parsing via T002 only"). Use this
// helper or the platform primitive on the server side.
// ---------------------------------------------------------------------------

const WORKSPACE_ID_RE = /^ws_[a-zA-Z0-9_-]+$/;

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
  const slashIdx = s.indexOf("/");
  if (slashIdx < 0) return null;
  const wsId = s.slice(0, slashIdx);
  const toolName = s.slice(slashIdx + 1);
  if (wsId.length === 0 || toolName.length === 0) return null;
  if (!WORKSPACE_ID_RE.test(wsId)) return null;
  return { wsId, toolName };
}
