// ---------------------------------------------------------------------------
// Bootstrap mappers — server response → client context state
//
// `userRole` is load-bearing, and for two consumers, not one:
//
//   - `useScopedRole` — *reach*. Dropping it resolves any non-org-admin member
//     to role="none" and filters their settings nav down to "About" only.
//   - `canWriteWorkspace` — *writes*. It reads the role directly, without going
//     through `useScopedRole` at all; that split is deliberate, because the
//     role ordering escalates org admins and the server does not.
//
// So dropping it hurts org admins too: the early return in `resolveScopedRole`
// carries them past a missing `userRole`, but they lose every workspace write.
// Anchor the mapping in
// a tested helper so a future contributor can't accidentally re-introduce the
// omission.
// ---------------------------------------------------------------------------

import type { WorkspaceInfo } from "../context/WorkspaceContext";
import type { BootstrapResponse } from "../types";

/**
 * Convert the bootstrap response's per-workspace shape into the
 * `WorkspaceInfo` the `WorkspaceProvider` consumes. Caller is expected to
 * pass `bootstrap.workspaces` directly. `userRole` propagates so role
 * gating works.
 */
export function bootstrapWorkspacesToInfo(
  workspaces: BootstrapResponse["workspaces"],
): WorkspaceInfo[] {
  return workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    memberCount: ws.memberCount,
    connectorCount: ws.connectorCount,
    userRole: ws.role,
    mcpUrl: ws.mcpUrl,
  }));
}
