/**
 * Cross-workspace tool name primitive.
 *
 * **Single construction site for `ws_<id>/<toolName>`.** No other code
 * site in `src/` may build or parse this form by hand — the convention
 * is enforced by the `check:tool-namespace` AST lint
 * (`scripts/check-tool-namespace.ts`). See Stage 2 `SPEC_REFERENCE.md`
 * § "Constraints" item 6.
 *
 * Design rules (matching Stage 1 lessons):
 *
 * 1. **Strict invariants over defensive defaults** (lesson 3). Every
 *    invalid shape throws — no `??` / `?? null` / `?? ""` fallbacks
 *    anywhere. The orchestrator (T004) catches `UnknownNamespacedToolName`
 *    and decides what to do; the primitive does not guess.
 * 2. **Single source of truth for `wsId` validation.**
 *    `WORKSPACE_ID_RE` is imported from `src/workspace/workspace-store.ts`
 *    and never redefined locally. Same defense applies here as for the
 *    credential-store primitives: a wsId carrying path-traversal
 *    (`../etc`) or whitespace (`ws helix`) must be rejected at the
 *    construction site, not later.
 * 3. **First-slash split** when parsing. Tool names may contain `/`
 *    in the future (e.g. URL-shaped resource ids surfaced as tools).
 *    `parseNamespacedToolName("ws_helix/foo/bar")` returns
 *    `{ wsId: "ws_helix", toolName: "foo/bar" }`. The contract is
 *    asserted in `test/unit/tools/namespace.test.ts`.
 * 4. **No `as unknown as T` casts.** Pure string functions; type flow
 *    is direct.
 */

import { WORKSPACE_ID_RE } from "../workspace/workspace-store.ts";

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Thrown by `parseNamespacedToolName` when the input does not match
 * the `ws_<id>/<toolName>` shape, or when either component is invalid.
 *
 * The orchestrator catches this to distinguish "unparseable / unknown
 * tool name" from genuine tool errors. Don't conflate with
 * `WorkspaceNotFoundError` — this fires before the wsId is resolved
 * against the store.
 */
export class UnknownNamespacedToolName extends Error {
  /** The exact input string that failed to parse. */
  readonly input: string;
  /** Short machine-readable reason (`"missing_separator"`, `"invalid_wsid"`, `"empty_tool_name"`, `"empty_workspace_id"`). */
  readonly reason: string;

  constructor(input: string, reason: string, message: string) {
    super(message);
    this.name = "UnknownNamespacedToolName";
    this.input = input;
    this.reason = reason;
  }
}

/**
 * Thrown by `namespacedToolName` when either operand is invalid. Separate
 * class so callers can distinguish a malformed input string (parse-side)
 * from a malformed construction request (build-side); both are
 * programmer errors but they originate in different layers.
 */
export class InvalidNamespacedToolNameInput extends Error {
  readonly wsId: string;
  readonly toolName: string;
  readonly reason: string;

  constructor(wsId: string, toolName: string, reason: string, message: string) {
    super(message);
    this.name = "InvalidNamespacedToolNameInput";
    this.wsId = wsId;
    this.toolName = toolName;
    this.reason = reason;
  }
}

// ── Construction ──────────────────────────────────────────────────

/**
 * Build a namespaced tool name from a workspace id and a tool name.
 *
 * Returns `ws_<id>/<toolName>`. Throws `InvalidNamespacedToolNameInput`
 * on any invalid input:
 *   - `wsId` missing, empty, non-string, or failing `WORKSPACE_ID_RE`
 *     (path-traversal, whitespace, wrong prefix all rejected here).
 *   - `name` missing, empty, or non-string.
 *
 * No `??`/`||` defaulting; every invalid shape is fail-loud. The
 * orchestrator must surface the error rather than fall back to a
 * "current workspace."
 */
export function namespacedToolName(wsId: string, name: string): string {
  if (typeof wsId !== "string" || wsId.length === 0) {
    throw new InvalidNamespacedToolNameInput(
      String(wsId),
      String(name),
      "empty_workspace_id",
      "[tools/namespace] namespacedToolName: wsId is required (non-empty string)",
    );
  }
  if (!WORKSPACE_ID_RE.test(wsId)) {
    throw new InvalidNamespacedToolNameInput(
      wsId,
      String(name),
      "invalid_wsid",
      `[tools/namespace] namespacedToolName: invalid wsId "${wsId}" (must match WORKSPACE_ID_RE)`,
    );
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new InvalidNamespacedToolNameInput(
      wsId,
      String(name),
      "empty_tool_name",
      "[tools/namespace] namespacedToolName: tool name is required (non-empty string)",
    );
  }
  return `${wsId}/${name}`;
}

// ── Parsing ───────────────────────────────────────────────────────

/**
 * Parse a namespaced tool name back into `{ wsId, toolName }`.
 *
 * Takes the **first** `/` as the separator so tool names may contain
 * `/` themselves: `parseNamespacedToolName("ws_helix/foo/bar")` →
 * `{ wsId: "ws_helix", toolName: "foo/bar" }`. The intent is to keep
 * future tool sources (resources-as-tools, nested namespaces) viable
 * without re-cutting this contract.
 *
 * Throws `UnknownNamespacedToolName` on:
 *   - Input not a string, or empty.
 *   - No `/` separator (`"crm.search"`).
 *   - Empty workspace component (`"ws_/foo"`).
 *   - Empty tool name component (`"ws_helix/"`).
 *   - Workspace component fails `WORKSPACE_ID_RE`.
 *
 * Never returns `null`/`undefined`. Never silently falls back to a
 * "current workspace" — that decision belongs to the orchestrator, and
 * only after this primitive has confirmed the input *is* namespaced.
 */
export function parseNamespacedToolName(s: string): { wsId: string; toolName: string } {
  if (typeof s !== "string" || s.length === 0) {
    throw new UnknownNamespacedToolName(
      String(s),
      "empty_input",
      "[tools/namespace] parseNamespacedToolName: input is required (non-empty string)",
    );
  }
  const slashIdx = s.indexOf("/");
  if (slashIdx < 0) {
    throw new UnknownNamespacedToolName(
      s,
      "missing_separator",
      `[tools/namespace] parseNamespacedToolName: missing "/" separator in "${s}"`,
    );
  }
  const wsId = s.slice(0, slashIdx);
  const toolName = s.slice(slashIdx + 1);
  if (wsId.length === 0) {
    throw new UnknownNamespacedToolName(
      s,
      "empty_workspace_id",
      `[tools/namespace] parseNamespacedToolName: empty workspace id in "${s}"`,
    );
  }
  if (toolName.length === 0) {
    throw new UnknownNamespacedToolName(
      s,
      "empty_tool_name",
      `[tools/namespace] parseNamespacedToolName: empty tool name in "${s}"`,
    );
  }
  if (!WORKSPACE_ID_RE.test(wsId)) {
    throw new UnknownNamespacedToolName(
      s,
      "invalid_wsid",
      `[tools/namespace] parseNamespacedToolName: invalid workspace id "${wsId}" in "${s}"`,
    );
  }
  return { wsId, toolName };
}
