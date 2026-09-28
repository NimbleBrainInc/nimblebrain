import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getInstalledConnectors } from "../api/client";
import { useEvents } from "../hooks/useEvents";
import { iconMapFromInstalled } from "../lib/workspace-apps";
import {
  WorkspaceAppIconsContext,
  type WorkspaceAppIconsValue,
  type WorkspaceConnectors,
} from "./WorkspaceAppIconsContext";

/** Quiet period that collapses one connection's state transitions into one refetch. */
const STATE_CHANGE_SETTLE_MS = 500;

/**
 * Shares the focused workspace's installed connectors — their app brand
 * icons, their count, and their host-derived status — across the sidebar
 * quick-list and the workspace overview from a single fetch.
 *
 * The brand-icon resolution itself is server-side and centralized in
 * `manage_connectors` (`catalog.iconUrl`,
 * matched by package name) — see `src/tools/connector-tools.ts`. This
 * provider only caches the `serverName → iconUrl` projection so the UI
 * never re-implements that resolution or fans out duplicate fetches.
 *
 * Scoped to the active workspace (the connectors list is read through its
 * workspace path); refetched on workspace switch, on the connector-lifecycle
 * SSE signals (install / uninstall) that change the app set, and once after
 * a burst of connection state changes settles, since those change `status`.
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
  const [connectors, setConnectors] = useState<WorkspaceConnectors | undefined>(undefined);
  // Monotonic request id: a response that resolves after a newer fetch (a
  // workspace switch, or an SSE refetch racing it) is dropped.
  const reqRef = useRef(0);

  const refresh = useCallback(async (wsId: string) => {
    const seq = ++reqRef.current;
    try {
      const { installed } = await getInstalledConnectors({ scope: "workspace" });
      if (seq !== reqRef.current) return;
      setIcons(iconMapFromInstalled(installed));
      setConnectorCount(installed.length);
      setConnectors({ workspaceId: wsId, installed });
    } catch {
      // Icons are decorative. On a failed fetch keep whatever we have and
      // let the letter-avatar fallback cover the gaps — never block the
      // sidebar or grid on icon resolution. A workspace with no list yet
      // resolves to none, so the overview renders instead of waiting on it.
      if (seq !== reqRef.current) return;
      setConnectors((prev) =>
        prev?.workspaceId === wsId ? prev : { workspaceId: wsId, installed: [] },
      );
    }
  }, []);

  // Refetch when the focused workspace changes. The connectors list is
  // workspace-scoped, so a stale map would paint the previous
  // workspace's icons onto this one's apps.
  useEffect(() => {
    if (!workspaceId) return;
    void refresh(workspaceId);
  }, [workspaceId, refresh]);

  // A single install drives the connection through starting → pending_auth →
  // running; refetching on each transition turned one Install click into a
  // 3-4× manage_connectors burst (#317). Icons don't depend on connection
  // state, but `status` does, so the provider refetches once, after the
  // transitions stop arriving.
  // The timer reads the workspace when it fires, not when it was set: the
  // request goes to the workspace active then, and the result is tagged with it.
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  useEvents(token, workspaceId, {
    onConnectorLifecycleChanged: () => {
      if (workspaceId) void refresh(workspaceId);
    },
    onConnectionStateChanged: () => {
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        if (workspaceRef.current) void refresh(workspaceRef.current);
      }, STATE_CHANGE_SETTLE_MS);
    },
  });

  const value = useMemo<WorkspaceAppIconsValue>(
    () => ({
      iconFor: (serverName: string) => icons.get(serverName),
      connectorCount,
      connectors,
    }),
    [icons, connectorCount, connectors],
  );

  return (
    <WorkspaceAppIconsContext.Provider value={value}>{children}</WorkspaceAppIconsContext.Provider>
  );
}
