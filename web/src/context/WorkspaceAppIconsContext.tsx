import { createContext, useContext } from "react";

export interface WorkspaceAppIconsValue {
  /**
   * Brand icon URL for an installed app by `serverName`, or `undefined`
   * when the app has no registry icon. Callers pass the result straight
   * to `ConnectorIcon`, which falls back to a deterministic letter
   * avatar on `undefined` / load failure.
   */
  iconFor: (serverName: string) => string | undefined;
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
