/**
 * The envelope behind "send a test message".
 *
 * A route fails silently in ways an operator cannot see from the editor: the
 * connector has no upstream account, the tool's schema does not take the
 * arguments the template writes, the author's grant was revoked, the source
 * ceiling is below what the route asks for. Every one of those is invisible
 * until a real event happens to arrive, which for a domain going active can be
 * hours and for a bounce can be never.
 *
 * So the test builds an envelope **shaped to match the route under test** and
 * puts it through the real path. Not a mock and not a dry run: matching the
 * route's own `match` block means the ceiling clamps it exactly as it would
 * clamp a real one, so a route that will never fire because nobody raised the
 * ceiling reports that instead of a false green.
 *
 * It is deliberately obvious in the inbox. A fabricated item that read like a
 * real one would be a lie told in the operator's own record, and the record is
 * the thing they are learning to trust.
 */

import type { NotificationRoute } from "./config.ts";
import type { NotificationEnvelope, NotificationLevel } from "./types.ts";

/** What a test item's `data` carries, so the inbox can say what it is. */
export interface TestNotificationData {
  test: true;
  routeId: string;
  requestedBy: string;
}

/**
 * A concrete event name the glob `pattern` admits.
 *
 * The route stores a glob and an envelope needs a name, so the wildcards are
 * filled with a literal segment. `*` and `**` both become `test`, which the
 * matcher accepts for either: `*` matches within one segment and `test` carries
 * no dot, and `**` matches that and more. A pattern with no wildcard is already
 * a name and passes through.
 *
 * Absent means the route matches every name, and the envelope may then say
 * whatever it likes.
 */
export function nameForGlob(pattern: string | undefined): string {
  if (pattern === undefined) return "notifications.test";
  const filled = pattern.replaceAll("**", "*").replaceAll("*", "test");
  // `**` alone fills to the bare name `test`; anything else keeps its literals.
  return filled.length > 0 ? filled : "notifications.test";
}

/**
 * Build the test envelope for one route.
 *
 * `level` is the route's own minimum, because a test that sent `info` at a
 * route asking for `attention` would never match and would teach the operator
 * nothing. `eventId` is unique per send so two tests are two inbox items rather
 * than one deduped away — the store dedupes on `(source, eventId)`, and a test
 * that silently did nothing the second time would be the worst possible
 * behaviour for this button.
 */
export function testEnvelopeFor(
  route: NotificationRoute,
  opts: { requestedBy: string; now: Date; nonce: string },
): NotificationEnvelope {
  const level: NotificationLevel = route.match?.level ?? "info";
  const data: TestNotificationData = {
    test: true,
    routeId: route.id,
    requestedBy: opts.requestedBy,
  };
  return {
    eventId: `notifications.test:${route.id}:${opts.nonce}`,
    name: nameForGlob(route.match?.name),
    timestamp: opts.now.toISOString(),
    data: data as unknown as Record<string, unknown>,
    _meta: {
      "ai.nimblebrain/notification": {
        level,
        title: `Test notification for "${route.id}"`,
        subject: "Notification settings",
        body:
          "Somebody sent this from Notification settings to check that this route " +
          "delivers. No connector reported anything; nothing happened.",
      },
    },
  };
}
