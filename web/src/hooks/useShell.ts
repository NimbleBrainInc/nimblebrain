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
  const [loading, setLoading] = useState(workspaceId !== undefined);
  const [error, setError] = useState<string | null>(null);
  // Which workspace the current `shell` placements reflect.
  //
  // Why a separate signal and not just `loading`: on a workspace switch we
  // deliberately keep the old shell visible and leave `loading === false` (no
  // sidebar flash). During that window `shell` still holds the *previous*
  // workspace's placements, so a per-workspace consumer (the overview page's
  // app grid) needs to know the shell hasn't caught up yet — `loading` can't
  // tell it. Comparing `shellWorkspaceId` to the target id closes that gap.
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: workspaceId is a parameter that drives refetch
  useEffect(() => {
    if (!workspaceId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Only show loading screen when there's no shell data at all (initial mount).
    // During workspace switch, keep the old shell visible and swap atomically.
    if (!shell) setLoading(true);
    setError(null);

    getShell(workspaceId)
      .then((data) => {
        if (!cancelled) {
          setShell(data);
          setShellWorkspaceId(workspaceId);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load shell");
          setLoading(false);
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

  return { shell, loading, error, shellWorkspaceId, forSlot, mainRoutes, refresh };
}
