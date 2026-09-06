import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listNotifications,
  markNotificationsRead,
  type NotificationView,
} from "../api/notifications";
import { useEvents } from "../hooks/useEvents";
import { INBOX_PAGE_SIZE } from "../lib/notification-levels";
import { NotificationsContext, type NotificationsValue } from "./NotificationsContext";

/**
 * Holds the focused workspace's inbox for the whole shell.
 *
 * One read serves the left-nav unread badge and the inbox view, the way
 * `WorkspaceAppIconsProvider` serves the sidebar and the overview grid — two
 * consumers of the same fact should not be two fetches of it.
 *
 * **Live, then reconciled.** `notification.created` says the list moved; it
 * does not say what the list now is. The frame carries a summary (no body, no
 * link, no connector payload), so rendering from it would put a different item
 * on screen than a reload would. The provider refetches instead, and the
 * refetch is debounced because a poll cycle delivers a batch: forty events from
 * one sweep are one read, not forty.
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
  const [items, setItems] = useState<NotificationView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The workspace a read was issued for. A read that lands after a switch is
  // dropped rather than applied: the tool answers for whatever workspace the
  // request header named at send time, so a late response is another
  // workspace's inbox, and painting it here is a cross-workspace leak in the
  // one place the user would never think to check.
  const requestedFor = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback(async (wsId: string) => {
    requestedFor.current = wsId;
    try {
      const out = await listNotifications({ limit: INBOX_PAGE_SIZE });
      if (requestedFor.current !== wsId) return;
      setItems(out.notifications);
      setError(null);
    } catch (err) {
      if (requestedFor.current !== wsId) return;
      setError(err instanceof Error ? err.message : "Could not read this workspace's inbox");
    } finally {
      if (requestedFor.current === wsId) setLoading(false);
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

  // The focused workspace's inbox, read without the debounce — a switch is a
  // user action waiting on an answer, not a burst to absorb. The previous
  // workspace's items are cleared first so its titles never sit under the new
  // workspace's name while the read is in flight.
  useEffect(() => {
    if (!workspaceId) {
      requestedFor.current = undefined;
      setItems([]);
      setLoading(false);
      return;
    }
    setItems([]);
    setLoading(true);
    void read(workspaceId);
  }, [workspaceId, read]);

  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);

  useEvents(token, workspaceId, {
    onNotificationCreated: refresh,
    onNotificationDelivery: refresh,
    onReconnect: refresh,
  });

  const markRead = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0 || !workspaceId) return;
      // Painted before the call returns. Marking read is idempotent and its
      // only failure mode is an item staying unread, so waiting a round trip
      // to un-bold a row an admin just opened buys nothing.
      setItems((current) =>
        current.map((item) =>
          ids.includes(item.id) && !item.readAt
            ? { ...item, readAt: new Date().toISOString() }
            : item,
        ),
      );
      try {
        await markNotificationsRead(ids);
      } catch {
        // The optimistic paint is wrong now. Re-read rather than reverting by
        // hand — the store is the only thing that knows what actually changed.
        void read(workspaceId);
      }
    },
    [workspaceId, read],
  );

  const markAllRead = useCallback(async () => {
    await markRead(items.filter((item) => !item.readAt).map((item) => item.id));
  }, [items, markRead]);

  const value = useMemo<NotificationsValue>(
    () => ({
      items,
      unread: items.reduce((n, item) => (item.readAt ? n : n + 1), 0),
      loading,
      error,
      atPageLimit: items.length >= INBOX_PAGE_SIZE,
      refresh,
      markRead,
      markAllRead,
    }),
    [items, loading, error, refresh, markRead, markAllRead],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
