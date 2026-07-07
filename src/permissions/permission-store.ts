import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../util/atomic-json.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { WORKSPACE_ID_RE } from "../workspace/workspace-store.ts";

/**
 * Per-tool permission policies for installed connectors. Stored
 * separately for each scope:
 *
 *   user scope:      <workDir>/users/<userId>/permissions.json
 *   workspace scope: <workDir>/workspaces/<wsId>/permissions.json
 *
 * Schema:
 *   {
 *     connectors: { <serverName>: { tools: { <toolName>: "allow" | "disallow" } } },
 *     grants:     { <serverName>: [ <wsId>, ... ] }
 *   }
 *
 * Default policy: tools not present in the store are treated as "allow".
 * This is the "trust by default, tighten as needed" model — friction
 * kills adoption, and the platform's role-based admin controls are the
 * primary security boundary. Per-tool deny is for niche cases (operator
 * wants to forbid a specific destructive tool while keeping the rest of
 * the connector functional).
 *
 * The `grants` block is the opposite posture — deny-by-default. It records
 * personal-connector grants: which shared workspaces a user has explicitly
 * allowed one of their own personal connectors to be used inside. It only
 * ever lives in a *user*-scope record (a grant is the granting user's, and
 * revoking it is theirs). Absence of a grant means "not granted" — the
 * dispatch-time check fails closed. A connector used inside the user's own
 * personal workspace needs no grant (home is free) — the dispatch layer
 * owns that semantic and never asks the store to record a self-grant. The
 * store itself is a dumb ledger with no knowledge of a user's personal
 * workspace id, so it faithfully records whatever grant it is handed.
 *
 * Future expansion (see WORKSPACE_SECRETS_BROKER_SPEC): "needs_approval"
 * as a third state once the agent-pause-and-confirm flow lands.
 */

export type ToolPolicy = "allow" | "disallow";

export interface ConnectorPermissions {
  tools?: Record<string, ToolPolicy>;
}

/** Personal-connector grants: connector serverName → the shared-workspace ids it may be used in. */
export type ConnectorGrants = Record<string, string[]>;

export interface PermissionsRecord {
  connectors: Record<string, ConnectorPermissions>;
  grants?: ConnectorGrants;
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

  // ── personal-connector grants ─────────────────────────────────
  //
  // A grant is always the granting user's, so these methods take a bare
  // `userId` and address the user-scope record directly — there is no
  // workspace-scope grant. Reads fail closed (deny / empty) on any
  // malformed input; writes are strict (throw) so a bad serverName or
  // target wsId never lands a junk record in the ledger.

  /**
   * Is `serverName` (a personal connector) granted for use inside the
   * shared workspace `wsId`? The dispatch-time check — returns false
   * (deny) when no grant is recorded or any input is malformed.
   */
  async isConnectorGranted(userId: string, serverName: string, wsId: string): Promise<boolean> {
    if (!ID_RE.test(serverName) || !WORKSPACE_ID_RE.test(wsId)) return false;
    const grants = await this.getConnectorGrants(userId, serverName);
    return grants.includes(wsId);
  }

  /**
   * The shared-workspace ids a user has granted a personal connector to.
   * Empty when none — never null.
   */
  async getConnectorGrants(userId: string, serverName: string): Promise<string[]> {
    const record = await this.load({ scope: "user", userId });
    return record?.grants?.[serverName] ?? [];
  }

  /**
   * The connector names a user has granted to a specific shared workspace — the
   * surfacing read (one file load; "which of my personal connectors may this room
   * see"). Empty when none; fails closed (empty) on a malformed `wsId`.
   */
  async connectorsGrantedTo(userId: string, wsId: string): Promise<string[]> {
    if (!WORKSPACE_ID_RE.test(wsId)) return [];
    const record = await this.load({ scope: "user", userId });
    const grants = record?.grants;
    if (!grants) return [];
    return Object.entries(grants)
      .filter(([, wsIds]) => wsIds.includes(wsId))
      .map(([connector]) => connector);
  }

  /**
   * Grant a personal connector for use inside a shared workspace.
   * Idempotent — re-granting an existing (connector, workspace) is a no-op.
   * Throws on a malformed serverName or target wsId (strict write).
   */
  async grantConnector(userId: string, serverName: string, wsId: string): Promise<void> {
    if (!ID_RE.test(serverName)) throw new Error(`Invalid connector name: ${serverName}`);
    if (!WORKSPACE_ID_RE.test(wsId)) throw new Error(`Invalid workspace id: ${wsId}`);
    const owner: PermissionOwner = { scope: "user", userId };
    const record = (await this.load(owner)) ?? { connectors: {} };
    const grants = record.grants ?? {};
    const existing = grants[serverName] ?? [];
    if (existing.includes(wsId)) return;
    grants[serverName] = [...existing, wsId];
    record.grants = grants;
    await this.save(owner, record);
  }

  /**
   * Revoke a personal connector's grant for a shared workspace.
   * Idempotent. Prunes the connector key when its last grant is removed
   * and the `grants` block when it empties, so the file stays small.
   */
  async revokeConnector(userId: string, serverName: string, wsId: string): Promise<void> {
    // No ID_RE / WORKSPACE_ID_RE guard here (unlike grantConnector): a
    // malformed key can never be in a strictly-written ledger, so revoking
    // one is a safe no-op — the includes() check below simply misses.
    const owner: PermissionOwner = { scope: "user", userId };
    const record = await this.load(owner);
    const existing = record?.grants?.[serverName];
    if (!record?.grants || !existing?.includes(wsId)) return;
    const grants = record.grants;
    const remaining = existing.filter((id) => id !== wsId);
    if (remaining.length === 0) {
      delete grants[serverName];
    } else {
      grants[serverName] = remaining;
    }
    if (Object.keys(grants).length === 0) {
      record.grants = undefined;
    }
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
        // Normalize a malformed/absent `connectors` without discarding a
        // valid `grants` block that shares the same file.
        return parsed.grants ? { connectors: {}, grants: parsed.grants } : { connectors: {} };
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
    // Workspace branch validates against the strict `WORKSPACE_ID_RE`
    // (`ws_<slug>`), not the laxer local `ID_RE`. Reason: the path is
    // built through `WorkspaceContext`, which enforces `WORKSPACE_ID_RE`
    // at construction. If we let a wsId pass the local guard but fail
    // the context's, this function would throw instead of returning
    // null — silently tightening the "null on malformed" contract.
    // Production wsIds always come from `WorkspaceStore.create` which
    // also enforces `WORKSPACE_ID_RE`, so this guard is defense in
    // depth against a future caller that bypasses the store.
    if (!WORKSPACE_ID_RE.test(owner.wsId)) return null;
    return new WorkspaceContext({ wsId: owner.wsId, workDir: this.workDir }).getDataPath(
      "root",
      "permissions.json",
    );
  }
}

export type PermissionOwner =
  | { scope: "user"; userId: string }
  | { scope: "workspace"; wsId: string };
