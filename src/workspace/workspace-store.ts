import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../observability/log.ts";
import { writeJsonAtomic } from "../util/atomic-json.ts";
import { TOMBSTONE_FILENAME } from "./context.ts";
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
 * user is a member of: `addMember`, `removeMember`, `delete` and `restore`
 * (for every member), and `create` (for every initial member). NOT fired
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

// ── Tombstone ──────────────────────────────────────────────────────

/**
 * Why a workspace is deleted and when it goes: `workspaces/<wsId>/deleted.json`.
 *
 * A deleted workspace keeps every record it had (its `workspace.json`, members,
 * connectors, files, credentials) until the kernel purges it, so a restore puts
 * it back as it was. The tombstone is its own file rather than a field of the
 * record, so no read-modify-write of the record can drop it or bring it back.
 */
export interface WorkspaceTombstone {
  deletedAt: string;
  /** The signed-in identity that deleted it, when there was one: shown to admins. */
  deletedBy: string | null;
  /**
   * When the purge began, or when an admin asked for it now. Set once and
   * never cleared: from then on the workspace cannot be restored, so a purge
   * that stopped halfway is only ever finished.
   */
  purgeAt?: string;
}

/** A deleted workspace: its tombstone, and its record while the purge has not removed it. */
export interface DeletedWorkspace {
  id: string;
  /** `null` once a purge has removed the record and not yet the rest. */
  workspace: Workspace | null;
  tombstone: WorkspaceTombstone;
}

// ── WorkspaceStore ─────────────────────────────────────────────────

export class WorkspaceStore {
  private workspacesDir: string;
  private archivedDir: string;
  private membershipChangeHandlers = new Set<MembershipChangeHandler>();
  private readonly createdHandlers = new Set<(workspace: Workspace) => void>();
  private readonly memberAddedHandlers = new Set<
    (wsId: string, userId: string, role: WorkspaceRole) => void
  >();
  private warnedNonConforming = new Set<string>();

