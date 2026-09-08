/**
 * "Send a test message" — one route, end to end, through the real path.
 *
 * The question this answers is the one the editor cannot: *will this route
 * actually deliver?* Everything that stops it is invisible from the settings
 * page. The connector is installed but its upstream account was never
 * connected. The tool's schema does not take the argument the template writes.
 * The author's personal grant was revoked. The source ceiling sits below the
 * level the route asks for. Each of those produces a route that saves cleanly,
 * looks correct, and quietly does nothing — and the operator finds out when
 * somebody asks why they never heard about a reply.
 *
 * So this fabricates an item, writes it to the inbox, and dispatches the one
 * route. Not a dry run: the tool is really called, under the route author's own
 * identity, through the same unattended door and into the same ledger. A dry
 * run would have reported success for every one of the failures above.
 *
 * The one thing it does not test is the poll. Whether a connector's outbox is
 * being read is a different question with its own signal (`targets=N`, and the
 * inbox filling at all), and folding it in here would make a green test mean
 * two things.
 */

import { randomUUID } from "node:crypto";
import type {
  DeliveryRecord,
  NotificationsSendTestOutput,
} from "../platform/schemas/notifications.ts";
import {
  DEFAULT_SOURCE_MAX_LEVEL,
  type NotificationRoute,
  sourceMaxLevel,
  type WorkspaceNotificationsConfig,
} from "./config.ts";
import type { RouteDispatcher } from "./routes.ts";
import type { NotificationStore } from "./store.ts";
import { testEnvelopeFor } from "./test-envelope.ts";
import { clampLevel, NOTIFICATION_LEVEL_RANK, notificationId } from "./types.ts";

export interface SendTestOptions {
  wsId: string;
  route: NotificationRoute;
  config: WorkspaceNotificationsConfig;
  requestedBy: string;
  store: NotificationStore;
  dispatcher: RouteDispatcher;
  /** Sources this workspace's connectors declare, for attributing the test item. */
  declaredSources: readonly string[];
}

/**
 * Which source a test item is attributed to, and therefore whose ceiling
 * applies.
 *
 * A route that names a source is tested as that source: the ceiling is half of
 * what makes a route fire, so borrowing the name is what makes the test honest
 * rather than a lie of convenience. A route that matches every source has no
 * such answer, so it takes the first declared one — and when the workspace has
 * no outbox at all, a reserved name, which carries the default ceiling and is
 * visibly not a connector.
 */
function sourceFor(route: NotificationRoute, declared: readonly string[]): string {
  return route.match?.source ?? declared[0] ?? "notifications";
}

/**
 * Why a test item did not match the route it was built for.
 *
 * Only one cause is reachable: the envelope is constructed from the route's own
 * `match`, so its source and name agree by construction and the level is the
 * only field the workspace can override. Saying so specifically is the point —
 * "no ledger row" is what a blocked route and a broken route look like alike,
 * and the ceiling is the one an operator can fix in the row above.
 */
function unmatchedReason(source: string, ceiling: string, asked: string): string {
  return (
    `The ceiling on "${source}" is "${ceiling}", so its notifications reach a route at ` +
    `"${ceiling}" at most — and this route asks for "${asked}" or above. Raise the ceiling ` +
    "for this source, or lower the route's minimum level."
  );
}

export async function sendTestNotification(
  opts: SendTestOptions,
): Promise<NotificationsSendTestOutput> {
  const { wsId, route, config, store, dispatcher } = opts;
  const source = sourceFor(route, opts.declaredSources);
  const ceiling = sourceMaxLevel(config, source);

  const envelope = testEnvelopeFor(route, {
    requestedBy: opts.requestedBy,
    now: new Date(),
    // Per send, so two tests are two items. The store dedupes on
    // `(source, eventId)`, and a second click that silently did nothing is the
    // worst answer this button could give.
    nonce: randomUUID(),
  });

  const asked = route.match?.level ?? DEFAULT_SOURCE_MAX_LEVEL;
  const effectiveLevel = clampLevel(
    envelope._meta?.["ai.nimblebrain/notification"]?.level ?? DEFAULT_SOURCE_MAX_LEVEL,
    ceiling,
  );
  const { item } = store.append(source, envelope, effectiveLevel);
  const id = notificationId(item);

  // Checked here and not inferred from an empty ledger: the dispatcher writes
  // nothing when nothing matches, so "no rows" alone cannot tell a blocked
  // route from one whose every target failed to write.
  const matched = NOTIFICATION_LEVEL_RANK[effectiveLevel] >= NOTIFICATION_LEVEL_RANK[asked];
  if (!matched) {
    return {
      notificationId: id,
      source,
      effectiveLevel,
      matched: false,
      reason: unmatchedReason(source, ceiling, asked),
      deliveries: [],
    };
  }

  await dispatcher.dispatchOne(wsId, item, route.id);

  // Re-read rather than trusting the item in hand: the dispatcher writes the
  // ledger through the store, and this object was captured before it ran.
  const settled = store.get(item.source, item.envelope.eventId);
  return {
    notificationId: id,
    source,
    effectiveLevel,
    matched: true,
    deliveries: (settled?.deliveries ?? []) as DeliveryRecord[],
  };
}
