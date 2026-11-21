// ---------------------------------------------------------------------------
// LandingRedirect — what `/` does.
//
// `/` is not a page. It opens a workspace: the one this browser was last in,
// while the viewer is still a member, else the first in the switcher's order
// (ADR-0073). Every link to `/` (the logo, the palette, a bounce from a
// workspace the viewer cannot reach) therefore lands in a workspace, and the
// switcher names it. A viewer in no workspace, which bootstrap prevents but
// leaving or losing every workspace can produce, is offered a new one.
// ---------------------------------------------------------------------------

import { Plus } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { landingWorkspace, readLastWorkspace } from "../lib/last-workspace";
import { toSlug } from "../lib/workspace-slug";

export function LandingRedirect() {
  const { workspaces } = useWorkspaceContext();
  const target = landingWorkspace(workspaces, readLastWorkspace());
  if (target) return <Navigate to={`/w/${toSlug(target.id)}/`} replace />;

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-(--page-gutter) text-center"
      data-testid="landing-no-workspace"
    >
      <p className="text-base font-medium text-foreground">You're not in any workspace</p>
      <p className="text-sm text-muted-foreground">
        Create one, or ask an admin to add you to one.
      </p>
      <Link
        to="/org/workspaces"
        className="mt-1 inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 transition-colors"
      >
        <Plus className="size-4" aria-hidden />
        New workspace
      </Link>
    </div>
  );
}
