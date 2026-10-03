import { useEffect, useState } from "react";
import { callTool } from "../api/client";
import { parseToolResponse } from "../lib/tool-response";

// The fields read from the `conversations__list` result (server shape:
// ListResult / IndexEntry in src/platform/conversations/index-cache.ts),
// declared locally as `RecentConversationsPopover` does: only tool inputs are
// codegen'd.
export interface RecentConversation {
  id: string;
  title: string | null;
  preview: string;
  updatedAt: string;
}
interface ListResult {
  conversations: RecentConversation[];
}

interface Loaded {
  workspaceId: string;
  conversations: RecentConversation[];
}

/**
 * The workspace's most recently updated conversations, or `null` until they
 * load for this workspace. A failed read is `[]`: the list is a shortcut, and
 * the Conversations view is the place that reports errors.
 *
 * The call names the workspace (`opts.workspaceId`) rather than riding the
 * active one, and a result is kept with the workspace it was fetched for, so a
 * list from one workspace never paints under another mid-switch.
 */
export function useRecentConversations(
  workspaceId: string | undefined,
  limit: number,
): RecentConversation[] | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    callTool("conversations", "list", { limit, sortBy: "updated" }, { workspaceId })
      .then((res) => parseToolResponse<ListResult>(res).conversations)
      .catch(() => [])
      .then((conversations) => {
        if (!cancelled) setLoaded({ workspaceId, conversations });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, limit]);

  return workspaceId != null && loaded?.workspaceId === workspaceId ? loaded.conversations : null;
}
