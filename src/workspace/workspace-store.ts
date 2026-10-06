import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../observability/log.ts";
import { writeJsonAtomic } from "../util/atomic-json.ts";
import { scaffoldWorkspace } from "./scaffold.ts";
import type { Workspace, WorkspaceMember, WorkspaceRole } from "./types.ts";
import { WORKSPACE_ID_RE } from "./workspace-id-pattern.ts";

// Re-export so `import { WORKSPACE_ID_RE } from ".../workspace-store.ts"`
// call sites work; the pattern itself lives in `workspace-id-pattern.ts`.
export { WORKSPACE_ID_RE } from "./workspace-id-pattern.ts";

// ── Errors ─────────────────────────────────────────────────────────

export class WorkspaceConflictError extends Error {
  constructor(id: string) {
    super(`A workspace with id "${id}" already exists`);
    this.name = "WorkspaceConflictError";
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(id: string) {
    super(`Workspace "${id}" not found`);
    this.name = "WorkspaceNotFoundError";
  }
}

export class MemberConflictError extends Error {
  constructor(wsId: string, userId: string) {
    super(`User "${userId}" is already a member of workspace "${wsId}"`);
    this.name = "MemberConflictError";
  }
}

// ── Membership-change subscription ─────────────────────────────────

/**
 * Fired after a successful mutation that changes which workspaces a
 * user is a member of: `addMember`, `removeMember`, `delete` (for every
 * former member), and `create` (for every initial member). NOT fired
 * for `updateMemberRole` — role changes don't affect set membership,
 * and the SSE manager's only consumer cares about presence, not role.
 *
 * Handlers run synchronously after the atomic write succeeds. Errors
 * in a handler are caught and logged so a buggy subscriber can't
 * derail a workspace mutation.
 */
export type MembershipChangeHandler = (userId: string) => void;

// ── Workspace ID validation ────────────────────────────────────────

// `WORKSPACE_ID_RE` lives in `./workspace-id-pattern.ts`; re-exported above.

// ── Opaque id generation ───────────────────────────────────────────

/**
 * Generate an opaque, name-independent workspace id.
 *
 * **Why opaque.** A workspace id is a stable handle, not a label. An id
 * derived from the name would freeze the name at create time into the URL
 * and the on-disk dir, so a rename could never reach them. Keeping the id
 * independent of the name makes the name a freely editable field that never
 * moves the id, the dir, or the URL. It is also the only way an id is made:
 * `WorkspaceStore.create` takes no caller-chosen id.
 *
 * **Alphabet.** The id MUST match `WORKSPACE_ID_PATTERN` (`^ws_[a-f0-9]{16}$`),
 * which `create` asserts — no hyphens, because `-` is the workspace/tool
 * separator in `ws_<id>-<tool>` (see `src/tools/namespace.ts`), so it
 * round-trips through `parseNamespacedToolName` cleanly. This mirrors the
 * established opaque-id idiom for users (`usr_<hex>`, `src/identity/user.ts`)
 * and files (`fl_<hex>`, `src/files/store.ts`).
 *
 * 16 hex chars = 64 bits of entropy. Collisions are astronomically
 * unlikely, but `create` still does a conflict check and retries against
 * this generator, so a collision self-heals rather than surfacing.
 */
export function generateWorkspaceId(): string {
  return `ws_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Best-effort lookup of a workspace's human-readable `name` for display to
 * a third party — currently the OAuth `client_name` a remote vendor renders
 * on its consent screen (see `WorkspaceOAuthProvider.ownerDisplayName`).
 *
 * Returns `undefined` when the workspace can't be read or has no name, so
 * the caller cleanly falls back to the opaque id. Deliberately non-throwing:
 * a cosmetic label must never block an auth flow. Constructs a throwaway
 * store from `workDir` — cheap, and these are infrequent (interactive auth
 * start / connector boot) paths, not hot loops.
 */
export async function resolveWorkspaceDisplayName(
  workDir: string,
  wsId: string,
): Promise<string | undefined> {
  try {
    const ws = await new WorkspaceStore(workDir).get(wsId);
    return ws?.name || undefined;
  } catch {
    return undefined;
  }
}

// ── Archive (tombstone) marker ─────────────────────────────────────

/** Filename of the per-archive tombstone marker dropped by `delete`. */
export const ARCHIVE_MARKER_FILENAME = ".archived.json";

/**
 * Tombstone written to `archived/<wsId>/.archived.json` when a workspace
 * is deleted.
 *
 * Deletion is archive-then-cascade: the workspace's data subtree is moved
 * under `archived/` rather than
 * destroyed, so it stays recoverable/exportable until an org admin purges it
 * from Organization → Archives (`manage_workspaces` `list_archives` /
 * `purge_archive`, over `src/workspace/archives.ts`). Nothing purges one
 * automatically (default: keep).
 *
 * The marker deliberately omits a self-reported timestamp: the archive
 * dir's mtime (set at move time) is the authoritative archival time, so
 * duplicating it here would only invite drift. Keeping the marker to a
 * fixed shape also keeps archive contents deterministic for tests.
 */
export interface ArchiveMarker {
  wsId: string;
  archivedReason: "workspace_deleted";
}

// ── WorkspaceStore ─────────────────────────────────────────────────

export class WorkspaceStore {
  private workspacesDir: string;
  private archivedDir: string;
  private membershipChangeHandlers = new Set<MembershipChangeHandler>();
  private warnedNonConforming = new Set<string>();

  constructor(workDir: string) {
    this.workspacesDir = join(workDir, "workspaces");
    // Sibling of `workspaces/` — tombstoned subtrees land here on delete.
    // Created lazily (in `delete`), not here, so the many throwaway stores
    // (e.g. `resolveWorkspaceDisplayName`) don't litter empty `archived/`.
    this.archivedDir = join(workDir, "archived");
    if (!existsSync(this.workspacesDir)) {
      mkdirSync(this.workspacesDir, { recursive: true });
    }
  }

  /**
   * Absolute path to the `workspaces/` directory. Exposed for migration
   * scripts that need to address per-workspace files directly (e.g.,
   * rewriting `workspace.json` outside the patchable surface of
   * `update()`). Not for general use — `get` / `list` / `update` are
   * the canonical surfaces.
   */
  getWorkspacesDir(): string {
    return this.workspacesDir;
  }

  /**
   * Absolute path to the `archived/` tombstone directory, where `delete`
   * moves a workspace's data subtree. `manage_workspaces` reads it to list
   * and purge archives for the org-admin Archives tab; nothing sweeps it
   * (see `delete`). Created lazily on the first archive, so this path may not
   * exist yet.
   */
  getArchivedDir(): string {
    return this.archivedDir;
  }

  async get(id: string): Promise<Workspace | null> {
    if (!WORKSPACE_ID_RE.test(id)) return null;
    const filePath = this.wsPath(id);
    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as Workspace;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(): Promise<Workspace[]> {
    let entries: string[];
    try {
      entries = await readdir(this.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const workspaces: Workspace[] = [];
    for (const entry of entries) {
      if (!entry.startsWith("ws_")) continue;
      if (!WORKSPACE_ID_RE.test(entry)) {
        this.warnNonConforming(entry);
        continue;
      }
      const ws = await this.get(entry);
      if (ws) workspaces.push(ws);
    }

    // `createdAt` is millisecond-precision, so two workspaces created in the
    // same millisecond compare equal, and the pre-sort order is whatever
    // `readdir` returned — filesystem-dependent, and not stable across hosts.
    // Ids are unique, so breaking the tie on id makes the order total.
    workspaces.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return workspaces;
  }

  /**
   * `list` skips a `ws_*` directory whose name is not a workspace id, because
   * no door can address it, and names it once per store so it is not
   * invisible.
   */
  private warnNonConforming(entry: string): void {
    if (this.warnedNonConforming.has(entry) || !existsSync(this.wsPath(entry))) return;
    this.warnedNonConforming.add(entry);
    log.warn(
      `[workspace] skipping workspaces/${entry}: its name is not a workspace id ` +
        "(ws_ and 16 lowercase hex chars). Rename it to a generated id to serve it.",
    );
  }

  /**
   * Generate an opaque, collision-free workspace id.
   *
   * 64 bits of entropy makes a collision astronomically unlikely; the
   * bounded retry is defense-in-depth so the rare case self-heals instead
   * of surfacing a confusing conflict to the operator. Every candidate is
   * asserted against WORKSPACE_ID_RE before it is used, so a generator that
   * drifts from the opaque form throws here rather than minting an id the
   * store could never load.
   */
  private async generateUniqueWorkspaceId(): Promise<string> {
    const MAX_ID_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const candidate = generateWorkspaceId();
      if (!WORKSPACE_ID_RE.test(candidate)) {
        throw new Error(
          `[workspace-store] create: generated workspace id "${candidate}" does not match ${WORKSPACE_ID_RE}`,
        );
      }
      if (!(await this.get(candidate))) return candidate;
    }
    throw new Error(
      `[workspace-store] create: could not generate a collision-free workspace id after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }

