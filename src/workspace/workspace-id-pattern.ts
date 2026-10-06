/**
 * Shared workspace-id pattern — single source of truth.
 *
 * `WORKSPACE_ID_PATTERN` is the literal regex source string,
 * `WORKSPACE_ID_FLAGS` the literal flags string, and `WORKSPACE_ID_RE` the
 * compiled regex every call site uses.
 *
 * Keep this module pure — no imports, no side effects — so any module can
 * take the pattern without pulling in the workspace store.
 *
 * Format: `ws_` followed by exactly 16 lowercase hex chars, case-sensitive —
 * the one shape `WorkspaceStore.create` mints (`generateWorkspaceId`). It is
 * the only form the store creates, loads, or addresses: `create` asserts each
 * new id against it, and `list` skips a workspace directory whose name fails
 * it. Path-traversal segments (`..`, `/`),
 * hyphens, uppercase, and whitespace are all rejected, so `WorkspaceContext`
 * and the credential stores rely on this regex as the defense-in-depth
 * against directory traversal under workspace-scoped paths. The alphabet
 * excludes `-`, the workspace/tool separator in `ws_<id>-<tool>`.
 */

export const WORKSPACE_ID_PATTERN = "^ws_[a-f0-9]{16}$";
export const WORKSPACE_ID_FLAGS = "";
export const WORKSPACE_ID_RE = new RegExp(WORKSPACE_ID_PATTERN, WORKSPACE_ID_FLAGS);
