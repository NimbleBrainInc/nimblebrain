/**
 * Cheap on-disk probe for workspace-scope OAuth credential state.
 *
 * Mirrors `WorkspaceOAuthProvider`'s storage layout so callers can answer
 * "does this connection have tokens?" without constructing a provider
 * (which is heavier and assumes more wiring). Used at platform boot to
 * pick the right initial Connection state for URL bundles.
 *
 * Storage layout (kept in lockstep with `WorkspaceOAuthProvider`):
 *   <workDir>/workspaces/<wsId>/credentials/mcp-oauth/<serverName>/tokens.json
 *
 * User-scope tokens live under `<workDir>/users/<userId>/credentials/...`
 * and are probed via the user-scope path inside the OAuth provider —
 * no parallel boot-time helper needed today.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export function workspaceOAuthDir(workDir: string, wsId: string, serverName: string): string {
  return join(workDir, "workspaces", wsId, "credentials", "mcp-oauth", serverName);
}

/** True if a workspace-scope `tokens.json` exists for this (workspace, server). */
export function hasPersistedWorkspaceOAuthTokens(
  workDir: string,
  wsId: string,
  serverName: string,
): boolean {
  return existsSync(join(workspaceOAuthDir(workDir, wsId, serverName), "tokens.json"));
}
