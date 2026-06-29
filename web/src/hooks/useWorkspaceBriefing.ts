import { useCallback, useEffect, useReducer, useRef, useState } from "react";
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
  // `bump` forces a re-render when the async fetch fills the module cache; both
  // `briefing` and `loading` are then read from the cache DURING render (below),
  // keyed on the CURRENT workspaceId. That render-time read is what kills the
  // switch flash: an effect-backed value paints one frame of the previous
  // workspace's briefing (or a blank gap) under the new header before the effect
  // catches up — a render-time value is correct on the very first frame.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id — drops responses that resolve after a newer fetch
  // (workspace switched, or a refresh raced the initial load).
  const reqRef = useRef(0);

  const load = useCallback(
    async (forceRefresh: boolean) => {
      if (!workspaceId) return;
      const seq = ++reqRef.current;
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
          bump();
        }
      } catch (err) {
        if (seq === reqRef.current) {
          setError(err instanceof Error ? err.message : "Failed to load briefing");
        }
      }
    },
    [workspaceId],
  );

  // (Re)fetch when the workspace changes. A cached workspace revalidates
  // silently (the derived `loading` below is already false because its entry is
  // cached); an uncached one shows the skeleton until the fetch fills it.
  useEffect(() => {
    setError(null);
    if (workspaceId) void load(false);
  }, [workspaceId, load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  // Both derived from the cache at render time, keyed on the current workspace —
  // so a switch is correct on the first painted frame: a revisit shows its
  // cached briefing with no flash, and a first visit shows the skeleton with no
  // blank gap. The skeleton (loading) is only "nothing cached yet, no error".
  const briefing = workspaceId ? (briefingCache.get(workspaceId) ?? null) : null;
  const loading = workspaceId != null && !briefingCache.has(workspaceId) && error === null;
  return { briefing, loading, error, refresh };
}
