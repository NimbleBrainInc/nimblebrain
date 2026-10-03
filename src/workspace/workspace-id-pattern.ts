/**
 * Shared workspace-id pattern — single source of truth.
 *
 * `WORKSPACE_ID_PATTERN` is the **literal regex source string**.
 * `WORKSPACE_ID_FLAGS` is the **literal flags string**.
 * `WORKSPACE_ID_RE` is the compiled regex used by every server-side
 * call site.
 *
 * **Why three exports, not one regex.** The web tier mirrors this
 * pattern (web/src/lib/namespaced-tool.ts parses `ws_<id>-<tool>`
 * strings) and cannot import from `src/`. It imports the literal pattern
 * and flags from a build-time codegen output
 * (`web/src/_generated/workspace-id-pattern.ts`, emitted by
 * `scripts/codegen-web-platform-schemas.ts` from this file) and constructs
 * its own `RegExp` locally. The shared literal is the contract; the regex
 * is rebuilt on each side, and `check:codegen` fails on drift.
 *
 * Keep this module pure — no imports, no side effects. The codegen step
 * extracts the two string literals textually.
 *
 * Format: `ws_` followed by exactly 16 lowercase hex chars, case-sensitive —
 * the one shape `WorkspaceStore.create` mints (`generateWorkspaceId`). It is
 * the only form the store creates, loads, or addresses: `create` asserts each
 * new id against it, and boot refuses a workspace directory whose name fails
 * it (`assertWorkspaceIdsConform`). Path-traversal segments (`..`, `/`),
 * hyphens, uppercase, and whitespace are all rejected, so `WorkspaceContext`
 * and the credential stores rely on this regex as the defense-in-depth
 * against directory traversal under workspace-scoped paths. The alphabet
 * excludes `-`, the workspace/tool separator in `ws_<id>-<tool>`.
 */

export const WORKSPACE_ID_PATTERN = "^ws_[a-f0-9]{16}$";
export const WORKSPACE_ID_FLAGS = "";
export const WORKSPACE_ID_RE = new RegExp(WORKSPACE_ID_PATTERN, WORKSPACE_ID_FLAGS);
