import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../observability/log.ts";
import { writeJsonAtomic } from "../util/atomic-json.ts";
import { PersonalWorkspaceInvariantError } from "./errors.ts";
import { scaffoldWorkspace } from "./scaffold.ts";
import type { Workspace, WorkspaceMember, WorkspaceRole } from "./types.ts";
import { WORKSPACE_ID_RE } from "./workspace-id-pattern.ts";

// Re-export so existing `import { WORKSPACE_ID_RE } from ".../workspace-store.ts"`
// call sites keep working. The literal source string + flags live in
// `workspace-id-pattern.ts` so the codegen step (and the web tier) can
// consume the same contract — see that file's header for the why.
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

// `WORKSPACE_ID_RE` lives in `./workspace-id-pattern.ts` so the web
// tier (which can't import from `src/`) can consume the same literal
// via build-time codegen. Re-exported above. See the pattern module's
// header for the full rationale.

// ── Opaque id generation ───────────────────────────────────────────

/**
 * Generate an opaque, name-independent workspace id.
 *
 * **Why opaque.** A workspace id is a stable handle, not a label. The
 * pre-opaque scheme derived the id from the name (`ws_<slugify(name)>`)
 * and froze it at create time — so renaming a workspace left its URL
 * (`/w/<old-name-slug>`) and on-disk dir permanently stamped with the
 * original name. Decoupling the id from the name makes the name a freely
 * editable field that never moves the id, the dir, or the URL.
 *
 * **Alphabet.** The id MUST match `WORKSPACE_ID_PATTERN`
 * (`^ws_[a-z0-9_]{1,64}$`) — no hyphens, because `-` is the
 * workspace/tool separator in `ws_<id>-<tool>` (see `src/tools/namespace.ts`).
 * Lowercase hex (`[a-f0-9]`) is a strict subset of `[a-z0-9_]`, so it
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

// ── Slugification ──────────────────────────────────────────────────

/**
 * Derive a workspace slug from a human-readable name.
 *
 * Only used for the **explicit slug-override** path of
 * `WorkspaceStore.create` (a caller passing `slug` deliberately) and for
 * personal-workspace slugs (`personalWorkspaceSlugFor`). The default,
 * no-slug create path produces an opaque id via `generateWorkspaceId` —
 * the name is NOT derived into the id. See `generateWorkspaceId` for why.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/**
 * Canonical id of `userId`'s personal workspace.
 *
 * **Single source of truth for this format.** No other code site in
 * `src/` may build a personal workspace id by hand — this convention
 * will be enforced by the `check:personal-workspace-id` AST lint
 * that Task 010 adds (not yet in this PR; until then, discipline-only).
 * Code that needs "user X's personal workspace" constructs the id here
 * and looks it up via `WorkspaceStore.get(...)`. Code that needs the
 * reverse ("who owns this workspace?") reads `Workspace.ownerUserId`
 * — never parse the id.
 *
 * Format: `ws_user_` + `userId`. The full user id is preserved
 * (including any provider-prefixed `user_` / `usr_` segment) — the
 * helper is a dumb concat and does NOT strip prefixes. Stripping would
 * couple the helper to identity-provider conventions and create a
 * class of subtle bugs across providers. The doubled-prefix form
 * (`ws_user_user_abc123` for `user_abc123`) is correct, even if it
 * looks awkward in logs.
 *
 * The corresponding `slug` passed into `WorkspaceStore.create` is the
 * id with `ws_` stripped — i.e. `user_` + `userId` — which `create`
 * re-prefixes with `ws_` to produce the same id.
 */
export function personalWorkspaceIdFor(userId: string): string {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("[workspace-store] personalWorkspaceIdFor: userId is required");
  }
  return `ws_user_${userId}`;
}

