// ---------------------------------------------------------------------------
// Workspaces source (@) — switch the focused workspace.
//
// Corpus is the in-memory workspace list (WorkspaceContext), ordered for the
// sidebar. All workspaces appear (including the focused one — selecting it is a
// useful "go to its overview", and keeping it means the default empty-query
// view always has content rather than going blank in a single-workspace org).
// The focused row is marked "current" and sorted last. Selecting a workspace
// mirrors WorkspaceNav's equality-guarded setActiveWorkspace, then navigates to
// its overview.
// ---------------------------------------------------------------------------

import { getWorkspaceAvatar } from "../../../lib/workspace-avatar";
import { orderWorkspacesForSidebar } from "../../../lib/workspace-order";
import { toSlug } from "../../../lib/workspace-slug";
import { scoreItem } from "../match";
import type { CommandItem, CommandSource } from "../types";

export const workspacesSource: CommandSource = {
  id: "workspaces",
  prefix: "@",
  groupLabel: "Switch workspace",
  getItems(query, ctx) {
    const ordered = orderWorkspacesForSidebar(ctx.workspaces);

    const scored: Array<{ item: CommandItem; score: number; isCurrent: boolean }> = [];
    for (const ws of ordered) {
      const isCurrent = ws.id === ctx.activeWorkspaceId;
      const role = ws.userRole;
      const appCount = ws.bundles?.length ?? 0;
      const subtitleParts = [
        isCurrent ? "current" : undefined,
        role,
        appCount > 0 ? `${appCount} apps` : undefined,
      ].filter(Boolean);
      const avatar = getWorkspaceAvatar(ws);
      const result = scoreItem(query, { title: ws.name, keywords: role ? [role] : [] });
      if (!result.matched) continue;
      scored.push({
        score: result.score,
        isCurrent,
        item: {
          id: `workspace:${ws.id}`,
          sourceId: "workspaces",
          title: ws.name,
          subtitle: subtitleParts.join(" · ") || undefined,
          icon: { kind: "letter", letter: avatar.letter, color: avatar.color },
          meta: "@workspace",
          run: (run) => {
            run.setActiveWorkspace(ws);
            run.navigate(`/w/${toSlug(ws.id)}/`);
            run.closePalette();
          },
        },
      });
    }

    // Higher score first; the current workspace sinks to the bottom of a tie so
    // switch targets lead.
    return scored
      .sort((a, b) => Number(a.isCurrent) - Number(b.isCurrent) || b.score - a.score)
      .map((s) => s.item);
  },
};
