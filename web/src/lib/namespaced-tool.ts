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
 * The scope a tool name dispatches into. Mirrors `ToolScope` in
 * `src/tools/namespace.ts`: a workspace (`ws_<id>-`) or identity (bare).
 */
export type ToolScope = { kind: "workspace"; wsId: string } | { kind: "identity" };

/**
 * Parse a tool name into `{ scope, toolName }`. Returns `null` only for
 * empty/non-string input or a malformed `ws_<id>-` prefix — callers render
 * the raw input in that case (Q2: "fall back to raw if metadata missing").
 *
 * Grammar mirrors the platform primitive: `ws_<id>-<toolName>` → workspace
 * (toolName is the remainder); a **bare** name → `{ kind: "identity" }` with
 * toolName = the whole input (no prefix to strip). The web parser returns
 * null instead of throwing so a transcript renderer degrades gracefully.
 */
export function parseNamespacedToolName(s: string): { scope: ToolScope; toolName: string } | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const sepIdx = s.indexOf("-");
  if (sepIdx > 0) {
    const head = s.slice(0, sepIdx);
    if (WORKSPACE_ID_RE.test(head)) {
      const toolName = s.slice(sepIdx + 1);
      if (toolName.length === 0) return null;
      return { scope: { kind: "workspace", wsId: head }, toolName };
    }
    // Looks like a workspace attempt but the id is malformed → render raw.
    if (head.startsWith("ws_")) return null;
  }
  // Bare: the whole name is the identity tool name (no prefix to strip).
  return { scope: { kind: "identity" }, toolName: s };
}

/**
 * Build a workspace-scoped tool name `ws_<id>-<toolName>`. Mirrors the
 * platform primitive `src/tools/namespace.ts::namespacedToolName` — same
 * `wsId` validation (via the codegen-shared `WORKSPACE_ID_RE`) and the
 * same single construction site discipline. Throws on invalid input.
 *
 * Used by the iframe bridge to prefix a workspace app's tool names before
 * dispatching `tools/call` against `/mcp`.
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

// Identity tools have no builder: an identity tool's wire name IS its bare
// `<source>__<tool>` form. Absence of a `ws_<id>-` prefix makes it identity-scoped.

/**
 * Extract the **bare source/app name** from a full wire tool name.
 *
 * A wire name is `[ws_<id>-]<source>__<tool>`. The REST surfaces that own a
 * resource — `POST /v1/resources/read`, `GET /v1/apps/:name/resources/*` —
 * key the workspace registry by the **bare** source name (`synapse-collateral`),
 * NOT the namespaced one. Hand-slicing on `__` alone leaves the `ws_<id>-`
 * prefix attached (`ws_<id>-synapse-collateral`), which then fails
 * `registry.hasSource()` with a 403 "not available in this workspace". Parse
 * the namespace via the sanctioned primitive first, then drop the `__<tool>`
 * tail. Returns `undefined` when there's no `__` (not an app-owned call).
 */
export function appNameFromToolName(wireName: string): string | undefined {
  const parsed = parseNamespacedToolName(wireName);
  // `toolName` is the post-`ws_<id>-` remainder (or the whole bare name).
  const rest = parsed ? parsed.toolName : wireName;
  const sep = rest.indexOf("__");
  return sep > 0 ? rest.slice(0, sep) : undefined;
}
