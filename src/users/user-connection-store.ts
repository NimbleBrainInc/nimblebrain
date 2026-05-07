import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BundleRef } from "../bundles/types.ts";

/**
 * Per-user storage for personal connections — the user-global
 * counterpart to `WorkspaceStore` for workspace.json. Tracks which
 * personal MCP bundles a user has installed across every workspace
 * they're a member of.
 *
 * Storage shape:
 *   <workDir>/users/<userId>/user.json
 *
 * Sits parallel to the workspace tree at <workDir>/workspaces/. The
 * separation matters: a user's personal Granola tokens follow the
 * USER, not the workspace. Leaving a workspace doesn't orphan personal
 * credentials. Joining a new workspace makes those personal connections
 * available there immediately.
 *
 * The OAuth tokens themselves live at
 * `<workDir>/users/<userId>/credentials/mcp-oauth/<server>/...` —
 * managed by `WorkspaceOAuthProvider` when constructed with
 * `owner: { type: "user", userId }`.
 */

export class UserNotFoundError extends Error {
  constructor(id: string) {
    super(`User "${id}" not found`);
    this.name = "UserNotFoundError";
  }
}

/**
 * Valid user id: matches the same shape WorkOS produces (`user_` prefix +
 * alphanumeric) and the dev fallback `usr_default`. Restrictive on purpose:
 * the id becomes a filesystem path segment, so we defend against traversal
 * at the boundary regardless of where the value came from.
 */
export const USER_ID_RE = /^[a-z0-9_]{1,128}$/i;

export interface UserConnections {
  /** The user's id — same value used as the path segment. */
  userId: string;
  /**
   * Personal MCP bundles this user has installed. URL bundles only —
   * stdio bundles aren't user-scoped (they have no per-user identity to
   * present to). Each ref's `oauthScope` should be `"user"` (defaulted
   * if omitted).
   */
  bundles: BundleRef[];
  createdAt: string;
  updatedAt: string;
}

let tmpCounter = 0;
function uniqueTmpSuffix(): string {
  return `${Date.now()}.${++tmpCounter}`;
}

export class UserConnectionStore {
  private usersDir: string;

  constructor(workDir: string) {
    this.usersDir = join(workDir, "users");
    if (!existsSync(this.usersDir)) {
      mkdirSync(this.usersDir, { recursive: true });
    }
  }

  /** Read a user's connection record. Returns null if it doesn't exist yet. */
  async get(userId: string): Promise<UserConnections | null> {
    if (!USER_ID_RE.test(userId)) return null;
    const filePath = this.userPath(userId);
    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as UserConnections;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * List all known user records. Used at platform boot to wire each
   * member's personal bundles into the workspaces they're in. Cheap —
   * one directory listing + one file read per user.
   */
  async list(): Promise<UserConnections[]> {
    let entries: string[];
    try {
      entries = await readdir(this.usersDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: UserConnections[] = [];
    for (const id of entries) {
      if (!USER_ID_RE.test(id)) continue;
      const record = await this.get(id);
      if (record) out.push(record);
    }
    return out;
  }

  /**
   * Get or create the user's record. Creates an empty bundles list on
   * first access — no separate "register user" step required, since
   * we just need a place to store personal bundles when the user
   * actually installs one.
   */
  async getOrCreate(userId: string): Promise<UserConnections> {
    if (!USER_ID_RE.test(userId)) {
      throw new Error(`[user-store] invalid userId "${userId}"`);
    }
    const existing = await this.get(userId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const record: UserConnections = {
      userId,
      bundles: [],
      createdAt: now,
      updatedAt: now,
    };
    const userDir = join(this.usersDir, userId);
    mkdirSync(userDir, { recursive: true, mode: 0o700 });
    await this.atomicWrite(this.userPath(userId), record);
    return record;
  }

  /** Update the user's record with a partial. Returns null if user not found. */
  async update(
    userId: string,
    patch: Partial<Pick<UserConnections, "bundles">>,
  ): Promise<UserConnections | null> {
    const existing = await this.get(userId);
    if (!existing) return null;
    const updated: UserConnections = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.atomicWrite(this.userPath(userId), updated);
    return updated;
  }

  /**
   * Add a bundle to the user's personal connections. Idempotent on URL
   * (same bundle URL twice → no-op return of existing record).
   * Auto-creates the user record on first install.
   */
  async addBundle(userId: string, ref: BundleRef): Promise<UserConnections> {
    const existing = await this.getOrCreate(userId);
    if ("url" in ref) {
      const dup = existing.bundles.find((b) => "url" in b && b.url === ref.url);
      if (dup) return existing;
    }
    return (await this.update(userId, { bundles: [...existing.bundles, ref] }))!;
  }

  /**
   * Remove a bundle by URL. No-op if not present. Returns the new
   * record. Throws if user doesn't exist (caller would've had to
   * create first to install).
   */
  async removeBundle(userId: string, url: string): Promise<UserConnections> {
    const existing = await this.get(userId);
    if (!existing) throw new UserNotFoundError(userId);
    return (await this.update(userId, {
      bundles: existing.bundles.filter((b) => !("url" in b) || b.url !== url),
    }))!;
  }

  /** Remove the entire user record + its credentials directory. */
  async delete(userId: string): Promise<boolean> {
    if (!USER_ID_RE.test(userId)) return false;
    const userDir = join(this.usersDir, userId);
    if (!existsSync(userDir)) return false;
    await rm(userDir, { recursive: true, force: true });
    return true;
  }

  // ── Private helpers ────────────────────────────────────────────

  private userPath(userId: string): string {
    return join(this.usersDir, userId, "user.json");
  }

  private async atomicWrite(filePath: string, data: UserConnections): Promise<void> {
    const tmpPath = `${filePath}.tmp.${uniqueTmpSuffix()}`;
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(tmpPath, filePath);
  }
}
