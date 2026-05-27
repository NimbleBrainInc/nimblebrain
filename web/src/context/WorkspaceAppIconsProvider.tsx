import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { getInstalledConnectors } from "../api/client";
import { useEvents } from "../hooks/useEvents";
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
 * same bundle-lifecycle / connection-state SSE signals that refresh the
 * shell placements, so icons stay in lockstep with the app set.
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

  const refresh = useCallback(async () => {
    try {
      const { installed } = await getInstalledConnectors({ scope: "workspace" });
      const next = new Map<string, string>();
      for (const c of installed) {
        if (c.iconUrl) next.set(c.serverName, c.iconUrl);
      }
      setIcons(next);
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

  // Brand icons appear / disappear when a bundle is installed or
  // uninstalled, or when a connection settles — mirror the shell's
  // refetch triggers.
  useEvents(token, workspaceId, {
    onBundleLifecycleChanged: () => {
      void refresh();
    },
    onConnectionStateChanged: () => {
      void refresh();
    },
  });

  const value = useMemo<WorkspaceAppIconsValue>(
    () => ({ iconFor: (serverName: string) => icons.get(serverName) }),
    [icons],
  );

  return (
    <WorkspaceAppIconsContext.Provider value={value}>{children}</WorkspaceAppIconsContext.Provider>
  );
}
