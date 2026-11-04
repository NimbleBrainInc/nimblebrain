import { useCallback, useEffect, useRef, useState } from "react";
import { getShell } from "../api/client";
import type { PlacementEntry, ShellResponse } from "../types";

/**
 * The focused workspace's shell: its placements. With no workspace (a page
 * outside `/w/`) there is none to read, so nothing is fetched and the shell
 * stays empty until a workspace is focused.
 */
export function useShell(_token: string, workspaceId?: string) {
  const [shell, setShell] = useState<ShellResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which workspace the current `shell` placements reflect. Placements load
  // behind the mounted app: it stays up while they do, because state held
  // under it (chat, preferences re-read since sign-in) would otherwise be lost.
  // Until a load lands, `shell` is empty or still the *previous* workspace's,
  // so a per-workspace consumer (the overview page's app grid) compares
  // `shellWorkspaceId` to the id it wants before trusting the placements.
  const [shellWorkspaceId, setShellWorkspaceId] = useState<string | undefined>(undefined);
  // Latest workspaceId, readable from the stable `refresh` callback without
  // making it churn (and re-subscribe its SSE consumer) on every switch.
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  /**
   * Refetch the shell payload. Used by connector lifecycle SSE events so
   * newly-installed apps surface in the sidebar without a page reload.
   * Keep the old shell visible during the swap (no loading flash) — same
   * pattern as the workspace-switch refetch.
   */
  const refresh = useCallback(async () => {
    const wsId = workspaceIdRef.current;
    if (!wsId) return;
    try {
      const data = await getShell(wsId);
      setShell(data);
      setShellWorkspaceId(wsId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load shell");
    }
  }, []);

  useEffect(() => {
    if (!workspaceId) return;

    let cancelled = false;
    setError(null);

    getShell(workspaceId)
      .then((data) => {
        if (!cancelled) {
          setShell(data);
          setShellWorkspaceId(workspaceId);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load shell");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const forSlot = useCallback(
    (slot: string): PlacementEntry[] => {
      if (!shell) return [];
      return shell.placements
        .filter((p) => p.slot === slot || p.slot.startsWith(`${slot}.`))
        .sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          const aLabel = a.label ?? a.route ?? "";
          const bLabel = b.label ?? b.route ?? "";
          return aLabel.localeCompare(bLabel, undefined, { sensitivity: "base" });
        });
    },
    [shell],
  );

  const mainRoutes = useCallback((): PlacementEntry[] => {
    if (!shell) return [];
    return shell.placements.filter(
      (p) => (p.slot === "main" || p.slot === "sidebar.bottom") && p.route,
    );
  }, [shell]);

  return { shell, error, shellWorkspaceId, forSlot, mainRoutes, refresh };
}
