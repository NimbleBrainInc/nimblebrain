import { join } from "node:path";

/**
 * Single typed access path to identity-bound (cross-workspace) resources.
 *
 * The identity counterpart to `WorkspaceContext` (`src/workspace/context.ts`).
 * Where a `WorkspaceContext` scopes data to one workspace
 * (`workspaces/{wsId}/...`), an `IdentityContext` scopes data to one user
 * across every workspace they belong to — the home for surfaces the North
 * Star calls user-owned: conversations, files, automations.
 *
 * The orchestrator constructs one when routing an identity-scoped tool
 * name (`me-<tool>`, see `src/tools/namespace.ts`). Identity-scoped tools
 * (the `nb` system source; later conversations / files / automations)
 * dispatch against it instead of a workspace context, so they carry NO
 * ambient workspace authority — the trust boundary is the authenticated
 * identity, which is the actual scope of the data.
 *
 * What this does NOT own:
 *   - **Credentials.** Per Stage 2, a user's personal credentials live in
 *     their personal workspace (`ws_user_<userId>/credentials/...`), reached
 *     through that workspace's `WorkspaceContext` — not here. Keeping
 *     credentials out of the identity context preserves the single
 *     credential-path convention `check:credential-paths` enforces.
 *   - **Conversations.** Conversations are top-level + ownership-authorized
 *     (`{workDir}/conversations/{convId}.jsonl`, `ownerId === userId`), not
 *     under a per-user directory. Reach them via `runtime.findConversation`,
 *     not a path helper here.
 *
 * What it owns: per-user data directories at `{workDir}/users/{userId}/...`
 * (`files`, `skills`) — the North Star `users/{userId}/files/{fileId}`
 * layout that Phase B migrates onto.
 */

/**
 * Scopes available under a user's root directory (`{workDir}/users/{userId}/`).
 *   - `files`  — user-owned files (North Star `users/{userId}/files/`)
 *   - `skills` — per-user skills (existing layout, `users/<userId>/skills/`)
 * `root` returns the user root itself.
 */
export type IdentityScope = "root" | "files" | "skills";

const SUBPATH_FORBIDDEN_RE = /\0/;

/**
 * Reject obviously hostile subpath segments before they reach the
 * filesystem. Parallel to `assertSafeSubpathSegment` in
 * `src/workspace/context.ts` (kept inline rather than shared so the
 * identity layer doesn't import the workspace layer for a leaf check).
 */
function assertSafeSubpathSegment(segment: string, scope: IdentityScope): void {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new Error(`[identity-context] empty subpath segment for scope "${scope}"`);
  }
  if (segment === "." || segment === "..") {
    throw new Error(
      `[identity-context] subpath segment "${segment}" is not allowed (path traversal)`,
    );
  }
  if (SUBPATH_FORBIDDEN_RE.test(segment)) {
    throw new Error(
      `[identity-context] subpath segment contains a forbidden character (null byte)`,
    );
  }
  if (segment.includes("\\")) {
    throw new Error(
      `[identity-context] subpath segment "${segment}" contains a backslash; use forward slashes`,
    );
  }
  if (segment.startsWith("/")) {
    throw new Error(
      `[identity-context] absolute subpath "${segment}" is not allowed; pass relative segments`,
    );
  }
  for (const part of segment.split("/")) {
    if (part === "" || part === "." || part === "..") {
      throw new Error(
        `[identity-context] subpath segment "${segment}" resolves to a traversal component`,
      );
    }
  }
}

export class IdentityContext {
  readonly #userId: string;
  readonly #workDir: string;
  readonly #root: string;

  constructor(opts: { userId: string; workDir: string }) {
    // userIds have no single canonical regex across providers (`usr_<hex>`,
    // `usr_default`, `usr_oidc_<hash>`), so we can't validate shape the way
    // `WorkspaceContext` validates `WORKSPACE_ID_RE`. We DO reject the
    // traversal-shaped inputs that would let an id escape the `users/`
    // tree — the same defense-in-depth posture, applied to the segment.
    if (typeof opts.userId !== "string" || opts.userId.length === 0) {
      throw new Error(`[identity-context] userId is required (got "${opts.userId}")`);
    }
    // A userId is a single path segment, never a sub-path — reject `/`
    // outright (the segment validator tolerates `/` for convenience
    // subpaths like `mcp-oauth/google`, which is wrong for an id).
    if (opts.userId.includes("/")) {
      throw new Error(`[identity-context] userId must not contain "/": "${opts.userId}"`);
    }
    assertSafeSubpathSegment(opts.userId, "root");
    if (typeof opts.workDir !== "string" || opts.workDir.length === 0) {
      throw new Error(`[identity-context] workDir is required (got "${opts.workDir}")`);
    }
    this.#userId = opts.userId;
    this.#workDir = opts.workDir;
    this.#root = join(opts.workDir, "users", opts.userId);
  }

  /** The user id bound to this context. */
  get userId(): string {
    return this.#userId;
  }

  /** The platform-wide working directory (e.g. `~/.nimblebrain`). */
  get workDir(): string {
    return this.#workDir;
  }

  /** Absolute path to the user root (`{workDir}/users/{userId}`). */
  getRoot(): string {
    return this.#root;
  }

  /**
   * Absolute path to an identity-scoped directory or file.
   *
   *   ctx.getDataPath("files")                  → users/{userId}/files
   *   ctx.getDataPath("files", "<fileId>")      → users/{userId}/files/<fileId>
   *   ctx.getDataPath("skills")                 → users/{userId}/skills
   *
   * Subpath segments are validated against traversal / null bytes /
   * backslashes / absolute prefixes — see `assertSafeSubpathSegment`.
   */
  getDataPath(scope: IdentityScope, ...subpath: string[]): string {
    if (scope === "root") {
      if (subpath.length === 0) return this.#root;
      for (const segment of subpath) assertSafeSubpathSegment(segment, scope);
      return join(this.#root, ...subpath);
    }
    for (const segment of subpath) assertSafeSubpathSegment(segment, scope);
    return join(this.#root, scope, ...subpath);
  }
}
