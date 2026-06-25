import { join } from "node:path";
import { WorkspaceCredentialStore } from "../config/workspace-credentials.ts";
import { WORKSPACE_ID_RE } from "./workspace-store.ts";

/**
 * Single typed access path to workspace-bound resources.
 *
 * Background: NimbleBrain historically threaded `(wsId, workDir)` pairs
 * through every workspace-scoped code path, and dozens of independent
 * call sites constructed `join(workDir, "workspaces", wsId, ...)` for
 * themselves. That made workspace isolation a discipline problem rather
 * than a structural one — a single new caller forgetting to validate or
 * mis-typing the path could escape the workspace tree, and there was no
 * way to grep for "everywhere that touches workspace state."
 *
 * `WorkspaceContext` is the structural fix:
 *
 *   - Constructed once per workspace with `{ wsId, workDir }`. The wsId
 *     is validated against `WORKSPACE_ID_RE` at construction and bound to
 *     the instance as `readonly`. No method on this class takes a `wsId`
 *     argument — the context's wsId is implicit in every operation.
 *
 *   - Owns a `WorkspaceCredentialStore` constructed with the same wsId.
 *     Callers get the bound store via `getCredentialStore()` and never
 *     have a way to construct one for a different workspace through this
 *     context.
 *
 *   - Exposes typed path helpers (`getRoot`, `getDataPath`) so call sites
 *     don't reconstruct the `workspaces/{wsId}/{scope}` layout by hand.
 *
 * The orchestrator (the only entity in the system that legitimately holds
 * more than one `WorkspaceContext`) routes cross-workspace tool calls by
 * looking up the destination workspace's context and dispatching against
 * it. Everything below the orchestrator gets exactly one context and
 * cannot leak across the boundary by construction.
 */

/**
 * Scopes available under a workspace's root. These map 1:1 to the
 * directories created by `scaffoldWorkspace` (see `src/workspace/scaffold.ts`):
 *
 *   - `data`           — bundle data dirs (`{name}/...`)
 *   - `credentials`    — per-bundle credentials, OAuth tokens, secrets
 *   - `conversations`    — JSONL message persistence
 *   - `skills`           — workspace-installed (authored) skills
 *   - `connector-skills` — materialized connector overlays; a SIBLING of
 *     `skills/`, never read by the authored-skill loader
 *   - `files`            — uploaded files / file context
 *
 * `root` returns the workspace root itself (`workspaces/{wsId}/`); it is
 * the parent of every other scope and most callers should prefer a
 * specific scope over `root` so the intent is legible.
 */
export type WorkspaceScope =
  | "root"
  | "data"
  | "credentials"
  | "conversations"
  | "skills"
  | "connector-skills"
  | "files";

const SUBPATH_FORBIDDEN_RE = /\0/;

/**
 * Validate a subpath segment. We don't try to canonicalize the path here —
 * `join` handles the assembly — but we reject obviously hostile inputs
 * before they reach the filesystem:
 *
 *   - Empty strings (would silently no-op the join and yield the parent)
 *   - `.` and `..` segments (path traversal)
 *   - Embedded null bytes (truncates filenames on some kernels)
 *   - Absolute paths and Windows drive letters (would discard our prefix)
 *   - Backslashes (Windows path separators that some callers mis-emit)
 *
 * Bundle data dirs, server names, and the like are already validated by
 * their producers; this check is defense in depth against a future caller
 * who forgets.
 */
