import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../util/atomic-json.ts";
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

    // Slug collision detection
    const existing = await this.get(id);
    if (existing) {
      throw new WorkspaceConflictError(id);
    }

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id,
      name,
      members: [],
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

    // Runtime guard for the type-level Pick: `isPersonal` and `ownerUserId`
    // are identity-bound at create time and not patchable. A caller that
    // casts through the type system (`as unknown as { name: string }`)
    // would otherwise bypass the Pick — strip the disallowed keys
    // explicitly so the invariant holds at runtime too.
    const {
      isPersonal: _isPersonal,
      ownerUserId: _ownerUserId,
      ...safePatch
    } = patch as Partial<Workspace>;

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
