/**
 * A workspace addressed by URL: `/mcp/<wsId>` and `/v1/workspaces/<wsId>/…`.
 *
 * Both surfaces take the workspace from the path and admit a caller by one
 * rule, kept here so neither can drift: the id's shape is checked before any
 * lookup, membership is checked on every request with exact id equality, and a
 * malformed id, an unknown workspace and a workspace the caller does not belong
 * to are indistinguishable to the caller.
 */

import { WORKSPACE_ID_RE } from "../workspace/workspace-id-pattern.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";

/**
 * Whether `wsId` is shaped like a workspace id. Only the shape is checked, so
 * the answer reveals nothing about which workspaces exist.
 */
export function isWorkspaceIdShape(wsId: string): boolean {
  return WORKSPACE_ID_RE.test(wsId);
}

/**
 * Whether `userId` may act on the workspace a URL addresses. False for a
 * malformed id (never looked up), an unknown workspace, and a non-member alike;
 * callers answer all three the same way.
 */
export async function isAddressedWorkspaceMember(
  workspaceStore: WorkspaceStore,
  wsId: string,
  userId: string,
): Promise<boolean> {
  if (!isWorkspaceIdShape(wsId)) return false;
  const workspace = await workspaceStore.get(wsId);
  return (
    workspace !== null &&
    workspace.id === wsId &&
    workspace.members.some((m) => m.userId === userId)
  );
}
