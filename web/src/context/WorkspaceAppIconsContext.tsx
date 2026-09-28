import { createContext, useContext } from "react";
import type { InstalledConnector } from "../api/client";

/** The installed connectors of one workspace, tagged with the workspace they were read for. */
export interface WorkspaceConnectors {
  workspaceId: string;
  installed: InstalledConnector[];
}

export interface WorkspaceAppIconsValue {
  /**
   * Brand icon URL for an installed app by `serverName`, or `undefined`
   * when the app has no registry icon. Callers pass the result straight
   * to `ConnectorIcon`, which falls back to a deterministic letter
   * avatar on `undefined` / load failure.
   */
  iconFor: (serverName: string) => string | undefined;
  /**
   * Number of connectors installed in the focused workspace, or `undefined`
   * before the first fetch. Sourced from the SAME `getInstalledConnectors`
   * call that builds the icon map — exposed here so the sidebar's Connectors
   * count reuses that fetch rather than firing its own `manage_connectors`
   * (the duplicate-fetch trap #317 calls out).
   */
  connectorCount?: number;
  /**
   * The focused workspace's installed connectors, from that same call, with
   * their host-derived `status`. The overview reads it for the connectors that
   * need attention. Callers compare `workspaceId` to the workspace they render:
   * after a switch it names the previous workspace until the refetch lands.
   */
  connectors?: WorkspaceConnectors;
}

// Default is a no-op resolver so consumers rendered outside the provider
// (or before its first fetch) degrade to letter avatars rather than
// crash. Kept in its own module — separate from the provider — so
// consumers can import the hook without pulling in the provider's
// data-fetch / SSE dependency chain (api/client, useEvents). Mirrors the
// ShellContext split.
export const WorkspaceAppIconsContext = createContext<WorkspaceAppIconsValue>({
  iconFor: () => undefined,
});

export function useWorkspaceAppIcons(): WorkspaceAppIconsValue {
  return useContext(WorkspaceAppIconsContext);
}
