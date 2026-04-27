import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { callTool, setActiveWorkspaceId } from "../api/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceInfo {
  id: string;
  name: string;
  memberCount: number;
  bundles: Array<{ name?: string; path?: string }>;
  /** The signed-in user's role within this workspace, when they're a member. */
  userRole?: "admin" | "member";
}

interface WorkspaceContextValue {
  workspaces: WorkspaceInfo[];
  activeWorkspace: WorkspaceInfo | null;
  setActiveWorkspace: (ws: WorkspaceInfo) => void;
  loading: boolean;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaces: [],
  activeWorkspace: null,
  setActiveWorkspace: () => {},
  loading: true,
});

const STORAGE_KEY = "nb_active_workspace";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface WorkspaceProviderProps {
  children: ReactNode;
  /** Pre-fetched workspace list from bootstrap. Skips the tool call when provided. */
  initialWorkspaces?: WorkspaceInfo[];
  /** Pre-resolved active workspace ID from bootstrap. */
  initialActiveId?: string;
}

export function WorkspaceProvider({
  children,
  initialWorkspaces,
  initialActiveId,
}: WorkspaceProviderProps) {
  const hasBootstrap = initialWorkspaces !== undefined;

  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>(
    hasBootstrap ? initialWorkspaces : [],
  );
  const [activeWorkspace, setActiveState] = useState<WorkspaceInfo | null>(() => {
    if (hasBootstrap && initialWorkspaces.length > 0) {
      const active = initialActiveId
        ? (initialWorkspaces.find((w) => w.id === initialActiveId) ?? initialWorkspaces[0])
        : initialWorkspaces[0];
      if (active) setActiveWorkspaceId(active.id);
      return active ?? null;
    }
    return null;
  });
  const [loading, setLoading] = useState(!hasBootstrap);

  // Persist selection and sync header
  const setActiveWorkspace = useCallback((ws: WorkspaceInfo) => {
    setActiveState(ws);
    setActiveWorkspaceId(ws.id);
    try {
      localStorage.setItem(STORAGE_KEY, ws.id);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  // Fallback: fetch via tool call when no bootstrap data is provided
  useEffect(() => {
    if (hasBootstrap) return;

    let cancelled = false;

    callTool("nb", "manage_workspaces", { action: "list" })
      .then((res) => {
        if (cancelled) return;

        // Parse response — JSON in content[0].text or structuredContent
        let raw: unknown = res.structuredContent;
        if (!raw && res.content?.[0]?.text) {
          try {
            raw = JSON.parse(res.content[0].text);
          } catch {
            raw = null;
          }
        }

        // The response may be { workspaces: [...] } or an array directly
        let list: WorkspaceInfo[] = [];
        if (Array.isArray(raw)) {
          list = raw as WorkspaceInfo[];
        } else if (raw && typeof raw === "object" && "workspaces" in raw) {
          list = (raw as { workspaces: WorkspaceInfo[] }).workspaces;
        }

        setWorkspaces(list);

        // Restore persisted selection or pick first
        const savedId = localStorage.getItem(STORAGE_KEY);
        const saved = savedId ? list.find((w) => w.id === savedId) : null;
        const initial = saved ?? list[0] ?? null;

        if (initial) {
          setActiveState(initial);
          setActiveWorkspaceId(initial.id);
        }

        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hasBootstrap]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({ workspaces, activeWorkspace, setActiveWorkspace, loading }),
    [workspaces, activeWorkspace, setActiveWorkspace, loading],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWorkspaceContext(): WorkspaceContextValue {
  return useContext(WorkspaceContext);
}