  /**
   * Create a workspace. Its id is always generated (`ws_<16-hex>`, see
   * `generateWorkspaceId`); no caller chooses it, so no id can encode a name,
   * a user, or a tenant, and every id the store mints has the one shape it
   * loads.
   */
  async create(
    name: string,
    opts?: {
      /** Short human-readable description; defaults to `null`. */
      about?: string | null;
      /**
       * Initial members. Defaults to `[]` (the caller invokes `addMember`
       * afterwards to populate).
       */
      members?: WorkspaceMember[];
    },
  ): Promise<Workspace> {
    const id = await this.generateUniqueWorkspaceId();

    const members = opts?.members ?? [];

    // `generateUniqueWorkspaceId` already retried past collisions; this is
    // a cheap final assertion against a create racing in between.
    const existing = await this.get(id);
    if (existing) {
      throw new WorkspaceConflictError(id);
    }

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id,
      name,
      members,
      connectors: [],
      createdAt: now,
      updatedAt: now,
      about: opts?.about ?? null,
    };

    const wsDir = join(this.workspacesDir, id);
    mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    await this.atomicWrite(this.wsPath(id), workspace);
    await scaffoldWorkspace(wsDir);

    // Initial members gain a workspace from their POV; notify subscribers
    // (the SSE manager re-queries memberships for any connected client
    // whose identity matches).
    for (const m of members) this.fireMembershipChanged(m.userId);

