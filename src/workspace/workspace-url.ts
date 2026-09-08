/**
 * Addresses in the web shell, built from a workspace id.
 *
 * The shell routes a workspace under `/w/<slug>`, where the slug is the
 * workspace id with its `ws_` prefix stripped — a cosmetic transform and NOT a
 * name derivation, because workspace ids are opaque and name-independent
 * (`generateWorkspaceId`). A rename never moves the URL.
 *
 * **This module is the one home for that rule on the server.** The strip is
 * three characters of logic and was written inline in two places before this
 * existed; a third copy is how the OAuth return and the notification link end
 * up disagreeing about where a workspace lives. The web tier keeps its own
 * `toSlug` because it cannot import from `src/` — that copy is a tier boundary,
 * not a duplicate of convenience.
 *
 * Every URL here is absolute and rooted at {@link webOrigin}, because every
 * caller is handing the result to something outside the browser: an HTTP
 * redirect, or a message a person reads in Slack.
 */

import { webOrigin } from "../oauth/public-origin.ts";

/** Workspace id → URL slug: `ws_a1b2c3d4` → `a1b2c3d4`. */
export function workspaceSlug(wsId: string): string {
  return wsId.replace(/^ws_/, "");
}

/**
 * An absolute URL to `path` within one workspace's shell.
 *
 * `path` is appended under `/w/<slug>` and must start with `/`. Throws only if
 * the configured origin is malformed, which is a boot-time misconfiguration —
 * see {@link webOrigin}.
 */
export function workspaceUrl(wsId: string, path: string): string {
  return `${webOrigin()}/w/${workspaceSlug(wsId)}${path}`;
}

/**
 * Where a notification lives, for a reader who is not already in the shell.
 *
 * The item id rides as a query parameter rather than a path segment: it is a
 * `<source>:<eventId>` pair whose halves are both a server's own strings, so it
 * has no bounded shape a route pattern could match, and the inbox is a
 * perfectly good answer on its own when the item has aged out. A reader with a
 * stale link lands on the list rather than a 404.
 */
export function notificationInboxUrl(wsId: string, notificationId?: string): string {
  const base = workspaceUrl(wsId, "/notifications");
  return notificationId ? `${base}?item=${encodeURIComponent(notificationId)}` : base;
}