/** The slug form (id without the `ws_` prefix) for `userId`'s personal workspace. */
export function personalWorkspaceSlugFor(userId: string): string {
  return personalWorkspaceIdFor(userId).slice(3);
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
 * start / bundle boot) paths, not hot loops.
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
 * destroyed, so it stays recoverable/exportable for a retention window.
 * A separate operator/cleanup job enumerates these markers to apply a
 * retention/export policy — the store never auto-purges (default: keep).
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

// ── Personal-workspace invariant guards ────────────────────────────

/** Enforce the co-required personal fields at create time: personal ⇔ ownerUserId set. */
function assertPersonalOwnerCoRequired(isPersonal: boolean, ownerUserId: string | undefined): void {
  if (isPersonal && !ownerUserId) {
    throw new Error("[workspace-store] create: isPersonal=true requires ownerUserId");
  }
  if (!isPersonal && ownerUserId) {
    throw new Error("[workspace-store] create: ownerUserId is only valid with isPersonal=true");
  }
}

/**
 * Resolve a new workspace's initial members, enforcing the
 * personal-workspace sole-owner-admin shape.
 *
 * Shared workspaces default to the supplied members (or `[]`). Personal
 * workspaces are forced to `[{ userId: ownerUserId, role: "admin" }]`; a
 * caller that supplies any other shape is making a claim the type system
 * can't catch (member arrays carry no identity binding), so it's surfaced
 * loudly here — the create-time twin of the mutation-time guards in
 * `update` / `addMember` / `removeMember` / `updateMemberRole`.
 */
function resolveInitialMembers(
  id: string,
  isPersonal: boolean,
  ownerUserId: string | undefined,
  members: WorkspaceMember[] | undefined,
): WorkspaceMember[] {
  if (!isPersonal) return members ?? [];
  // Unreachable in practice (the co-required check already threw), but
  // narrows the type for the return below.
  if (!ownerUserId) {
    throw new Error("[workspace-store] create: isPersonal=true requires ownerUserId");
  }
  if (members !== undefined) {
    const ok =
      members.length === 1 && members[0]?.userId === ownerUserId && members[0]?.role === "admin";
    if (!ok) {
      throw new PersonalWorkspaceInvariantError(
        id,
        "members_mutation",
        "personal workspace initial members must be exactly [{ userId: ownerUserId, role: 'admin' }]",
      );
    }
  }
  return [{ userId: ownerUserId, role: "admin" }];
}

/** Reject a patch that would flip a workspace's frozen `isPersonal` flag (either direction). */
function assertIsPersonalFrozen(id: string, current: Workspace, patch: Partial<Workspace>): void {
  if (!("isPersonal" in patch)) return;
  if (patch.isPersonal !== current.isPersonal) {
    throw new PersonalWorkspaceInvariantError(
      id,
      "is_personal_frozen",
      `cannot change isPersonal from ${String(current.isPersonal === true)} to ${String(patch.isPersonal === true)}`,
    );
  }
}

/** Reject a patch that would move a personal workspace's owner, or set ownerUserId on a shared one. */
function assertOwnerUserIdInvariant(
  id: string,
  current: Workspace,
  patch: Partial<Workspace>,
): void {
  if (!("ownerUserId" in patch)) return;
  if (current.isPersonal === true) {
    if (patch.ownerUserId !== current.ownerUserId) {
      throw new PersonalWorkspaceInvariantError(
        id,
        "owner_user_id_frozen",
        `cannot change ownerUserId from ${current.ownerUserId ?? "(unset)"} to ${
          patch.ownerUserId ?? "(unset)"
        }`,
      );
    }
    return;
  }
  // Non-personal workspaces MUST NOT carry an ownerUserId — the two
  // fields travel together (see `Workspace.ownerUserId`).
  if (patch.ownerUserId !== undefined) {
    throw new PersonalWorkspaceInvariantError(
      id,
      "owner_user_id_on_non_personal",
      "ownerUserId can only be set on a workspace where isPersonal === true",
    );
  }
}

