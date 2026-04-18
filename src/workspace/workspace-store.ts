import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

// ── Atomic write helper ────────────────────────────────────────────

let tmpCounter = 0;
function uniqueTmpSuffix(): string {
  return `${Date.now()}.${++tmpCounter}`;
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

  async create(name: string, slug?: string): Promise<Workspace> {
    const derivedSlug = slug ?? slugify(name);
    const id = `ws_${derivedSlug}`;

    if (!WORKSPACE_ID_RE.test(id)) {
      throw new Error(`Invalid workspace ID format: "${id}"`);
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
      Pick<Workspace, "name" | "bundles" | "agents" | "skillDirs" | "models" | "identity">
    >,
  ): Promise<Workspace | null> {
    const ws = await this.get(id);
    if (!ws) return null;

    const updated: Workspace = {
      ...ws,
      ...patch,
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
    const tmpPath = `${filePath}.tmp.${uniqueTmpSuffix()}`;
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(tmpPath, filePath);
  }
}