    return workspace;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Workspace,
        | "name"
        | "connectors"
        | "skillDirs"
        | "models"
        | "oauthOperatorApps"
        | "hooks"
        | "notifications"
        | "about"
      >
    >,
  ): Promise<Workspace | null> {
    const ws = await this.get(id);
    if (!ws) return null;

    // `members` is not patchable here — membership changes go through
    // `addMember` / `removeMember` / `updateMemberRole`, which fire the
    // membership-change notifications. The Pick<> excludes it at the type
    // level; strip it at runtime too, since a caller can cast past the type.
    const { members: _members, ...safePatch } = patch as Partial<Workspace>;

    const updated: Workspace = {
      ...ws,
      ...safePatch,
      updatedAt: new Date().toISOString(),
    };

    await this.atomicWrite(this.wsPath(id), updated);
    return updated;
  }

  /**
   * Delete a workspace — **archive-then-cascade, not hard `rm`**.
   *
   * A workspace owns its data subtree (`workspaces/<wsId>/`: the workspace
   * record, credentials, skills, files, and conversations as they migrate
   * under it), so deletion must handle that subtree rather than orphan or
   * destroy it. Instead of removing the directory, we *tombstone* it: move
   * the whole subtree to `archived/<wsId>/` (a same-filesystem `rename(2)`)
   * and drop a `.archived.json` marker. The data stays recoverable /
   * exportable until an org admin purges that one archive from
   * Organization → Archives — nothing purges automatically (default: keep).
   *
   * From every other surface the workspace is gone the moment this
   * returns: `get`/`list` read `workspaces/`, which no longer holds the
   * subtree. Membership-change notifications fire for each former member,
   * exactly as before (the only change is on-disk: archive vs. destroy).
   *
   * Returns `false` (idempotent no-op) when no such workspace dir exists.
   *
   * `archiveSuffix` disambiguates a same-id re-archive — rare, since new ids
   * are random; it takes a record with the same id placed on disk again
   * after a delete (a restore, or a test fixture). When
   * `archived/<wsId>/` is already occupied the suffix is appended
   * (`archived/<wsId>-<suffix>/`); absent a suffix the store probes a
   * deterministic incrementing counter (`-1`, `-2`, …). The path carries
   * no wall-clock or randomness, so archives stay reproducible for tests
   * and legible to an operator.
   */
  async delete(id: string, opts?: { archiveSuffix?: string }): Promise<boolean> {
    const wsDir = join(this.workspacesDir, id);
    if (!existsSync(wsDir)) return false;
    // Read members BEFORE moving — we need them to fire change
    // notifications. A corrupted dir (missing workspace.json) yields
    // `null` and we simply don't fire; nothing to invalidate.
    const ws = await this.get(id);

    // Tombstone the subtree: move it under `archived/` rather than rm-ing
    // it. The move is an atomic same-filesystem rename — no copy, and no
    // window where the subtree is half-present in both trees.
    mkdirSync(this.archivedDir, { recursive: true });
    const dest = this.resolveArchiveDest(id, opts?.archiveSuffix);
    await rename(wsDir, dest);
    const marker: ArchiveMarker = { wsId: id, archivedReason: "workspace_deleted" };
    await writeJsonAtomic(join(dest, ARCHIVE_MARKER_FILENAME), marker);

    if (ws) {
      for (const m of ws.members) this.fireMembershipChanged(m.userId);
    }
    return true;
  }

  /**
   * Resolve a free destination under `archived/` for `id`'s subtree.
   *
   * Prefers `archived/<id>`. On collision (a same-id workspace archived
   * before) a caller-supplied `suffix` wins (`archived/<id>-<suffix>`);
   * otherwise an incrementing counter is probed. Pure path resolution plus
   * `existsSync` — deterministic, no wall-clock or randomness — so the
   * chosen path is reproducible for tests and predictable for operators.
   */
  private resolveArchiveDest(id: string, suffix?: string): string {
    const base = join(this.archivedDir, id);
    if (!existsSync(base)) return base;

    if (suffix !== undefined && suffix !== "") {
      const withSuffix = join(this.archivedDir, `${id}-${suffix}`);
      if (!existsSync(withSuffix)) return withSuffix;
    }

    const MAX_ARCHIVE_ATTEMPTS = 10_000;
    for (let n = 1; n <= MAX_ARCHIVE_ATTEMPTS; n++) {
      const candidate = join(this.archivedDir, `${id}-${n}`);
      if (!existsSync(candidate)) return candidate;
    }
    throw new Error(
      `[workspace-store] delete: could not find a free archive destination for "${id}" after ${MAX_ARCHIVE_ATTEMPTS} attempts`,
    );
  }

  // ── Member operations ──────────────────────────────────────────

  async addMember(wsId: string, userId: string, role: WorkspaceRole): Promise<Workspace> {
    const ws = await this.get(wsId);
    if (!ws) throw new WorkspaceNotFoundError(wsId);

    const existing = ws.members.find((m) => m.userId === userId);
    if (existing) throw new MemberConflictError(wsId, userId);

    const member: WorkspaceMember = { userId, role };
    const updated: Workspace = {
      ...ws,
      members: [...ws.members, member],
      updatedAt: new Date().toISOString(),
    };

    await this.atomicWrite(this.wsPath(wsId), updated);
    this.fireMembershipChanged(userId);
    return updated;
  }

  async removeMember(wsId: string, userId: string): Promise<Workspace> {
    const ws = await this.get(wsId);
    if (!ws) throw new WorkspaceNotFoundError(wsId);

    const wasMember = ws.members.some((m) => m.userId === userId);
    const updated: Workspace = {
      ...ws,
      members: ws.members.filter((m) => m.userId !== userId),
      updatedAt: new Date().toISOString(),
    };

    await this.atomicWrite(this.wsPath(wsId), updated);
    // Only fire if this was an actual removal — a no-op removeMember
    // (user wasn't a member to start with) shouldn't generate spurious
    // cache invalidations.
    if (wasMember) this.fireMembershipChanged(userId);
    return updated;
  }

  async updateMemberRole(wsId: string, userId: string, role: WorkspaceRole): Promise<Workspace> {
    const ws = await this.get(wsId);
    if (!ws) throw new WorkspaceNotFoundError(wsId);

    const updated: Workspace = {
      ...ws,
      members: ws.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
      updatedAt: new Date().toISOString(),
    };

    await this.atomicWrite(this.wsPath(wsId), updated);
    return updated;
  }

  async getWorkspacesForUser(userId: string): Promise<Workspace[]> {
    const all = await this.list();
    return all.filter((ws) => ws.members.some((m) => m.userId === userId));
  }

  // ── Membership-change subscriptions ────────────────────────────

  /**
   * Subscribe to membership-change notifications. Returns an unsubscribe
   * function. Fires after `addMember`, `removeMember`, `create`, and
   * `delete` for every affected `userId` (see `MembershipChangeHandler`).
   * The SSE event manager uses this to invalidate its per-client cached
   * workspace-membership set without polling the store on every emit.
   */
  onMembershipChanged(handler: MembershipChangeHandler): () => void {
    this.membershipChangeHandlers.add(handler);
    return () => {
      this.membershipChangeHandlers.delete(handler);
    };
  }

  /**
   * Fire all registered membership-change handlers for a userId. Handler
   * errors are caught and logged so a buggy subscriber can't break a
   * workspace mutation. Synchronous — handlers themselves may schedule
   * async work (e.g. the SSE manager refreshes a client's cached set).
   */
  private fireMembershipChanged(userId: string): void {
    for (const handler of this.membershipChangeHandlers) {
      try {
        handler(userId);
      } catch (err) {
        log.warn("[workspace-store] membership change handler threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────

  private wsPath(id: string): string {
    return join(this.workspacesDir, id, "workspace.json");
  }

  private async atomicWrite(filePath: string, data: Workspace): Promise<void> {
    await writeJsonAtomic(filePath, data);
  }
}
