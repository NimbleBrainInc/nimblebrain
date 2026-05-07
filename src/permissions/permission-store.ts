import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../util/atomic-json.ts";

/**
 * Per-tool permission policies for installed connectors. Stored
 * separately for each scope:
 *
 *   user scope:      <workDir>/users/<userId>/permissions.json
 *   workspace scope: <workDir>/workspaces/<wsId>/permissions.json
 *
 * Schema:
 *   { connectors: { <serverName>: { tools: { <toolName>: "allow" | "disallow" } } } }
 *
 * Default policy: tools not present in the store are treated as "allow".
 * This is the "trust by default, tighten as needed" model — friction
 * kills adoption, and the platform's role-based admin controls are the
 * primary security boundary. Per-tool deny is for niche cases (operator
 * wants to forbid a specific destructive tool while keeping the rest of
 * the connector functional).
 *
 * Future expansion (see WORKSPACE_SECRETS_BROKER_SPEC): "needs_approval"
 * as a third state once the agent-pause-and-confirm flow lands.
 */

export type ToolPolicy = "allow" | "disallow";

export interface ConnectorPermissions {
  tools?: Record<string, ToolPolicy>;
}

export interface PermissionsRecord {
  connectors: Record<string, ConnectorPermissions>;
}

const ID_RE = /^[a-z0-9_-]{1,128}$/i;

/**
 * File-backed permission store. One instance is shared across user-scope
 * and workspace-scope writes — the constructor takes the work directory
 * and methods accept either `{ scope: "user", userId }` or
 * `{ scope: "workspace", wsId }` to address the right file.
 */
export class PermissionStore {
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  /**
   * Look up the policy for a single tool. Returns "allow" when no policy
   * is recorded (default) — callers don't need to handle null.
   */
  async get(owner: PermissionOwner, serverName: string, toolName: string): Promise<ToolPolicy> {
    const record = await this.load(owner);
    const tool = record?.connectors[serverName]?.tools?.[toolName];
    return tool === "disallow" ? "disallow" : "allow";
  }

  /** Read all tool policies for a single connector. */
  async getConnector(
    owner: PermissionOwner,
    serverName: string,
  ): Promise<Record<string, ToolPolicy>> {
    const record = await this.load(owner);
    return record?.connectors[serverName]?.tools ?? {};
  }

  /**
   * Merge a partial map of tool policies into the connector's record.
   * Tools omitted from the input remain unchanged. Setting a tool to
   * "allow" deletes its entry (default state) so the file stays small.
   */
  async setConnector(
    owner: PermissionOwner,
    serverName: string,
    tools: Record<string, ToolPolicy>,
  ): Promise<void> {
    const record = (await this.load(owner)) ?? { connectors: {} };
    const existing = record.connectors[serverName]?.tools ?? {};
    const merged: Record<string, ToolPolicy> = { ...existing };
    for (const [name, policy] of Object.entries(tools)) {
      if (policy === "allow") {
        delete merged[name];
      } else {
        merged[name] = policy;
      }
    }
    if (Object.keys(merged).length === 0) {
      delete record.connectors[serverName];
    } else {
      record.connectors[serverName] = { tools: merged };
    }
    await this.save(owner, record);
  }

  /** Drop all tool policies for a connector (e.g., on uninstall). */
  async deleteConnector(owner: PermissionOwner, serverName: string): Promise<void> {
    const record = await this.load(owner);
    if (!record) return;
    if (!record.connectors[serverName]) return;
    delete record.connectors[serverName];
    await this.save(owner, record);
  }

  // ── internals ─────────────────────────────────────────────────

  private async load(owner: PermissionOwner): Promise<PermissionsRecord | null> {
    const path = this.permissionPath(owner);
    if (!path) return null;
    try {
      const content = await readFile(path, "utf-8");
      const parsed = JSON.parse(content) as PermissionsRecord;
      if (!parsed.connectors || typeof parsed.connectors !== "object") {
        return { connectors: {} };
      }
      return parsed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async save(owner: PermissionOwner, record: PermissionsRecord): Promise<void> {
    const path = this.permissionPath(owner);
    if (!path) throw new Error("Invalid permission owner");
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await writeJsonAtomic(path, record);
  }

  private permissionPath(owner: PermissionOwner): string | null {
    if (owner.scope === "user") {
      if (!ID_RE.test(owner.userId)) return null;
      return join(this.workDir, "users", owner.userId, "permissions.json");
    }
    if (!ID_RE.test(owner.wsId)) return null;
    return join(this.workDir, "workspaces", owner.wsId, "permissions.json");
  }
}

export type PermissionOwner =
  | { scope: "user"; userId: string }
  | { scope: "workspace"; wsId: string };
