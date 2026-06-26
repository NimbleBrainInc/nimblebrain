// ---------------------------------------------------------------------------
// ComposerFooter — Stage 2 / T013, Q1
//
// Two-line breadcrumb strip below the message input:
//
//   You're viewing <app display name> in <workspace display name>
//   TOOLS FROM: <ws badge> · <ws badge> · ...
//
// The viewing line answers "what's on screen". When no app is selected
// (Home, Conversations, Settings) it reads "Not viewing an app". The
// active app is derived from the URL (`/w/<slug>/app/<route>`); the
// active workspace from `WorkspaceContext`. Both sources are read
// reactively — `setActiveWorkspaceId` changing → workspace value
// changing → footer re-renders.
//
// The TOOLS FROM line is driven by `useToolWorkspaces()` (T005's
// aggregator output projected into the web), NOT by the active
// workspace. Pinning to "active workspace" would look right in a
// single-workspace test and silently break the multi-workspace case
// the spec explicitly asserts.
// ---------------------------------------------------------------------------

import { useMatch } from "react-router-dom";
import { useShellContext } from "../../context/ShellContext";
import { useToolWorkspaces } from "../../context/ToolWorkspacesContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { Badge } from "../ui/badge";
import { workspaceBadgeVariant } from "./ToolCallProvenance";

export function ComposerFooter() {
  const wsCtx = useWorkspaceContext();
  const { toolWorkspaces } = useToolWorkspaces();
  const activeApp = useActiveAppDisplayName();

  return (
    <div
      className="px-3 py-2 text-xs text-muted-foreground border-t border-border/60 space-y-1"
      data-testid="composer-footer"
    >
      <ViewingLine activeWorkspace={wsCtx.activeWorkspace} activeAppDisplayName={activeApp} />
      <ToolsFromLine workspaces={toolWorkspaces} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Viewing line
// ─────────────────────────────────────────────────────────────────────────────

function ViewingLine({
  activeWorkspace,
  activeAppDisplayName,
}: {
  activeWorkspace: WorkspaceInfo | null;
  activeAppDisplayName: string | null;
}) {
  if (!activeAppDisplayName || !activeWorkspace) {
    return (
      <div data-testid="viewing-line" data-state="no-app">
        Not viewing an app
      </div>
    );
  }
  return (
    <div data-testid="viewing-line" data-state="viewing">
      You're viewing{" "}
      <span className="text-foreground font-medium" data-testid="viewing-app">
        {activeAppDisplayName}
      </span>{" "}
      in{" "}
      <span className="text-foreground font-medium" data-testid="viewing-workspace">
        {activeWorkspace.name}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS FROM line
// ─────────────────────────────────────────────────────────────────────────────

function ToolsFromLine({ workspaces }: { workspaces: readonly WorkspaceInfo[] }) {
  if (workspaces.length === 0) {
    return (
      <div data-testid="tools-from-line" data-state="empty">
        TOOLS FROM: <span className="italic">no workspaces</span>
      </div>
    );
  }
  return (
    <div
      className="flex items-center flex-wrap gap-1.5"
      data-testid="tools-from-line"
      data-state="ready"
      data-workspace-count={workspaces.length}
    >
      <span className="uppercase tracking-wider text-3xs font-semibold">Tools from</span>
      {workspaces.map((ws) => (
        <Badge
          key={ws.id}
          variant={workspaceBadgeVariant(ws)}
          data-testid="tools-from-badge"
          data-workspace-id={ws.id}
        >
          {ws.name}
        </Badge>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Active app derivation
//
// Apps live at `/w/<slug>/app/<route>`. The placement registry (`shell`
// context) maps route → display label; we project the URL through the
// registry to a friendly name. When the route isn't an app route
// (settings, conversations, profile) or no placement matches (placement
// data not yet loaded), the viewing line falls back to "Not viewing an
// app" per the spec.
// ─────────────────────────────────────────────────────────────────────────────

function useActiveAppDisplayName(): string | null {
  const match = useMatch({ path: "/w/:slug/app/:route/*", end: false });
  const shell = useShellContext();
  if (!match) return null;
  const route = match.params.route;
  if (!route) return null;
  if (!shell) return route;
  const all = shell
    .forSlot("sidebar")
    .concat(shell.forSlot("main"))
    .concat(shell.forSlot("sidebar.bottom"));
  const placement = all.find((p) => p.route === route);
  return placement?.label ?? route;
}
