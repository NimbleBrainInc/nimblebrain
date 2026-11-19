import { useEffect, useState } from "react";
import { callTool } from "../api/client";
import { parseToolResponse } from "../lib/tool-response";

/** How many runs the overview reads to count; past this it shows the cap. */
export const REVIEW_LIMIT = 50;

interface Loaded {
  workspaceId: string;
  count: number;
}

/**
 * How many of the member's automation runs in this workspace wait for a
 * person's verdict (`tasks__runs`, label "Needs review"), or `null` until it
 * loads for this workspace. A failed read is 0: the count is a shortcut, and
 * the Automations view is the place that reports errors.
 *
 * The call names the workspace rather than riding the active one, and a result
 * is kept with the workspace it was fetched for, so a count from one workspace
 * never paints under another mid-switch.
 */
export function useRunsNeedingReview(workspaceId: string | undefined): number | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    callTool("tasks", "runs", { label: "Needs review", limit: REVIEW_LIMIT }, { workspaceId })
      .then((res) => parseToolResponse<{ runs: unknown[] }>(res).runs.length)
      .catch(() => 0)
      .then((count) => {
        if (!cancelled) setLoaded({ workspaceId, count });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return workspaceId != null && loaded?.workspaceId === workspaceId ? loaded.count : null;
}
