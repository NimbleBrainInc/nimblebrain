import type { NotificationLevel } from "../_generated/platform-schemas/notifications";

/**
 * The urgency vocabulary, ordered least to most urgent, for the browser.
 *
 * The server's own copy is `NOTIFICATION_LEVELS` in
 * `src/tools/platform/schemas/notifications.ts`, and this is deliberately not
 * an import of it: the generated tree under `_generated/platform-schemas/` is
 * `.d.ts` only, so it can carry the TYPE across the package boundary but not
 * the value. What crosses instead is the exhaustiveness check — `LEVEL_RANK`
 * is a `Record<NotificationLevel, number>`, so a fourth level added on the
 * server fails this file's compile rather than silently sorting as `undefined`
 * and disappearing from every picker.
 */
export const LEVEL_RANK: Record<NotificationLevel, number> = {
  info: 0,
  attention: 1,
  urgent: 2,
};

/** Least to most urgent, derived from the ranks so the two cannot disagree. */
export const NOTIFICATION_LEVELS: NotificationLevel[] = (
  Object.keys(LEVEL_RANK) as NotificationLevel[]
).sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b]);

/**
 * How many items the inbox reads at once — the tool's documented maximum.
 *
 * Sent as a request, not asserted as a fact: the tool clamps `limit` to its own
 * maximum, so a server that lowered it returns a shorter page and the inbox
 * says so ("showing the most recent N") rather than erroring.
 */
export const INBOX_PAGE_SIZE = 100;
