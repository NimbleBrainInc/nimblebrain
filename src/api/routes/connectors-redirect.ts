import { webOrigin } from "../../oauth/public-origin.ts";

/**
 * Post-OAuth return URL for the connectors UI.
 *
 * Connectors are workspace-scoped: the page lives at
 * `/w/<slug>/settings/connectors`, where the slug is the workspace id with
 * its `ws_` prefix stripped (see `web/src/lib/workspace-slug.ts` — the slug
 * is an opaque, name-independent token, not a name derivation). Every OAuth
 * callback that brings the user back to NimbleBrain — mcp-auth, composio-auth,
 * and the composio "reuse existing connection" short-circuit — routes through
 * here so the three paths can't drift back onto a stale, unscoped URL.
 *
 * The absolute base is `webOrigin()` — the user-facing SPA origin (the canonical
 * public origin in production, the SPA port in dev). It is config-derived and
 * validated to be a bare `http(s)` origin, so the meta-refresh target can't
 * carry a `javascript:` / `data:` scheme that would survive `escapeHtml`.
 */
export function workspaceConnectorsUrl(wsId: string): string {
  // Slug is the workspace id minus the `ws_` prefix — mirrors the SPA's
  // `toSlug`. Workspace ids are opaque, so this is a pure prefix strip, not
  // a name derivation.
  const slug = wsId.replace(/^ws_/, "");
  return `${webOrigin()}/w/${slug}/settings/connectors`;
}
