import { useCallback, useEffect, useRef, useState } from "react";
import type { BriefingOutput } from "../_generated/platform-schemas/home";
import { callTool } from "../api/client";
import { parseToolResult } from "../api/tool-result";

/** Client bound on one briefing load. The server bounds each facet read at 5 s. */
export const BRIEFING_TIMEOUT_MS = 10_000;

export interface UseWorkspaceBriefing {
  briefing: BriefingOutput | null;
  loading: boolean;
  error: string | null;
  /** Refetch, bypassing the server's per-facet cache. */
  refresh: () => void;
}

interface Loaded {
  workspaceId: string;
  briefing: BriefingOutput | null;
  error: string | null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The briefing took too long to load.")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Fetch the workspace briefing (`nb__briefing`) on mount and on `refresh()`.
 *
 * The briefing is workspace-scoped server-side via the workspace in the
 * request path, which the REST client derives from the active workspace. The
 * caller passes the workspace the page renders; a result is kept with the
 * workspace it was fetched for and read only while that is still the one
 * asked for, so nothing from one workspace paints under another, even on the
 * first frame after a switch.
 *
 * There is no client cache: the server caches each facet, and a fresh load is
 * one round-trip.
 *
 * Transport is REST (`callTool`), not the MCP iframe bridge — this is
 * first-party shell code per the API-audiences split in `src/api/AGENTS.md`.
 */
export function useWorkspaceBriefing(workspaceId: string | undefined): UseWorkspaceBriefing {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Monotonic request id — drops responses that resolve after a newer fetch
  // (workspace switched, or a refresh raced the initial load).
  const reqRef = useRef(0);

  const load = useCallback(
    async (forceRefresh: boolean) => {
      if (!workspaceId) return;
      const seq = ++reqRef.current;
      try {
        const result = await withTimeout(
          callTool("nb", "briefing", forceRefresh ? { force_refresh: true } : {}),
          BRIEFING_TIMEOUT_MS,
        );
        const briefing = parseToolResult<BriefingOutput>(result);
        if (seq === reqRef.current) setLoaded({ workspaceId, briefing, error: null });
      } catch (err) {
        if (seq === reqRef.current) {
          setLoaded({
            workspaceId,
            briefing: null,
            error: err instanceof Error ? err.message : "Failed to load briefing",
          });
        }
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => {
    setLoaded(null);
    void load(true);
  }, [load]);

  const current = workspaceId != null && loaded?.workspaceId === workspaceId ? loaded : null;
  return {
    briefing: current?.briefing ?? null,
    loading: workspaceId != null && current === null,
    error: current?.error ?? null,
    refresh,
  };
}
