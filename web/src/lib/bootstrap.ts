// ---------------------------------------------------------------------------
// Bootstrap mappers — server response → client context state
//
// `userRole` is load-bearing: it drives every workspace-scoped permission
// gate via `useScopedRole`. Dropping it on the way through resolves any
// non-org-admin member to role="none" and filters their settings nav down
// to "About" only — a bug we shipped once and won't ship again. Anchor
// the mapping in a tested helper so a future contributor can't accidentally
// re-introduce the omission.
// ---------------------------------------------------------------------------

import type { WorkspaceInfo } from "../context/WorkspaceContext";
import type { BootstrapResponse } from "../types";

/**
 * Convert the bootstrap response's per-workspace shape into the
 * `WorkspaceInfo` the `WorkspaceProvider` consumes. Caller is expected to
 * pass `bootstrap.workspaces` directly. `bundles` starts empty and is
 * populated lazily; `userRole` propagates so role gating works.
 */
export function bootstrapWorkspacesToInfo(
  workspaces: BootstrapResponse["workspaces"],
): WorkspaceInfo[] {
  return workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    memberCount: ws.memberCount,
    bundles: [],
    userRole: ws.role,
  }));
}
