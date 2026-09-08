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
import { type MatchSubject, matchesNotification } from "./match.ts";
import { type RouteDispatcher, routeMatches } from "./routes.ts";
import type { NotificationStore } from "./store.ts";
import { testEnvelopeFor } from "./test-envelope.ts";
import {
  clampLevel,
  NOTIFICATION_LEVEL_RANK,
  type NotificationLevel,
  notificationId,
} from "./types.ts";

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
 * rather than a lie of convenience.
 *
 * A route that matches EVERY source has no such answer, and the choice matters
 * more than it looks. Such a route fires if *any* declared source can reach its
 * minimum level, so the honest test is against the source with the **highest**
 * ceiling: picking an arbitrary one — the first, say — reports "this route will
 * never fire" whenever that one happens to sit low, while the route delivers
 * perfectly well for every other connector in the workspace. Worse, the reason
 * would then name a ceiling the route does not depend on, and send the admin to
 * raise it. Highest-first makes `matched` mean "this route can fire at all".
 *
 * A workspace with no outbox at all takes a reserved name, which carries the
 * default ceiling and is visibly not a connector.
 */
function sourceFor(
  route: NotificationRoute,
  declared: readonly string[],
  config: WorkspaceNotificationsConfig,
): string {
  if (route.match?.source !== undefined) return route.match.source;
  if (declared.length === 0) return "notifications";
  // `declared` arrives sorted, so ties resolve to the alphabetically-first —
  // stable across calls, which keeps a repeated test answering the same way.
  return declared.reduce((best, next) =>
    NOTIFICATION_LEVEL_RANK[sourceMaxLevel(config, next)] >
    NOTIFICATION_LEVEL_RANK[sourceMaxLevel(config, best)]
      ? next
      : best,
  );
}

/**
 * Why a test item did not match the route it was built for.
 *
 * The level is the only cause a workspace can produce: the envelope is built
 * from the route's own `match`, so its source and name agree by construction.
 * That is asserted by re-running the shared matcher with the level clause
 * removed rather than by re-deriving the comparison — if everything else
 * agrees, the level is what blocked it, and if it does not, this says so
 * instead of blaming a ceiling that is fine.
 */
function unmatchedReason(
  route: NotificationRoute,
  subject: MatchSubject,
  source: string,
  ceiling: NotificationLevel,
  anySource: boolean,
): string {
  const blockedOnLevel = matchesNotification(
    route.match ? { ...route.match, level: undefined } : undefined,
    subject,
  );
  if (!blockedOnLevel) {
    return "The test notification did not match this route. Check the source and event name.";
  }
  const asked = route.match?.level ?? DEFAULT_SOURCE_MAX_LEVEL;
  const which = anySource
    ? `The highest ceiling among this workspace's sources is "${ceiling}" (on "${source}")`
    : `The ceiling on "${source}" is "${ceiling}"`;
  return (
    `${which}, so its notifications reach a route at "${ceiling}" at most — and this route ` +
    `asks for "${asked}" or above. Raise that source's ceiling, or lower the route's ` +
    "minimum level."
  );
}

export async function sendTestNotification(
  opts: SendTestOptions,
): Promise<NotificationsSendTestOutput> {
  const { wsId, route, config, store, dispatcher } = opts;
  const anySource = route.match?.source === undefined;
  const source = sourceFor(route, opts.declaredSources, config);
  const ceiling = sourceMaxLevel(config, source);

  const envelope = testEnvelopeFor(route, {
    requestedBy: opts.requestedBy,
    now: new Date(),
    // Per send, so two tests are two items. The store dedupes on
    // `(source, eventId)`, and a second click that silently did nothing is the
    // worst answer this button could give.
    nonce: randomUUID(),
  });

  const effectiveLevel = clampLevel(
    envelope._meta?.["ai.nimblebrain/notification"]?.level ?? DEFAULT_SOURCE_MAX_LEVEL,
    ceiling,
  );
  const { item } = store.append(source, envelope, effectiveLevel);
  const id = notificationId(item);

  // The real predicate, not a second copy of it. Asked here as well as inside
  // the dispatcher because the dispatcher writes nothing when nothing matches,
  // and an empty ledger cannot tell a blocked route from one whose every target
  // failed to write — which is the distinction this whole affordance exists to
  // draw.
  if (!routeMatches(route, item, effectiveLevel)) {
    return {
      notificationId: id,
      source,
      effectiveLevel,
      matched: false,
      reason: unmatchedReason(
        route,
        { source: item.source, name: item.envelope.name, level: effectiveLevel },
        source,
        ceiling,
        anySource,
      ),
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
