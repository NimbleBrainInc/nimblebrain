import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrgRole } from "./types.ts";

// ── User interface ─────────────────────────────────────────────────

export interface UserPreferences {
  timezone?: string;
  locale?: string;
  theme?: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  orgRole: OrgRole;
  preferences: UserPreferences;
  identity?: string;
  integrationEntityId?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * ISO timestamp set when the user is soft-deleted (deactivated). The profile
   * is retained as a tombstone — the record still lists in admin views, but the
   * auth layer denies access while this is set. Cleared by {@link UserStore.restore}.
   * Absent on active users.
   */
  deletedAt?: string;
}

export type CreateUserData = {
  /** Optional deterministic ID (e.g., for OIDC auto-provisioning). If omitted, a random ID is generated. */
  id?: string;
  email: string;
  displayName: string;
  orgRole?: OrgRole;
  preferences?: UserPreferences;
  identity?: string;
  integrationEntityId?: string;
};

export type UpdateUserData = Partial<
  Pick<
    User,
    "email" | "displayName" | "orgRole" | "preferences" | "identity" | "integrationEntityId"
  >
>;

// ── Errors ─────────────────────────────────────────────────────────

export class UserConflictError extends Error {
  constructor(email: string) {
    super(`A user with email "${email}" already exists`);
    this.name = "UserConflictError";
  }
}

// ── ID generation ──────────────────────────────────────────────────

function generateUserId(): string {
  return `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// ── Atomic write helper ────────────────────────────────────────────

let tmpCounter = 0;
function uniqueTmpSuffix(): string {
  return `${Date.now()}.${++tmpCounter}`;
}

// ── UserStore ──────────────────────────────────────────────────────

export class UserStore {
  private usersDir: string;

  constructor(workDir: string) {
    this.usersDir = join(workDir, "users");
    if (!existsSync(this.usersDir)) {
      mkdirSync(this.usersDir, { recursive: true });
    }
  }

  async get(id: string): Promise<User | null> {
    const filePath = this.profilePath(id);
    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as User;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async getByEmail(email: string): Promise<User | null> {
    const users = await this.list();
    return users.find((u) => u.email === email) ?? null;
  }

  async list(): Promise<User[]> {
    let entries: string[];
    try {
      entries = await readdir(this.usersDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const users: User[] = [];
    for (const entry of entries) {
      // Skip hidden files/directories (e.g., .DS_Store)
      if (entry.startsWith(".")) continue;
      try {
        const user = await this.get(entry);
        if (user) users.push(user);
      } catch {
        // Skip entries with corrupt/invalid profile.json
      }
    }

    users.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return users;
  }

  async create(data: CreateUserData): Promise<User> {
    // Enforce email uniqueness
    const existing = await this.getByEmail(data.email);
    if (existing) {
      throw new UserConflictError(data.email);
    }

    const id = data.id ?? generateUserId();
    const now = new Date().toISOString();

    const user: User = {
      id,
      email: data.email,
      displayName: data.displayName,
      orgRole: data.orgRole ?? "member",
      preferences: data.preferences ?? {},
      identity: data.identity,
      integrationEntityId: data.integrationEntityId,
      createdAt: now,
      updatedAt: now,
    };

    const userDir = join(this.usersDir, id);
    mkdirSync(userDir, { recursive: true });
    await this.atomicWrite(this.profilePath(id), user);

    return user;
  }

  async update(id: string, patch: UpdateUserData): Promise<User | null> {
    const user = await this.get(id);
    if (!user) return null;

    // Check email uniqueness if changing email
    if (patch.email !== undefined && patch.email !== user.email) {
      const existing = await this.getByEmail(patch.email);
      if (existing) {
        throw new UserConflictError(patch.email);
      }
    }

    const updated: User = {
      ...user,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    await this.atomicWrite(this.profilePath(id), updated);
    return updated;
  }

  /**
   * Soft-delete (deactivate) a user: stamp `deletedAt` on the profile so the
   * auth layer denies access while the record is retained for audit/restore.
   * Idempotent — a no-op (returns the existing tombstone) if already deleted.
   * Returns the updated user, or null if not found.
   */
  async softDelete(id: string): Promise<User | null> {
    const user = await this.get(id);
    if (!user) return null;
    if (user.deletedAt) return user;

    const now = new Date().toISOString();
    const updated: User = { ...user, deletedAt: now, updatedAt: now };
    await this.atomicWrite(this.profilePath(id), updated);
    return updated;
  }

  /**
   * Restore a soft-deleted user by clearing `deletedAt`. Idempotent — a no-op
   * (returns the user unchanged) if not currently deleted. Returns the updated
   * user, or null if not found.
   */
  async restore(id: string): Promise<User | null> {
    const user = await this.get(id);
    if (!user) return null;
    if (!user.deletedAt) return user;

    const updated: User = { ...user, updatedAt: new Date().toISOString() };
    // Drop the tombstone — atomicWrite's JSON.stringify omits undefined keys.
    updated.deletedAt = undefined;
    await this.atomicWrite(this.profilePath(id), updated);
    return updated;
  }

  /**
   * Hard-delete a user, removing the profile directory entirely. Prefer
   * {@link softDelete} for the deactivation flow — this is the irreversible
   * purge used by migrations and the OIDC provider's directory ownership.
   */
  async delete(id: string): Promise<boolean> {
    const userDir = join(this.usersDir, id);
    if (!existsSync(userDir)) return false;
    await rm(userDir, { recursive: true, force: true });
    return true;
  }

  // ── Private helpers ────────────────────────────────────────────

  private profilePath(id: string): string {
    return join(this.usersDir, id, "profile.json");
  }

  private async atomicWrite(filePath: string, data: User): Promise<void> {
    const tmpPath = `${filePath}.tmp.${uniqueTmpSuffix()}`;
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  }
}
