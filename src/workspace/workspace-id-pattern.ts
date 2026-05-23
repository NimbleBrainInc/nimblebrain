/**
 * Shared workspace-id pattern — single source of truth.
 *
 * `WORKSPACE_ID_PATTERN` is the **literal regex source string**.
 * `WORKSPACE_ID_FLAGS` is the **literal flags string**.
 * `WORKSPACE_ID_RE` is the compiled regex used by every server-side
 * call site.
 *
 * **Why three exports, not one regex.** The web tier mirrors this
 * pattern (web/src/lib/namespaced-tool.ts parses `ws_<id>/<tool>`
 * strings). Pre-Stage-2 the web copy was a hand-written regex that
 * diverged from the server's — web allowed hyphens, server did not.
 * That's a "kept in sync by hope" pattern Mat's Stage-2 directive
 * forbids. The fix: the web file imports the literal pattern + flags
 * from a build-time codegen output (`web/src/_generated/workspace-id-pattern.ts`,
 * emitted by `scripts/codegen-web-platform-schemas.ts` from this file)
 * and constructs its own `RegExp` locally. The shared literal is the
 * contract; the regex is rebuilt on each side. A
 * `web/test/namespaced-tool.test.ts` assertion compares the web copy's
 * `RegExp.source` to the imported `WORKSPACE_ID_PATTERN` so any future
 * server-side tightening propagates via the codegen step.
 *
 * Keep this module pure — no imports, no side effects. Anything else
 * would block the codegen's `tsc --emitDeclarationOnly`-style copy
 * from being a one-file include.
 *
 * Format: `ws_` prefix followed by 1–64 alphanumeric/underscore chars,
 * case-insensitive. Path-traversal segments (`..`, `/`), hyphens, and
 * whitespace are all rejected. The credential-store primitives in
 * `src/config/workspace-credentials.ts` rely on this regex as the
 * defense-in-depth against directory traversal under workspace-scoped
 * paths.
 */

export const WORKSPACE_ID_PATTERN = "^ws_[a-z0-9_]{1,64}$";
export const WORKSPACE_ID_FLAGS = "i";
export const WORKSPACE_ID_RE = new RegExp(WORKSPACE_ID_PATTERN, WORKSPACE_ID_FLAGS);
