import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listNotifications, markNotificationsRead } from "../api/notifications";
import { useEvents } from "../hooks/useEvents";
import { NotificationsContext, type NotificationsValue } from "./NotificationsContext";

/**
 * Holds the focused workspace's unread count for the whole shell, and the
 * signal that the inbox changed.
 *
 * The count is the server's (`unread` on `notifications__list`), over the whole
 * inbox: a count taken from a page of items stops at the page size. The read
 * asks for one item, because the count is all it keeps. The inbox page holds
 * its own list, filtered, and re-reads it when `revision` moves.
 *
 * **Live, then reconciled.** `notification.created` says the inbox moved; it
 * does not say what it now holds. The provider re-reads instead, and the read
 * is debounced because a poll cycle delivers a batch: forty events from one
 * sweep are one read, not forty.
 *
 * **And refetched on reconnect.** The workspace stream has no `Last-Event-Id`
 * replay, so everything that arrived during a disconnect is simply absent from
 * the stream. Without the reconnect read an inbox left open through a deploy
 * shows yesterday's list and no sign that it is wrong.
 *
 * **A delivery frame refetches for the same reason a creation does.** A route's
 * ledger row changes *after* the item was announced, so a list painted from
 * `notification.created` alone holds a delivery frozen at the instant the item
 * arrived — which is before anything had been tried.
 */

/** How long a burst of frames coalesces into one read. */
const REFRESH_DEBOUNCE_MS = 300;

export function NotificationsProvider({
  token,
  workspaceId,
  children,
}: {
  token: string;
  workspaceId?: string;
  children: ReactNode;
}) {
  const [unread, setUnread] = useState(0);
  const [revision, setRevision] = useState(0);

  // The workspace a read was issued for. A read that lands after a switch is
  // dropped rather than applied: it answers for the workspace it named at send
  // time, so a late response is another workspace's count.
  const requestedFor = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback(async (wsId: string) => {
    requestedFor.current = wsId;
    try {
      const out = await listNotifications({ limit: 1 }, wsId);
      if (requestedFor.current !== wsId) return;
      setUnread(out.unread);
    } catch {
      // The count is a hint on a bell. A failed read keeps the last one; the
      // inbox page reports its own read's failures.
    } finally {
      if (requestedFor.current === wsId) setRevision((r) => r + 1);
    }
  }, []);

  const refresh = useCallback(() => {
    if (!workspaceId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void read(workspaceId);
    }, REFRESH_DEBOUNCE_MS);
  }, [workspaceId, read]);

  // A switch reads without the debounce: it is a user action waiting on an
  // answer, not a burst to absorb. The previous workspace's count is cleared
  // first so it never sits on the bell under the new workspace.
  useEffect(() => {
    setUnread(0);
    if (!workspaceId) {
      requestedFor.current = undefined;
      return;
    }
    void read(workspaceId);
  }, [workspaceId, read]);

  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);

  useEvents(token, workspaceId, {
    onNotificationCreated: refresh,
    onNotificationRead: refresh,
    onNotificationDelivery: refresh,
    onReconnect: refresh,
  });

  const markRead = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0 || !workspaceId) return;
      // Painted before the call returns. Marking read is idempotent and its
      // only failure mode is an item staying unread, so waiting a round trip
      // to clear the bell buys nothing. The re-read after it, success or not,
      // puts the store's count back on it.
      setUnread((n) => Math.max(0, n - ids.length));
      try {
        await markNotificationsRead(ids, workspaceId);
      } finally {
        void read(workspaceId);
      }
    },
    [workspaceId, read],
  );

  const value = useMemo<NotificationsValue>(
    () => ({ unread, revision, refresh, markRead }),
    [unread, revision, refresh, markRead],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
