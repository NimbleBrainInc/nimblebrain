import { useEffect, useState } from "react";
import type { ConversationStarter } from "../_generated/platform-schemas/home";
import { callTool } from "../api/client";
import { parseToolResponse } from "../lib/tool-response";

interface Loaded {
  workspaceId: string;
  starters: ConversationStarter[];
}

/**
 * The conversation starters the workspace's plugins offer
 * (`nb__conversation_starters`), or `null` until they load for this workspace.
 * A failed read is `[]`: starters are a suggestion, and the overview stands
 * without them.
 *
 * The call names the workspace rather than riding the active one, and a result
 * is kept with the workspace it was fetched for, so one workspace's starters
 * never paint under another mid-switch.
 */
export function useConversationStarters(
  workspaceId: string | undefined,
): ConversationStarter[] | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    callTool("nb", "conversation_starters", {}, { workspaceId })
      .then(
        (res) =>
          parseToolResponse<{ conversationStarters: ConversationStarter[] }>(res)
            .conversationStarters,
      )
      .catch(() => [])
      .then((starters) => {
        if (!cancelled) setLoaded({ workspaceId, starters });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return workspaceId != null && loaded?.workspaceId === workspaceId ? loaded.starters : null;
}
