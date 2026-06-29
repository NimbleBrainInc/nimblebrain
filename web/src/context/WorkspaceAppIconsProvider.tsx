import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { getInstalledConnectors } from "../api/client";
import { useEvents } from "../hooks/useEvents";
import { iconMapFromInstalled } from "../lib/workspace-apps";
import { WorkspaceAppIconsContext, type WorkspaceAppIconsValue } from "./WorkspaceAppIconsContext";

/**
 * Shares the focused workspace's app brand icons across the sidebar
 * quick-list and the workspace overview grid from a single fetch.
 *
 * The brand-icon resolution itself is server-side and centralized in
 * `manage_connectors` (`catalog.iconUrl ?? mpak ServerDetail.icons[0].src`,
 * matched by package name) — see `src/tools/connector-tools.ts`. This
 * provider only caches the `serverName → iconUrl` projection so the UI
 * never re-implements that resolution or fans out duplicate fetches.
 *
 * Scoped to the active workspace (the connectors list reads the
 * `X-Workspace-Id` header); refetched on workspace switch and on the
 * bundle-lifecycle SSE signals (install / uninstall) that change the
 * app set, so icons stay in lockstep with it.
 */
export function WorkspaceAppIconsProvider({
  token,
  workspaceId,
  children,
}: {
  token: string;
  workspaceId?: string;
  children: ReactNode;
}) {
  const [icons, setIcons] = useState<Map<string, string>>(() => new Map());
  const [connectorCount, setConnectorCount] = useState<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const { installed } = await getInstalledConnectors({ scope: "workspace" });
      setIcons(iconMapFromInstalled(installed));
      setConnectorCount(installed.length);
    } catch {
      // Icons are decorative. On a failed fetch keep whatever we have and
      // let the letter-avatar fallback cover the gaps — never block the
      // sidebar or grid on icon resolution.
    }
  }, []);

  // Refetch when the focused workspace changes. The connectors list is
  // workspace-scoped, so a stale map would paint the previous
  // workspace's icons onto this one's apps.
  useEffect(() => {
    if (!workspaceId) return;
    void refresh();
  }, [workspaceId, refresh]);

  // Brand icons appear / disappear only when a bundle is installed or
  // uninstalled. We intentionally do NOT refetch on
  // connection.state_changed: a single install drives the connection
  // through starting → pending_auth → running, but the icon for a row
  // resolves from catalog/mpak metadata that's already present at
  // bundle.installed time — connection state never changes it. Wiring
  // those transitions to refresh() turned one Install click into a
  // 3-4× manage_connectors burst (#317). bundle.installed /
  // bundle.uninstalled are the only events that change the icon set.
  useEvents(token, workspaceId, {
    onBundleLifecycleChanged: () => {
      void refresh();
    },
  });

  const value = useMemo<WorkspaceAppIconsValue>(
    () => ({ iconFor: (serverName: string) => icons.get(serverName), connectorCount }),
    [icons, connectorCount],
  );

  return (
    <WorkspaceAppIconsContext.Provider value={value}>{children}</WorkspaceAppIconsContext.Provider>
  );
}
