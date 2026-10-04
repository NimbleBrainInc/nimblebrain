import type { NotificationView } from "../api/notifications";

/**
 * The inbox's loaded pages: newest first by `seq`, and whether the server has
 * more below the oldest one held. The list is one contiguous run of the
 * filtered inbox from its newest item down, so "Load older" always continues
 * from where it ends and never leaves a hole.
 */
export interface InboxPages {
  items: NotificationView[];
  hasMore: boolean;
}

export const EMPTY_PAGES: InboxPages = { items: [], hasMore: false };

/** Newest first, one row per id. A later copy of an id wins: it is the fresher read. */
export function sortedUnique(items: NotificationView[]): NotificationView[] {
  const byId = new Map<string, NotificationView>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => b.seq - a.seq);
}

/**
 * Fold a fresh read of the first page into what is loaded.
 *
 * The first page is what a live update re-reads, so it replaces the newest
 * items. Older pages already loaded are kept when the fresh page reaches down
 * into them; when it does not — more arrived since than one page holds — the
 * run would have a hole in it, so the older pages are dropped and paging
 * starts again from the fresh page. `held` are rows the page has promised to
 * keep in view (marked read under the Unread filter) whatever the read says,
 * as long as they sit within the run; a restart lets them go, because a held
 * row below the fresh page would become the oldest row and "Load older" would
 * continue from it, skipping everything between.
 */
export function mergeFirstPage(
  current: InboxPages,
  page: NotificationView[],
  pageHasMore: boolean,
  held: ReadonlySet<string>,
): InboxPages {
  const pageIds = new Set(page.map((item) => item.id));
  const kept = current.items.filter((item) => held.has(item.id) && !pageIds.has(item.id));
  if (!pageHasMore || page.length === 0) {
    return { items: sortedUnique([...page, ...kept]), hasMore: pageHasMore };
  }
  const oldest = Math.min(...page.map((item) => item.seq));
  const newestLoaded = current.items.reduce((max, item) => Math.max(max, item.seq), -1);
  if (newestLoaded < oldest) return { items: sortedUnique(page), hasMore: true };
  const below = current.items.filter((item) => item.seq < oldest);
  return {
    items: sortedUnique([...page, ...below, ...kept]),
    hasMore: below.length > 0 ? current.hasMore : true,
  };
}

/**
 * Append an older page read with `before: anchor`. Dropped when the run no
 * longer ends at `anchor` — a fresh first page reset it while this read was in
 * flight — because appending it then would join two runs with a hole between.
 */
export function appendOlderPage(
  current: InboxPages,
  anchor: number,
  page: NotificationView[],
  pageHasMore: boolean,
): InboxPages {
  if (oldestSeq(current) !== anchor) return current;
  return { items: sortedUnique([...current.items, ...page]), hasMore: pageHasMore };
}

/** The `seq` an older read continues below, or `undefined` with nothing loaded. */
export function oldestSeq(pages: InboxPages): number | undefined {
  return pages.items.length > 0 ? Math.min(...pages.items.map((item) => item.seq)) : undefined;
}
