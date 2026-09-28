import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { setActiveWorkspaceId } from "../api/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceInfo {
  id: string;
  name: string;
  memberCount: number;
  connectors: Array<{ name?: string; path?: string }>;
  /** The signed-in user's role within this workspace, when they're a member. */
  userRole?: "admin" | "member";
  /**
   * The workspace's MCP endpoint in canonical form (`<origin>/mcp/<wsId>`),
   * reported by the server. Absent when the entry came from a path that does
   * not carry it.
   */
  mcpUrl?: string;
}

interface WorkspaceContextValue {
  workspaces: WorkspaceInfo[];
  activeWorkspace: WorkspaceInfo | null;
  setActiveWorkspace: (ws: WorkspaceInfo) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaces: [],
  activeWorkspace: null,
  setActiveWorkspace: () => {},
});

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface WorkspaceProviderProps {
  children: ReactNode;
  /**
   * The workspace list from bootstrap, its only source. Listing workspaces
   * through a tool needs a workspace to address the call to, which is what
   * this list supplies.
   */
  initialWorkspaces: WorkspaceInfo[];
  /** Pre-resolved active workspace ID from bootstrap. */
  initialActiveId?: string;
}

export function WorkspaceProvider({
  children,
  initialWorkspaces,
  initialActiveId,
}: WorkspaceProviderProps) {
  const [workspaces] = useState(initialWorkspaces);
  const [activeWorkspace, setActiveState] = useState<WorkspaceInfo | null>(() => {
    // The default focus comes from the server (`initialActiveId`, the user's
    // default workspace). When the URL is a `/w/:slug` deep-link, the route
    // guard overrides this from the slug. There is no persisted "remembered
    // selection" — the URL is the single source of truth for which workspace
    // the user is in.
    const active = initialWorkspaces.find((w) => w.id === initialActiveId) ?? initialWorkspaces[0];
    if (active) {
      setActiveWorkspaceId(active.id);
    }
    return active ?? null;
  });

  // Update the focused workspace + the REST workspace paths. Driven by the URL
  // (route guard) and explicit user picks — not persisted across sessions.
  const setActiveWorkspace = useCallback((ws: WorkspaceInfo) => {
    setActiveState(ws);
    setActiveWorkspaceId(ws.id);
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({ workspaces, activeWorkspace, setActiveWorkspace }),
    [workspaces, activeWorkspace, setActiveWorkspace],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWorkspaceContext(): WorkspaceContextValue {
  return useContext(WorkspaceContext);
}
