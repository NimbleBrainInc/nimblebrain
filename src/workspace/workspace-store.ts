import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../util/atomic-json.ts";
import { PersonalWorkspaceInvariantError } from "./errors.ts";
import { scaffoldWorkspace } from "./scaffold.ts";
import type { Workspace, WorkspaceMember, WorkspaceRole } from "./types.ts";

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

// ── Workspace ID validation ────────────────────────────────────────

/**
 * Valid workspace ID: ws_ prefix followed by 1-64 alphanumeric/underscore chars.
 *
 * Exported because credential-store primitives (src/config/workspace-credentials)
 * write to filesystem paths derived from `wsId`. Those primitives must validate
 * against this same regex to defend against path-traversal (e.g., `../evil`)
 * even when the call site looks trusted. Keep in lockstep with the scaffold
 * assumptions in `WORKSPACE_DIRS` and the path layout in `WorkspaceStore`.
 */
export const WORKSPACE_ID_RE = /^ws_[a-z0-9_]{1,64}$/i;

// ── Slugification ──────────────────────────────────────────────────

/** Derive a workspace slug from a human-readable name. */
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

// ── WorkspaceStore ─────────────────────────────────────────────────

export class WorkspaceStore {
  private workspacesDir: string;

  constructor(workDir: string) {
    this.workspacesDir = join(workDir, "workspaces");
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
    const derivedSlug = slug ?? slugify(name);
    const id = `ws_${derivedSlug}`;

    if (!WORKSPACE_ID_RE.test(id)) {
      throw new Error(`Invalid workspace ID format: "${id}"`);
    }

    // Co-required invariant. A personal workspace MUST declare its owner;
    // a shared workspace MUST NOT carry an ownerUserId. These two fields
    // travel together — see `Workspace.isPersonal` / `ownerUserId` in types.
    const isPersonal = opts?.isPersonal === true;
    if (isPersonal && !opts?.ownerUserId) {
      throw new Error("[workspace-store] create: isPersonal=true requires ownerUserId");
    }
    if (!isPersonal && opts?.ownerUserId) {
      throw new Error("[workspace-store] create: ownerUserId is only valid with isPersonal=true");
    }

    // Personal-workspace member shape: sole-owner-admin only. This is
    // the create-time enforcement of the invariant that `update` /
    // `addMember` / `removeMember` / `updateMemberRole` also defend at
    // mutation time. A caller that supplies any other shape is making a
    // claim the type system can't catch (member arrays carry no
    // identity binding) — surface it loudly here so the next operator
    // doesn't inherit a multi-admin personal workspace.
    let members: WorkspaceMember[] = opts?.members ?? [];
    if (isPersonal) {
      const ownerUserId = opts?.ownerUserId;
      // Unreachable in practice (the co-required check above already
      // threw), but narrows the type for the assignment below.
      if (!ownerUserId) {
        throw new Error("[workspace-store] create: isPersonal=true requires ownerUserId");
      }
      if (opts?.members !== undefined) {
        const ok =
          opts.members.length === 1 &&
          opts.members[0]?.userId === ownerUserId &&
          opts.members[0]?.role === "admin";
        if (!ok) {
          throw new PersonalWorkspaceInvariantError(
            id,
            "members_mutation",
            "personal workspace initial members must be exactly [{ userId: ownerUserId, role: 'admin' }]",
          );
        }
      }
      members = [{ userId: ownerUserId, role: "admin" }];
    }

    // Slug collision detection
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
    // workspaces on hq production.
    //
    // Casts here are scoped to read-only inspection of the widened patch
    // shape. We do NOT widen the spread that builds `updated` — only
    // fields in the Pick can land on disk.
    const widePatch = patch as Partial<Workspace>;
    const wantsIsPersonal = "isPersonal" in widePatch;
    const wantsOwnerUserId = "ownerUserId" in widePatch;
    const wantsMembers = "members" in widePatch;

    if (wantsIsPersonal) {
      // Frozen post-create in both directions: a workspace's
      // "personal-ness" is part of its identity.
      if (widePatch.isPersonal !== ws.isPersonal) {
        throw new PersonalWorkspaceInvariantError(
          id,
          "is_personal_frozen",
          `cannot change isPersonal from ${String(ws.isPersonal === true)} to ${String(widePatch.isPersonal === true)}`,
        );
      }
    }

    if (wantsOwnerUserId) {
      if (ws.isPersonal === true) {
        if (widePatch.ownerUserId !== ws.ownerUserId) {
          throw new PersonalWorkspaceInvariantError(
            id,
            "owner_user_id_frozen",
            `cannot change ownerUserId from ${ws.ownerUserId ?? "(unset)"} to ${
              widePatch.ownerUserId ?? "(unset)"
            }`,
          );
        }
      } else {
        // Non-personal workspaces MUST NOT carry an ownerUserId — the
        // two fields travel together (see `Workspace.ownerUserId`).
        if (widePatch.ownerUserId !== undefined) {
          throw new PersonalWorkspaceInvariantError(
            id,
            "owner_user_id_on_non_personal",
            "ownerUserId can only be set on a workspace where isPersonal === true",
          );
        }
      }
    }

    if (wantsMembers && ws.isPersonal === true) {
      // Personal-workspace members are locked to sole-owner-admin.
      // Membership changes go through `addMember` / `removeMember` /
      // `updateMemberRole`, which carry the same guard.
      const proposed = widePatch.members ?? [];
      const ownerUserId = ws.ownerUserId;
      const ok =
        proposed.length === 1 &&
        proposed[0]?.userId === ownerUserId &&
        proposed[0]?.role === "admin";
      if (!ok) {
        throw new PersonalWorkspaceInvariantError(
          id,
          "members_mutation",
          "personal workspace members are locked to [{ userId: ownerUserId, role: 'admin' }]",
        );
      }
    }

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

  async delete(id: string): Promise<boolean> {
    const wsDir = join(this.workspacesDir, id);
    if (!existsSync(wsDir)) return false;
    await rm(wsDir, { recursive: true, force: true });
    return true;
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

    const updated: Workspace = {
      ...ws,
      members: ws.members.filter((m) => m.userId !== userId),
      updatedAt: new Date().toISOString(),
    };

    await this.atomicWrite(this.wsPath(wsId), updated);
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

  // ── Private helpers ────────────────────────────────────────────

  private wsPath(id: string): string {
    return join(this.workspacesDir, id, "workspace.json");
  }

  private async atomicWrite(filePath: string, data: Workspace): Promise<void> {
    await writeJsonAtomic(filePath, data);
  }
}
