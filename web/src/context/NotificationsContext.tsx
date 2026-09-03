import { createContext, useContext } from "react";
import type { NotificationView } from "../api/notifications";

export interface NotificationsValue {
  /** The workspace's newest items, newest first. Empty before the first read. */
  items: NotificationView[];
  /** How many of {@link items} nobody has marked read. */
  unread: number;
  /** True until the first read of the focused workspace settles. */
  loading: boolean;
  /** Why the last read failed, or `null`. */
  error: string | null;
  /**
   * True when the read came back full. The inbox holds 90 days and this page
   * shows one page of it, so a full page means older items exist that are not
   * on screen — said out loud rather than implied by a list that just stops.
   */
  atPageLimit: boolean;
  /** Re-read the list. Coalesced with any read already in flight. */
  refresh: () => void;
  /** Mark these ids read, then re-read. Ids already read are no-ops. */
  markRead: (ids: string[]) => Promise<void>;
  /** Mark every unread item on this page read. */
  markAllRead: () => Promise<void>;
}

/**
 * The focused workspace's inbox, shared by the left-nav badge and the inbox
 * view from one read.
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
  items: [],
  unread: 0,
  loading: false,
  error: null,
  atPageLimit: false,
  refresh: () => {},
  markRead: async () => {},
  markAllRead: async () => {},
});

export function useNotifications(): NotificationsValue {
  return useContext(NotificationsContext);
}
