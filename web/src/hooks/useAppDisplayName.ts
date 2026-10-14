import { useCallback, useRef } from "react";
import { useShellContext } from "../context/ShellContext";
import { useWorkspaceAppIcons } from "../context/WorkspaceAppIconsContext";
import { appDisplayName } from "../lib/app-name";

/**
 * Resolve an app's display name (`appDisplayName`) from the focused workspace's
 * installed connectors and sidebar placements. The returned function is stable
 * and reads the latest of both, so a caller that holds it in a long-lived
 * bridge callback still names the app once the installed list has loaded.
 */
export function useAppDisplayName(): (serverName: string) => string {
  const { connectors } = useWorkspaceAppIcons();
  const shell = useShellContext();
  const latest = useRef({ connectors, shell });
  latest.current = { connectors, shell };
  return useCallback((serverName: string) => {
    const { connectors: c, shell: s } = latest.current;
    return appDisplayName(serverName, c?.installed, s?.forSlot("sidebar") ?? []);
  }, []);
}
