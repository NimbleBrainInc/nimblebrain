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
 * Name the connector a callback just connected, as `?connected=<server name>`.
 * The connectors page reads it and, once that connector settles, says whether
 * it connected, so the callback renders no page of its own. A name the page
 * does not list announces nothing.
 */
function withConnected(url: string, connected: string | undefined): string {
  return connected ? `${url}?connected=${encodeURIComponent(connected)}` : url;
}
