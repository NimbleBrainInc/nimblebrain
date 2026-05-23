// ---------------------------------------------------------------------------
// WorkspaceRow — Stage 2 / T013
//
// Single workspace entry in the sidebar's WORKSPACES section:
//
//   ▸ <icon> Workspace Name        [role-badge]
//      indented app list when expanded
//
// Role badge derives from `WorkspaceInfo.userRole` (Stage 1 contract,
// surfaced by both bootstrap and `manage_workspaces.list`). Personal
// workspaces consistently show `admin` (the sole-owner invariant), so
// the badge stays informative even on the personal row.
//
// Expansion state is per-row (parent-owned via the `expanded` /
// `onToggle` props). Pulling state up to the parent lets the sidebar
// remember which workspaces are open across re-renders without each
// row hooking its own localStorage entry; collapsing is local UI, not
// persisted across reloads.
// ---------------------------------------------------------------------------

import { ChevronDown, ChevronRight } from "lucide-react";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { RoleBadge } from "../ui/role-badge";
import { cn } from "../../lib/utils";
import { WorkspaceAppList } from "./WorkspaceAppList";

interface WorkspaceRowProps {
  workspace: WorkspaceInfo;
  expanded: boolean;
  onToggle: () => void;
  /**
   * Bundle name of the currently-selected app (from the URL). Used by
   * the app list to mark exactly one row as selected when this
   * workspace is the active one.
   */
  selectedAppRoute: string | null;
}

export function WorkspaceRow({
  workspace,
  expanded,
  onToggle,
  selectedAppRoute,
}: WorkspaceRowProps) {
  const wsCtx = useWorkspaceContext();
  const isActive = wsCtx.activeWorkspace?.id === workspace.id;

  return (
    <div
      className="flex flex-col"
      data-testid="workspace-row"
      data-workspace-id={workspace.id}
      data-is-active={isActive ? "true" : "false"}
      data-is-personal={workspace.isPersonal === true ? "true" : "false"}
      data-expanded={expanded ? "true" : "false"}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid="workspace-row-toggle"
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 mx-2 rounded-md text-sm transition-colors text-left",
          isActive
            ? "bg-sidebar-foreground/10 text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-foreground/5",
        )}
      >
        {expanded ? (
          <ChevronDown className="shrink-0" style={{ width: 14, height: 14 }} />
        ) : (
          <ChevronRight className="shrink-0" style={{ width: 14, height: 14 }} />
        )}
        <span className="flex-1 truncate font-medium">{workspace.name}</span>
        {workspace.userRole && <RoleBadge role={workspace.userRole} />}
      </button>
      {expanded && <WorkspaceAppList workspace={workspace} selectedAppRoute={selectedAppRoute} />}
    </div>
  );
}