/** Reject a members patch on a personal workspace that isn't the sole-owner-admin shape. */
function assertPersonalMembersLocked(
  id: string,
  current: Workspace,
  patch: Partial<Workspace>,
): void {
  if (!("members" in patch) || current.isPersonal !== true) return;
  // Membership changes go through `addMember` / `removeMember` /
  // `updateMemberRole`, which carry the same guard.
  const proposed = patch.members ?? [];
  const ownerUserId = current.ownerUserId;
  const ok =
    proposed.length === 1 && proposed[0]?.userId === ownerUserId && proposed[0]?.role === "admin";
  if (!ok) {
    throw new PersonalWorkspaceInvariantError(
      id,
      "members_mutation",
      "personal workspace members are locked to [{ userId: ownerUserId, role: 'admin' }]",
    );
  }
}

// ── WorkspaceStore ─────────────────────────────────────────────────

export class WorkspaceStore {
  private workspacesDir: string;
  private archivedDir: string;
  private membershipChangeHandlers = new Set<MembershipChangeHandler>();

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
   * moves a workspace's data subtree. Exposed for an operator/cleanup job
   * that enumerates `archived/<wsId>/.archived.json` markers to apply a
   * retention/export policy — the store itself never sweeps (see `delete`).
   * Created lazily on the first archive, so this path may not exist yet.
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
      const ws = await this.get(entry);
      if (ws) workspaces.push(ws);
    }

    workspaces.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return workspaces;
  }

  /**
   * Resolve the id for a new workspace. Two paths:
   *   1. Explicit `slug` supplied → `ws_<slug>`. Deliberate caller intent:
   *      personal workspaces (`personalWorkspaceSlugFor`, which MUST stay
   *      deterministic for O(1) lookup) and any operator/test that wants a
   *      chosen id. Validated against WORKSPACE_ID_RE.
   *   2. No `slug` → opaque, name-independent id via
   *      `generateUniqueWorkspaceId`. The name never lands in the id, so a
   *      later rename leaves the id / dir / URL untouched.
   */
  private async resolveNewWorkspaceId(slug: string | undefined): Promise<string> {
    if (slug !== undefined) {
      const id = `ws_${slug}`;
      if (!WORKSPACE_ID_RE.test(id)) {
        throw new Error(`Invalid workspace ID format: "${id}"`);
      }
      return id;
    }
    return this.generateUniqueWorkspaceId();
  }

  /**
   * Generate an opaque, collision-free workspace id.
   *
   * 64 bits of entropy makes a collision astronomically unlikely; the
   * bounded retry is defense-in-depth so the rare case self-heals instead
   * of surfacing a confusing conflict to the operator. The generator's
   * alphabet is guaranteed to satisfy WORKSPACE_ID_RE, so there's no
   * per-iteration revalidation.
   */
  private async generateUniqueWorkspaceId(): Promise<string> {
    const MAX_ID_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const candidate = generateWorkspaceId();
      if (!(await this.get(candidate))) return candidate;
    }
    throw new Error(
      `[workspace-store] create: could not generate a collision-free workspace id after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }

  async create(
    name: string,
    slug?: string,
    opts?: {
      /** Mark this as the personal workspace of `ownerUserId` (which must also be set). */
      isPersonal?: boolean;
      /** Required when `isPersonal: true`; forbidden otherwise. */
      ownerUserId?: string;
      /** Short human-readable description; defaults to `null`. */
      about?: string | null;
      /**
       * Initial members. Personal workspaces force this to
       * `[{ userId: ownerUserId, role: "admin" }]` — supplying anything
       * else throws `PersonalWorkspaceInvariantError`. Shared workspaces
       * default to `[]` (the caller invokes `addMember` afterwards to
       * populate).
       */
      members?: WorkspaceMember[];
    },
  ): Promise<Workspace> {
    const id = await this.resolveNewWorkspaceId(slug);

    // Co-required invariant. A personal workspace MUST declare its owner;
    // a shared workspace MUST NOT carry an ownerUserId. These two fields
    // travel together — see `Workspace.isPersonal` / `ownerUserId` in types.
    const isPersonal = opts?.isPersonal === true;
    assertPersonalOwnerCoRequired(isPersonal, opts?.ownerUserId);

    // Personal-workspace member shape: sole-owner-admin only.
    const members = resolveInitialMembers(id, isPersonal, opts?.ownerUserId, opts?.members);

    // Id collision detection. For the explicit-slug path this is the
    // only collision guard (two `create(name, "team_a")` calls conflict).
    // For the opaque path `resolveNewWorkspaceId` already retried past
    // collisions, so this is a redundant-but-cheap final assertion.
    const existing = await this.get(id);
    if (existing) {
      throw new WorkspaceConflictError(id);
    }

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id,
      name,
      members,
      bundles: [],
      createdAt: now,
      updatedAt: now,
      isPersonal,
      ...(opts?.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
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
        | "bundles"
        | "agents"
        | "skillDirs"
        | "models"
        | "identity"
        | "oauthOperatorApps"
        | "about"
      >
    >,
  ): Promise<Workspace | null> {
    const ws = await this.get(id);
    if (!ws) return null;

    // Runtime guard for the type-level Pick: `isPersonal`, `ownerUserId`,
    // and `members` are identity-bound at create time and not patchable
    // here. The Pick<> excludes them at the type level, but a caller can
    // cast through the type system (`as unknown as { name: string }`),
    // and historic callers did exactly that. Detect the attempt and
    // throw a typed error instead of silently stripping — the silent
    // strip is the failure mode that produced multi-admin personal
    // workspaces in production.
    //
    // The casts here are scoped to read-only inspection of the widened
    // patch shape. We do NOT widen the spread that builds `updated` — only
    // fields in the Pick can land on disk. The identity-bound fields are
    // frozen post-create; each guard throws a typed error rather than
    // silently stripping.
    const widePatch = patch as Partial<Workspace>;
    assertIsPersonalFrozen(id, ws, widePatch);
    assertOwnerUserIdInvariant(id, ws, widePatch);
    assertPersonalMembersLocked(id, ws, widePatch);

    // Build the safe patch from the type-level Pick only. We strip the
    // identity-bound keys (`isPersonal`, `ownerUserId`, `members`) from
    // the spread — the guards above have already validated they're
    // either absent, equal to the current value, or rejected — so the
    // record on disk never gains a field outside the Pick.
    const {
      isPersonal: _isPersonal,
      ownerUserId: _ownerUserId,
      members: _members,
      ...safePatch
    } = widePatch;

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
   * exportable for a retention window; a separate operator/cleanup job
   * purges tombstones under its own policy — the store never auto-purges
   * (default: keep).
   *
   * From every other surface the workspace is gone the moment this
   * returns: `get`/`list` read `workspaces/`, which no longer holds the
   * subtree. Membership-change notifications fire for each former member,
   * exactly as before (the only change is on-disk: archive vs. destroy).
   *
   * Returns `false` (idempotent no-op) when no such workspace dir exists.
   *
   * `archiveSuffix` disambiguates a same-id re-archive — rare, and mostly
   * personal `ws_user_*` workspaces re-created after a prior delete. When
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

    // Personal workspaces are sole-owner. Any addMember call against
    // one violates the invariant — even adding the owner again, which
    // would shadow the create-time entry.
    if (ws.isPersonal === true) {
      throw new PersonalWorkspaceInvariantError(
        wsId,
        "members_mutation",
        `cannot add member ${userId} to a personal workspace; membership is locked to the owner`,
      );
    }

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

    if (ws.isPersonal === true) {
      throw new PersonalWorkspaceInvariantError(
        wsId,
        "members_mutation",
        `cannot remove member ${userId} from a personal workspace; membership is locked to the owner`,
      );
    }

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

    if (ws.isPersonal === true) {
      throw new PersonalWorkspaceInvariantError(
        wsId,
        "members_mutation",
        `cannot change role for ${userId} on a personal workspace; the owner is admin and the membership list is frozen`,
      );
    }

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
