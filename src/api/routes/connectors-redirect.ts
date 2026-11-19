import { webOrigin } from "../../oauth/public-origin.ts";
import { workspaceUrl } from "../../workspace/workspace-url.ts";

/**
 * Post-OAuth return URL for the connectors UI.
 *
 * Connectors are workspace-scoped: the page lives at
 * `/w/<slug>/settings/connectors`. Every OAuth callback that brings the user
 * back to NimbleBrain — mcp-auth, composio-auth, and the composio "reuse
 * existing connection" short-circuit — routes through here so the three paths
 * can't drift back onto a stale, unscoped URL.
 *
 * The slug rule and the absolute base both live in `workspace/workspace-url.ts`:
 * the base is `webOrigin()`, config-derived and validated to be a bare
 * `http(s)` origin, so a callback's redirect can never point off this
 * deployment or carry a `javascript:` / `data:` scheme.
 */
export function workspaceConnectorsUrl(wsId: string, connected?: string): string {
  return withConnected(workspaceUrl(wsId, "/settings/connectors"), connected);
}

/**
 * Post-OAuth return URL for a **personal (identity-owned) connector**. It lives
 * on the user's profile, outside any workspace — `/profile/connectors` — so an
 * identity OAuth callback lands the user back there, not on a workspace page.
 */
export function profileConnectorsUrl(connected?: string): string {
  return withConnected(`${webOrigin()}/profile/connectors`, connected);
}

/**
 * Where a personal connector's sign-in returns: the page that started it, when
 * the initiate named one ({@link sameOriginReturnPath}), else the profile's
 * connectors page. The page that started the sign-in knows what it started, so
 * a return to it carries no `?connected=`.
 */
export function personalReturnUrl(returnPath: string | undefined, connected?: string): string {
  return returnPath ? `${webOrigin()}${returnPath}` : profileConnectorsUrl(connected);
}

/** Longest return path a sign-in carries; a shell URL is far shorter. */
const MAX_RETURN_PATH = 2048;

/**
 * The page a personal sign-in should return to, from the value the initiate's
 * caller sent, or undefined when it is not a path in the web shell.
 *
 * Only a relative path is taken (`/w/…`, with its query), and it is resolved
 * against {@link webOrigin} and kept only when it stays on that origin, so a
 * callback's redirect never leaves this deployment. A scheme, a host, a
 * protocol-relative `//host` or `/\host` (which browsers read as a host), and
 * control characters are refused. A refused value is not an error: the sign-in
 * returns where it always has.
 */
export function sameOriginReturnPath(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_PATH) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  // Backslashes read as slashes in a browser's URL parser; control characters
  // are stripped by it. Either can turn a path into a host.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return undefined;
  const origin = webOrigin();
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(origin).origin) return undefined;
  return `${url.pathname}${url.search}`;
}

/**
 * Name the connector a callback just connected, as `?connected=<server name>`.
 * The connectors page reads it and, once that connector settles, says whether
 * it connected, so the callback renders no page of its own. A name the page
 * does not list announces nothing.
 */
function withConnected(url: string, connected: string | undefined): string {
  return connected ? `${url}?connected=${encodeURIComponent(connected)}` : url;
}