  constructor(workDir: string) {
    this.workspacesDir = join(workDir, "workspaces");
    // Where earlier releases moved a deleted workspace. Nothing writes here; the
    // purge removes what is left once the retention window has passed.
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

  /** The live workspace: `null` for an unknown id and for a deleted workspace alike. */
  async get(id: string): Promise<Workspace | null> {
    if (!WORKSPACE_ID_RE.test(id) || this.isDeleted(id)) return null;
    return this.readRecord(id);
  }

  /** The record on disk, deleted or not. */
  private async readRecord(id: string): Promise<Workspace | null> {
    const filePath = this.wsPath(id);
    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as Workspace;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Every live workspace; a deleted one is left out. */
  async list(): Promise<Workspace[]> {
    const workspaces: Workspace[] = [];
    for (const entry of await this.entries()) {
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

  /** The directory names under `workspaces/` that are workspace ids. */
  private async entries(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return entries.filter((entry) => {
      if (!entry.startsWith("ws_")) return false;
      if (WORKSPACE_ID_RE.test(entry)) return true;
      this.warnNonConforming(entry);
      return false;
    });
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
    this.notify(this.createdHandlers, (h) => h(workspace));
    for (const m of members) this.notify(this.memberAddedHandlers, (h) => h(id, m.userId, m.role));

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
        | "oauthClients"
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
   * Delete a workspace: write its tombstone. From that moment `get` and `list`
   * leave it out, so every door answers it as not found, and nothing else
   * changes: its record, members, connectors and data stay where they are until
   * the runtime purges it (`Runtime.purgeWorkspace`), so `restore` puts it back
   * as it was. Membership-change notifications fire for each member.
   *
   * Returns `false` when no live workspace has the id (unknown, or already
   * deleted).
   */
  async delete(id: string, opts: { deletedBy?: string | null } = {}): Promise<boolean> {
    const ws = await this.get(id);
    if (!ws) return false;
    const tombstone: WorkspaceTombstone = {
      deletedAt: new Date().toISOString(),
      deletedBy: opts.deletedBy ?? null,
    };
    await writeJsonAtomic(this.tombstonePath(id), tombstone);
    for (const m of ws.members) this.fireMembershipChanged(m.userId);
    return true;
  }

  /** Whether `id` has a tombstone. Synchronous, for a check that must not yield. */
  isDeleted(id: string): boolean {
    return WORKSPACE_ID_RE.test(id) && existsSync(this.tombstonePath(id));
  }

  /** One deleted workspace, or `null` when `id` has no tombstone. */
  async getDeleted(id: string): Promise<DeletedWorkspace | null> {
    if (!WORKSPACE_ID_RE.test(id)) return null;
    let tombstone: WorkspaceTombstone;
    try {
      tombstone = JSON.parse(await readFile(this.tombstonePath(id), "utf-8")) as WorkspaceTombstone;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return { id, workspace: await this.readRecord(id), tombstone };
  }

  /** Every deleted workspace, oldest deletion first. */
  async listDeleted(): Promise<DeletedWorkspace[]> {
    const deleted: DeletedWorkspace[] = [];
    for (const entry of await this.entries()) {
      const one = await this.getDeleted(entry);
      if (one) deleted.push(one);
    }
    deleted.sort(
      (a, b) =>
        a.tombstone.deletedAt.localeCompare(b.tombstone.deletedAt) || a.id.localeCompare(b.id),
    );
    return deleted;
  }

  /**
   * Fix the moment a deleted workspace's purge began. The first value stays;
   * returns the tombstone as written, or `null` when there is none.
   */
  async markPurging(id: string, at: Date): Promise<WorkspaceTombstone | null> {
    const deleted = await this.getDeleted(id);
    if (!deleted) return null;
    if (deleted.tombstone.purgeAt) return deleted.tombstone;
    const tombstone = { ...deleted.tombstone, purgeAt: at.toISOString() };
    await writeJsonAtomic(this.tombstonePath(id), tombstone);
    return tombstone;
  }

  /**
   * Remove a deleted workspace's tombstone, so it is live again as it was.
   * Membership-change notifications fire for each member. Returns the
   * workspace, or `null` when `id` is not a deleted workspace with its record.
   * Whether it may still be restored is the caller's rule.
   */
  async restore(id: string): Promise<Workspace | null> {
    const deleted = await this.getDeleted(id);
    if (!deleted?.workspace) return null;
    await unlink(this.tombstonePath(id));
    for (const m of deleted.workspace.members) this.fireMembershipChanged(m.userId);
    return deleted.workspace;
  }

  /**
   * Remove a deleted workspace's directory: the last step of its purge. The
   * record goes first, so a removal that stops partway leaves the tombstone
   * without a record (still a deleted workspace, finished on the next pass) and
   * never a record without its tombstone. A live workspace is refused.
   */
  async remove(id: string): Promise<void> {
    if (!this.isDeleted(id)) throw new Error(`Workspace "${id}" is not deleted`);
    await rm(this.wsPath(id), { force: true });
    await rm(join(this.workspacesDir, id), { recursive: true, force: true });
  }

  /**
   * Remove each directory an earlier release moved under `archived/` on delete
   * whose archive time (its mtime) is at or before `cutoff`. Its connectors were
   * torn down and its conversations and tasks purged when it was archived, so
   * there is nothing to call and nothing it could be restored to. Returns the
   * names removed.
   */
  async removeArchivedBefore(cutoff: Date): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.archivedDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const removed: string[] = [];
    for (const name of names) {
      const dir = join(this.archivedDir, name);
      const st = await stat(dir);
      if (!st.isDirectory() || st.mtime > cutoff) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(name);
    }
    return removed;
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
    this.notify(this.memberAddedHandlers, (h) => h(wsId, userId, role));
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
   * function. Fires after `addMember`, `removeMember`, `create`, `delete`
   * and `restore` for every affected `userId` (see `MembershipChangeHandler`).
   * The SSE event manager uses this to invalidate its per-client cached
   * workspace-membership set without polling the store on every emit.
   */
  onMembershipChanged(handler: MembershipChangeHandler): () => void {
    this.membershipChangeHandlers.add(handler);
    return () => {
      this.membershipChangeHandlers.delete(handler);
    };
  }

  /** Call `handler` with each workspace this store creates. Returns its removal. */
  onCreated(handler: (workspace: Workspace) => void): () => void {
    this.createdHandlers.add(handler);
    return () => this.createdHandlers.delete(handler);
  }

  /** Call `handler` for each member added, at create or later. Returns its removal. */
  onMemberAdded(handler: (wsId: string, userId: string, role: WorkspaceRole) => void): () => void {
    this.memberAddedHandlers.add(handler);
    return () => this.memberAddedHandlers.delete(handler);
  }

  /** Run each handler; a listener that throws never fails the write it observed. */
  private notify<H>(handlers: Set<H>, call: (handler: H) => void): void {
    for (const handler of handlers) {
      try {
        call(handler);
      } catch (err) {
        log.warn("[workspace-store] listener threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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

  private tombstonePath(id: string): string {
    return join(this.workspacesDir, id, TOMBSTONE_FILENAME);
  }

  private async atomicWrite(filePath: string, data: Workspace): Promise<void> {
    await writeJsonAtomic(filePath, data);
  }
}
