import { createContext, useContext } from "react";

export interface NotificationsValue {
  /** Items nobody has marked read in the focused workspace's whole inbox. */
  unread: number;
  /**
   * Bumps each time the inbox is known to have changed: a live frame, a
   * reconnect, a mark. A view that holds its own read of the inbox (a filtered
   * list) re-reads when this moves, so it follows the stream without opening
   * one of its own.
   */
  revision: number;
  /** Re-read. Coalesced with any read already in flight. */
  refresh: () => void;
  /**
   * Mark these ids read. `unread` drops before the call returns, by the number
   * of ids, so pass only ids the caller knows are unread; the re-read after it
   * reconciles the count either way.
   */
  markRead: (ids: string[]) => Promise<void>;
}

/**
 * The focused workspace's inbox, as the shell needs it: how much is unread,
 * and a signal that something changed. The top bar's bell reads the first;
 * the inbox page reads the second and holds its own filtered list.
 *
 * Kept in its own module — separate from the provider — so a consumer can
 * import the hook without pulling in the provider's data-fetch and SSE
 * dependency chain. Mirrors the `WorkspaceAppIcons` split.
 *
 * The default is an empty, inert inbox rather than a throw: a consumer rendered
 * outside the provider shows no badge, which is the same thing it shows when
 * there is nothing unread.
 */
export const NotificationsContext = createContext<NotificationsValue>({
  unread: 0,
  revision: 0,
  refresh: () => {},
  markRead: async () => {},
});

export function useNotifications(): NotificationsValue {
  return useContext(NotificationsContext);
}
