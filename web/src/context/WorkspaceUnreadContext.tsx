import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { tryBootstrap } from "../api/client";
import { useEvents } from "../hooks/useEvents";
import type { BootstrapResponse } from "../types";

export interface WorkspaceUnreadValue {
  /** Items nobody has read in this workspace's inbox. 0 for a workspace it has not heard of. */
  unreadFor: (workspaceId: string) => number;
}

/**
 * Unread counts for every workspace the viewer belongs to, for the dots that
 * point at another workspace (the switcher, the home tiles). The focused
 * workspace's bell reads `NotificationsContext`, which follows the same frames.
 *
 * Seeded from bootstrap, then carried by the frames themselves: both
 * `notification.created` and `notification.read` say what the count is after
 * them, so a frame for any workspace sets that workspace's count with no
 * read. The stream has no replay, so a reconnect re-reads bootstrap, which is
 * the one call that counts every membership.
 *
 * The default is no counts rather than a throw, so a consumer rendered outside
 * the provider shows no dots.
 */
const WorkspaceUnreadContext = createContext<WorkspaceUnreadValue>({ unreadFor: () => 0 });

function countsFrom(workspaces: BootstrapResponse["workspaces"]): Record<string, number> {
  return Object.fromEntries(workspaces.map((ws) => [ws.id, ws.unread]));
}

export function WorkspaceUnreadProvider({
  workspaces,
  children,
}: {
  workspaces: BootstrapResponse["workspaces"];
  children: ReactNode;
}) {
  const [counts, setCounts] = useState<Record<string, number>>(() => countsFrom(workspaces));

  const set = useCallback((workspaceId: string, unread: number) => {
    setCounts((current) =>
      current[workspaceId] === unread ? current : { ...current, [workspaceId]: unread },
    );
  }, []);

  useEvents({
    onNotificationCreated: (event) => set(event.workspaceId, event.unread),
    onNotificationRead: (event) => set(event.workspaceId, event.unread),
    onReconnect: () => {
      void tryBootstrap().then((data) => {
        if (data) setCounts(countsFrom(data.workspaces));
      });
    },
  });

  const value = useMemo<WorkspaceUnreadValue>(
    () => ({ unreadFor: (workspaceId) => counts[workspaceId] ?? 0 }),
    [counts],
  );

  return (
    <WorkspaceUnreadContext.Provider value={value}>{children}</WorkspaceUnreadContext.Provider>
  );
}

export function useWorkspaceUnread(): WorkspaceUnreadValue {
  return useContext(WorkspaceUnreadContext);
}
