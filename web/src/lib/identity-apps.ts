// ---------------------------------------------------------------------------
// Identity apps (web mirror)
//
// Kernel "identity apps" are owned by the user: their TOOLS dispatch through
// the identity door as a bare `<source>__<tool>` name — no `ws_<id>-` prefix.
// Their VIEW, however, is workspace-scoped — every list is one workspace's
// (the focused workspace; there is no cross-workspace view), so the view
// renders at `/w/<slug>/<serverName>`. The slug is the focused workspace =
// view scope; it is NOT the tool namespace (the bridge keeps dispatching these
// tools bare, keyed on `isIdentityApp`, regardless of the URL).
//
// This set MIRRORS the backend identity-source set (`Runtime.getIdentitySource`
// in `src/runtime/runtime.ts`). It is keyed by **source / server name** — the
// value the resource host (`/v1/apps/:name/...`) and the bridge use — not the
// placement route. Keep the two tiers in lockstep: a source is identity-scoped
// on both or neither. Set: `conversations`, `files`, `automations`.
//
// The web tier can't import from `src/`, so this is a hand-kept mirror — the
// same arrangement as `web/src/lib/namespaced-tool.ts`.
// ---------------------------------------------------------------------------

/** Source/server names of the kernel identity apps. */
export const IDENTITY_APP_SOURCES: ReadonlySet<string> = new Set([
  "conversations",
  "files",
  "automations",
]);

/** Whether an app (by source/server name) is a kernel identity app. */
export function isIdentityApp(serverName: string): boolean {
  return IDENTITY_APP_SOURCES.has(serverName);
}

/**
 * The path segment an identity app occupies under its workspace route — just
 * the source name (e.g. `conversations`). Registered as a child of `/w/:slug`
 * in the router, alongside `app/<route>` for workspace apps.
 */
export function identityAppSegment(serverName: string): string {
  return serverName;
}

/**
 * The absolute route an identity app's view renders at within a workspace:
 * `/w/<slug>/<serverName>`. The slug is the focused workspace (view scope) —
 * the tool dispatch stays bare (see the header). Use for nav links; the router
 * registers the relative `identityAppSegment` under the `/w/:slug` guard.
 */
export function identityAppRoute(serverName: string, slug: string): string {
  return `/w/${slug}/${identityAppSegment(serverName)}`;
}
