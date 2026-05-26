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
  const [briefing, setBriefing] = useState<BriefingOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id — drops responses that resolve after a newer fetch
  // (workspace switched, or a refresh raced the initial load).
  const reqRef = useRef(0);

  const load = useCallback(
    async (forceRefresh: boolean) => {
      if (!workspaceId) return;
      const seq = ++reqRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await callTool(
          "nb",
          "briefing",
          forceRefresh ? { force_refresh: true } : {},
        );
        const out = parseToolResult<BriefingOutput>(result);
        if (seq === reqRef.current) setBriefing(out);
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

  // Refetch when the active workspace lands or changes. Clear immediately so a
  // switch never flashes the previous workspace's briefing under the new
  // header — but set `loading` in the SAME commit so the card paints its
  // skeleton straight away instead of a blank gap (the fetch's own
  // `setLoading(true)` runs a microtask later, leaving a one-frame blank
  // otherwise).
  useEffect(() => {
    setBriefing(null);
    setError(null);
    if (workspaceId) {
      setLoading(true);
      void load(false);
    } else {
      setLoading(false);
    }
  }, [workspaceId, load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  return { briefing, loading, error, refresh };
}
