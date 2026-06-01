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
 * Resolution order for the absolute base:
 *   1. NB_WEB_URL  (operator config — the platform's user-facing origin)
 *   2. NB_API_URL  (single-origin deployments share the API + SPA host)
 *   3. the request origin (last resort: the callback hit us here)
 */
export function workspaceConnectorsUrl(wsId: string, requestUrl: string): string {
  // Slug is the workspace id minus the `ws_` prefix — mirrors the SPA's
  // `toSlug`. Workspace ids are opaque, so this is a pure prefix strip, not
  // a name derivation.
  const slug = wsId.replace(/^ws_/, "");
  const path = `/w/${slug}/settings/connectors`;

  const fallbackOrigin = (() => {
    try {
      return new URL(requestUrl).origin;
    } catch {
      return "";
    }
  })();
  const webBase = (process.env.NB_WEB_URL ?? process.env.NB_API_URL ?? fallbackOrigin).replace(
    /\/+$/,
    "",
  );
  const absolute = `${webBase}${path}`;

  // Defense-in-depth: NB_WEB_URL / NB_API_URL are operator-controlled, but a
  // malformed value with a `javascript:` / `data:` scheme would survive
  // escapeHtml (which only escapes &<>"') and execute when the meta-refresh
  // fires. Validate the protocol; fall back to a same-origin relative path
  // (which also covers the no-base case, where `absolute` is already relative).
  try {
    const parsed = new URL(absolute);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return path;
    }
  } catch {
    return path;
  }
  return absolute;
}