function assertSafeSubpathSegment(segment: string, scope: WorkspaceScope): void {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new Error(`[workspace-context] empty subpath segment for scope "${scope}"`);
  }
  if (segment === "." || segment === "..") {
    throw new Error(
      `[workspace-context] subpath segment "${segment}" is not allowed (path traversal)`,
    );
  }
  if (SUBPATH_FORBIDDEN_RE.test(segment)) {
    throw new Error(
      `[workspace-context] subpath segment contains a forbidden character (null byte)`,
    );
  }
  if (segment.includes("\\")) {
    throw new Error(
      `[workspace-context] subpath segment "${segment}" contains a backslash; use forward slashes`,
    );
  }
  // Absolute paths would clobber the workspace prefix when passed to `join`.
  // Checked before the slash-split traversal scan below so a clear
  // "absolute subpath" message wins over the more generic traversal one.
  if (segment.startsWith("/")) {
    throw new Error(
      `[workspace-context] absolute subpath "${segment}" is not allowed; pass relative segments`,
    );
  }
  // Splitting on `/` lets callers pass `"mcp-oauth/google"` as one segment
  // for convenience; we still need to reject `..` anywhere in that split.
  for (const part of segment.split("/")) {
    if (part === "" || part === "." || part === "..") {
      throw new Error(
        `[workspace-context] subpath segment "${segment}" resolves to a traversal component`,
      );
    }
  }
}

export class WorkspaceContext {
  readonly #wsId: string;
  readonly #workDir: string;
  readonly #root: string;
  readonly #credentialStore: WorkspaceCredentialStore;

  constructor(opts: { wsId: string; workDir: string }) {
    if (typeof opts.wsId !== "string" || !WORKSPACE_ID_RE.test(opts.wsId)) {
      throw new Error(
        `[workspace-context] invalid wsId: "${opts.wsId}". Must match /^ws_[a-z0-9_]{1,64}$/i.`,
      );
    }
    if (typeof opts.workDir !== "string" || opts.workDir.length === 0) {
      throw new Error(`[workspace-context] workDir is required (got "${opts.workDir}")`);
    }
    this.#wsId = opts.wsId;
    this.#workDir = opts.workDir;
    this.#root = join(opts.workDir, "workspaces", opts.wsId);
    this.#credentialStore = new WorkspaceCredentialStore({
      wsId: opts.wsId,
      workDir: opts.workDir,
    });
  }

  /** The workspace id bound to this context. */
  get workspaceId(): string {
    return this.#wsId;
  }

  /**
   * The platform-wide working directory (e.g. `~/.nimblebrain`).
   *
   * Exposed because some legacy call sites need the global root for
   * non-workspace-scoped paths (the workspace tree itself, instance.json,
   * the bundle registry cache). New code should treat this as an
   * implementation detail and prefer the scope-aware helpers below.
   */
  get workDir(): string {
    return this.#workDir;
  }

  /** Absolute path to the workspace root (`{workDir}/workspaces/{wsId}`). */
  getRoot(): string {
    return this.#root;
  }

  /**
   * Absolute path to a workspace-scoped directory or file.
   *
   *   ctx.getDataPath("root")                                  → workspaces/ws_x
   *   ctx.getDataPath("conversations")                          → workspaces/ws_x/conversations
   *   ctx.getDataPath("credentials", "mcp-oauth", "google")     → .../credentials/mcp-oauth/google
   *   ctx.getDataPath("data", deriveBundleDataDir(name))        → .../data/{slug}
   *
   * Subpath segments are validated against path traversal, embedded null
   * bytes, backslashes, and absolute prefixes — see `assertSafeSubpathSegment`
   * above. A bare `getDataPath(scope)` with no subpath returns the scope
   * directory itself.
   */
  getDataPath(scope: WorkspaceScope, ...subpath: string[]): string {
    if (scope === "root") {
      if (subpath.length === 0) return this.#root;
      for (const segment of subpath) assertSafeSubpathSegment(segment, scope);
      return join(this.#root, ...subpath);
    }
    for (const segment of subpath) assertSafeSubpathSegment(segment, scope);
    return join(this.#root, scope, ...subpath);
  }

  /**
   * The credential store bound to this workspace. The returned object's
   * `wsId` matches this context's; there is no way to obtain a credential
   * store for a different workspace through this context.
   */
  getCredentialStore(): WorkspaceCredentialStore {
    return this.#credentialStore;
  }

  /**
   * Convenience: equivalent to `getCredentialStore().get(bundleName)`.
   *
   * Provided because the credential read is by far the most common
   * single-shot operation, and threading the store through every call
   * site that just wants `{api_key: ...}` is noisy.
   */
  async getCredentials(bundleName: string): Promise<Record<string, string> | null> {
    return this.#credentialStore.get(bundleName);
  }
}
