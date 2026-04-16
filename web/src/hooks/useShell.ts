import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellData } from "../api/client";
import { getShell } from "../api/client";
import type { PlacementEntry } from "../types";

export function useShell(_token: string, workspaceId?: string, initialShell?: ShellData) {
  const [shell, setShell] = useState<ShellData | null>(initialShell ?? null);
  const [loading, setLoading] = useState(!initialShell);
  const [error, setError] = useState<string | null>(null);
  // When bootstrap data is provided, skip the first effect invocation
  const skipNext = useRef(!!initialShell);

  // biome-ignore lint/correctness/useExhaustiveDependencies: workspaceId is a parameter that drives refetch
  useEffect(() => {
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }

    let cancelled = false;
    // Only show loading screen when there's no shell data at all (initial mount).
    // During workspace switch, keep the old shell visible and swap atomically.
    if (!shell) setLoading(true);
    setError(null);

    getShell()
      .then((data) => {
        if (!cancelled) {
          setShell(data);
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
        .sort((a, b) => a.priority - b.priority);
    },
    [shell],
  );

  const mainRoutes = useCallback((): PlacementEntry[] => {
    if (!shell) return [];
    return shell.placements.filter(
      (p) => (p.slot === "main" || p.slot === "sidebar.bottom") && p.route,
    );
  }, [shell]);

  return { shell, loading, error, forSlot, mainRoutes };
}
