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
