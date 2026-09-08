/**
 * Whether one match expression admits one notification.
 *
 * One body, two callers with different authority: a delivery route's `match`
 * decides that an item leaves the inbox at all, and an event automation's
 * decides which of the items a route sends it are worth a run. The rules are
 * identical and must stay identical — a workspace admin writing the first and
 * an automation owner writing the second are reading the same grammar, and the
 * settings surface validates both against the same schema.
 *
 * Keeping it in one place is not tidiness. The name glob is the one expression
 * in this design that has already produced a runtime defect (a pattern compiled
 * to a regex that did not return), and a second copy of the rule is a second
 * place for the next one to hide.
 */

import type {
  NotificationLevel,
  NotificationRouteMatch,
} from "../platform/schemas/notifications.ts";
import { matchesNameGlob } from "./name-glob.ts";
import { NOTIFICATION_LEVEL_RANK } from "./types.ts";

/** What a match is evaluated against — the stamped provenance, not the record. */
export interface MatchSubject {
  /** The connector's server name, as the runtime stamped it. */
  source: string;
  /** The server's own event name. */
  name: string;
  /** The level the item is matched AT — clamped by the workspace's ceiling. */
  level: NotificationLevel;
}

/**
 * `source` is exact, `name` is a glob, `level` is a minimum. All three are
 * optional and an omitted one narrows nothing, so an absent match admits
 * everything — legal, and the schema says so.
 */
export function matchesNotification(
  match: NotificationRouteMatch | undefined,
  subject: MatchSubject,
): boolean {
  if (!match) return true;
  if (match.source !== undefined && match.source !== subject.source) return false;
  if (!matchesNameGlob(subject.name, match.name)) return false;
  if (
    match.level !== undefined &&
    NOTIFICATION_LEVEL_RANK[subject.level] < NOTIFICATION_LEVEL_RANK[match.level]
  ) {
    return false;
  }
  return true;
}
