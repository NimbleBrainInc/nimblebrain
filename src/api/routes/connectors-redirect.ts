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
 * `http(s)` origin, so the meta-refresh target can't carry a `javascript:` /
 * `data:` scheme that would survive `escapeHtml`.
 */
export function workspaceConnectorsUrl(wsId: string): string {
  return workspaceUrl(wsId, "/settings/connectors");
}

/**
 * Post-OAuth return URL for a **personal (identity-owned) connector**. It lives
 * on the user's profile, outside any workspace — `/profile/connectors` — so an
 * identity OAuth callback lands the user back there, not on a workspace page.
 */
export function profileConnectorsUrl(): string {
  return `${webOrigin()}/profile/connectors`;
}
