import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { setActiveWorkspaceId, tryBootstrap } from "../api/client";
import { bootstrapWorkspacesToInfo } from "../lib/bootstrap";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceInfo {
  id: string;
  name: string;
  memberCount: number;
  /** Connectors installed in the workspace, as of the bootstrap that loaded it. */
  connectorCount: number;
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
  /** Re-read the list from bootstrap, after a write that adds or removes a workspace. */
  refreshWorkspaces: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaces: [],
  activeWorkspace: null,
  setActiveWorkspace: () => {},
  refreshWorkspaces: async () => {},
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
  /**
   * A workspace to start focused on, for a provider mounted outside the router
   * (a test, an embedded surface). The app passes none: the URL names the
   * workspace, and the route guard focuses it.
   */
  initialActiveId?: string;
}

export function WorkspaceProvider({
  children,
  initialWorkspaces,
  initialActiveId,
}: WorkspaceProviderProps) {
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [activeWorkspace, setActiveState] = useState<WorkspaceInfo | null>(() => {
    // The URL is the only source of which workspace the user is in: the route
    // guard focuses the workspace a `/w/:slug` path names. Nothing is focused
    // until one does, and a page outside `/w/` names none (ADR-0044).
    const active = initialWorkspaces.find((w) => w.id === initialActiveId);
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

  // Bootstrap is the one call that lists the viewer's memberships, so a write
  // that changes them re-reads it. The focused entry is swapped for its fresh
  // copy, and a focused workspace the list no longer holds (deleted, or the
  // viewer removed) drops focus rather than leave its nav pointing nowhere.
  const refreshWorkspaces = useCallback(async () => {
    const data = await tryBootstrap();
    if (!data) return;
    const next = bootstrapWorkspacesToInfo(data.workspaces);
    setWorkspaces(next);
    setActiveState((current) => (current && next.find((w) => w.id === current.id)) ?? null);
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({ workspaces, activeWorkspace, setActiveWorkspace, refreshWorkspaces }),
    [workspaces, activeWorkspace, setActiveWorkspace, refreshWorkspaces],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWorkspaceContext(): WorkspaceContextValue {
  return useContext(WorkspaceContext);
}
