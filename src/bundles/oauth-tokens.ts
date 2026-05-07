/**
 * Cheap on-disk probes for OAuth credential state.
 *
 * Mirrors `WorkspaceOAuthProvider`'s storage layout so callers can answer
 * "does this connection have tokens?" without constructing a provider
 * (which is heavier and assumes more wiring). Used at platform boot to
 * pick the right initial Connection state for URL bundles, and at
 * `/v1/connections/installed` to surface `missingOperatorSetup`-style
 * indicators.
 *
 * Storage layout (kept in lockstep with `WorkspaceOAuthProvider`):
 *   <workDir>/workspaces/<wsId>/credentials/mcp-oauth/<serverName>/tokens.json
 *   <workDir>/workspaces/<wsId>/credentials/mcp-oauth/<serverName>/members/<memberId>/tokens.json
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export function workspaceOAuthDir(workDir: string, wsId: string, serverName: string): string {
  return join(workDir, "workspaces", wsId, "credentials", "mcp-oauth", serverName);
}

/**
 * True if a workspace-scope `tokens.json` exists for this (workspace,
 * server). False for member-scope bundles (which store tokens under
 * `members/<memberId>/`) — use `hasPersistedMemberOAuthTokens` for those.
 */
export function hasPersistedWorkspaceOAuthTokens(
  workDir: string,
  wsId: string,
  serverName: string,
): boolean {
  return existsSync(join(workspaceOAuthDir(workDir, wsId, serverName), "tokens.json"));
}

/**
 * True if a member-scope `tokens.json` exists for this (workspace,
 * server, member). Used to decide whether a per-member Connection
 * should boot as `running` vs `not_authenticated`.
 */
export function hasPersistedMemberOAuthTokens(
  workDir: string,
  wsId: string,
  serverName: string,
  memberId: string,
): boolean {
  return existsSync(
    join(workspaceOAuthDir(workDir, wsId, serverName), "members", memberId, "tokens.json"),
  );
}
