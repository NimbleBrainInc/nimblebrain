import { useCallback, useEffect, useRef, useState } from "react";
import type { BriefingOutput } from "../_generated/platform-schemas/home";
import { callTool } from "../api/client";
import { parseToolResult } from "../api/tool-result";

export interface UseWorkspaceBriefing {
  briefing: BriefingOutput | null;
  loading: boolean;
  error: string | null;
  /** Force a cache-bypassing regeneration. */
  refresh: () => void;
}

// Per-workspace briefing cache, module-level so it survives the overview page
// unmounting on navigation away and back. Stale-while-revalidate: a revisit
// paints the cached briefing instantly and refetches silently, so toggling
// between already-seen workspaces never flashes a loading skeleton. The server
// has its own briefing cache/TTL behind `force_refresh`; this is just the
// client mirror that removes the per-switch round-trip from the render path.
const briefingCache = new Map<string, BriefingOutput>();

/** Test-only: clear the cross-render briefing cache for deterministic suites. */
export function __resetBriefingCache(): void {
  briefingCache.clear();
}

/**
 * Fetch the workspace activity briefing (`nb__briefing`) for the active
 * workspace.
 *
 * The briefing is workspace-scoped server-side via the `X-Workspace-Id`
 * header, which the REST client derives from the active workspace. We key the
 * fetch on `workspaceId` — and the caller must pass the *active* workspace id
 * (not the route slug's), because `WorkspaceContext.setActiveWorkspace` sets
 * the React state and the request header together. Keying on the active id
 * therefore guarantees the header matches the workspace we're fetching for,
 * with no stale-header race (the page mounts before the route guard's sync
 * effect, so the slug-derived id could briefly lead the header).
 *
 * Transport is REST (`callTool`), not the MCP iframe bridge — this is
 * first-party shell code per the API-audiences split in `CLAUDE.md`.
 */
export function useWorkspaceBriefing(workspaceId: string | undefined): UseWorkspaceBriefing {
  const [briefing, setBriefing] = useState<BriefingOutput | null>(() =>
    workspaceId ? (briefingCache.get(workspaceId) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id — drops responses that resolve after a newer fetch
  // (workspace switched, or a refresh raced the initial load).
  const reqRef = useRef(0);

  const load = useCallback(
    async (forceRefresh: boolean) => {
      if (!workspaceId) return;
      const seq = ++reqRef.current;
      // Block with a skeleton only when there's nothing cached to show for this
      // workspace (or the user explicitly forced a regen). A revalidation
      // behind a cached briefing stays silent — that's what makes a revisit
      // seamless instead of flashing the loading state.
      if (forceRefresh || !briefingCache.has(workspaceId)) setLoading(true);
      setError(null);
      try {
        const result = await callTool(
          "nb",
          "briefing",
          forceRefresh ? { force_refresh: true } : {},
        );
        const out = parseToolResult<BriefingOutput>(result);
        if (seq === reqRef.current) {
          briefingCache.set(workspaceId, out);
          setBriefing(out);
        }
      } catch (err) {
        if (seq === reqRef.current) {
          setError(err instanceof Error ? err.message : "Failed to load briefing");
        }
      } finally {
        if (seq === reqRef.current) setLoading(false);
      }
    },
    [workspaceId],
  );

  // On workspace change: paint the cached briefing immediately when we have one
  // (no skeleton), or clear to null when we don't — so a switch never shows the
  // previous workspace's briefing under the new X-Workspace-Id header. Then
  // (re)fetch: a cache hit revalidates silently, a miss shows its skeleton.
  useEffect(() => {
    setError(null);
    if (!workspaceId) {
      setBriefing(null);
      setLoading(false);
      return;
    }
    setBriefing(briefingCache.get(workspaceId) ?? null);
    void load(false);
  }, [workspaceId, load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  return { briefing, loading, error, refresh };
}
