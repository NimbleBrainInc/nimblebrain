import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { callTool, setActiveWorkspaceId } from "../api/client";
import { parseWorkspaceListResponse } from "../lib/bootstrap";

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
  /**
   * `true` for the user's personal workspace (auto-provisioned at first
   * login, sole-owner-by-design). Drives the install dialog's preselection
   * heuristic — personal-typical connectors (`defaultBinding: "personal"`)
   * default to the personal workspace; non-personal workspaces require an
   * explicit pick. The platform's bootstrap endpoint sets this; the
   * `parseWorkspaceListResponse` fallback also propagates it so the
   * shell mounted via either path agrees.
   */
  isPersonal?: boolean;
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
    // The default focus comes from the server (`initialActiveId`, the user's
    // personal workspace). When the URL is a `/w/:slug` deep-link, the route
    // guard overrides this from the slug. There is no persisted "remembered
    // selection" — the URL is the single source of truth for which workspace
    // the user is in.
    if (hasBootstrap && initialWorkspaces.length > 0) {
      const active = initialActiveId
        ? (initialWorkspaces.find((w) => w.id === initialActiveId) ?? initialWorkspaces[0])
        : initialWorkspaces[0];
      if (active) {
        setActiveWorkspaceId(active.id);
      }
      return active ?? null;
    }
    return null;
  });
  const [loading, setLoading] = useState(!hasBootstrap);

  // Update the focused workspace + sync the request header. Driven by the URL
  // (route guard) and explicit user picks — not persisted across sessions.
  const setActiveWorkspace = useCallback((ws: WorkspaceInfo) => {
    setActiveState(ws);
    setActiveWorkspaceId(ws.id);
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

        // Route through the shared parser so `userRole` propagates regardless
        // of whether the server returns it under `role` (bootstrap shape) or
        // `userRole` (`manage_workspaces.list` shape today). Without this,
        // any drift between the two contracts silently filters every
        // workspace-scoped settings nav item for non-org-admins.
        const list = parseWorkspaceListResponse(raw);

        setWorkspaces(list);

        // No bootstrap data → default the focus to the personal workspace,
        // then the first membership. No persisted selection to restore; the
        // URL (route guard) overrides this when it's a `/w/:slug` deep-link.
        const initial = list.find((w) => w.isPersonal) ?? list[0] ?? null;

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
