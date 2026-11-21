import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginsListOutput } from "../_generated/platform-schemas/plugins";
import { listPlugins } from "../api/client";
import { useEvents } from "../hooks/useEvents";
import { ChatPluginsContext } from "./ChatPluginsContext";

const NO_PLUGINS: PluginsListOutput["plugins"] = [];

/**
 * Reads `listPlugins` once for the chat's workspace and shares it with every
 * row of the timeline. Refetched on a workspace change, on the
 * connector-lifecycle SSE signal (install, uninstall), which is what changes
 * the set of plugins, on a connection's state change, which is what a
 * plugin request card waits on after a sign-in, and on the viewer turning a
 * personal plugin on or off here, from any tab, which is what a request card's
 * "Turned on here." reads.
 *
 * The listing is tagged with the workspace it was read for and served only
 * while that is still the chat's workspace, so a switch never labels one
 * workspace's calls with another's plugins. A failed read labels nothing:
 * attribution is decoration, and the timeline renders without it.
 */
export function ChatPluginsProvider({
  workspaceId,
  children,
}: {
  workspaceId?: string;
  children: ReactNode;
}) {
  const [listing, setListing] = useState<PluginsListOutput | undefined>(undefined);
  // A response that lands after a newer request (a switch, or an SSE refetch
  // racing one) is dropped.
  const reqRef = useRef(0);

  const refresh = useCallback(async (wsId: string) => {
    const seq = ++reqRef.current;
    try {
      const { plugins } = await listPlugins(wsId);
      if (seq === reqRef.current) setListing({ wsId, plugins });
    } catch {
      // Keep what we have; a listing for another workspace is never served.
    }
  }, []);

  useEffect(() => {
    if (workspaceId) void refresh(workspaceId);
  }, [workspaceId, refresh]);

  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  useEvents({
    onConnectorLifecycleChanged: () => {
      if (workspaceRef.current) void refresh(workspaceRef.current);
    },
    onConnectionStateChanged: () => {
      if (workspaceRef.current) void refresh(workspaceRef.current);
    },
    onConnectorGrantChanged: ({ wsId }) => {
      if (wsId === workspaceRef.current) void refresh(wsId);
    },
  });

  const plugins = listing && listing.wsId === workspaceId ? listing.plugins : NO_PLUGINS;
  return <ChatPluginsContext.Provider value={plugins}>{children}</ChatPluginsContext.Provider>;
}
