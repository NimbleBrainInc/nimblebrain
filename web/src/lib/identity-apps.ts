// ---------------------------------------------------------------------------
// Identity apps (web mirror)
//
// Kernel "identity apps" are owned by the user and hosted OUTSIDE any
// workspace. They route through the identity door (a bare `<source>__<tool>`
// name), render at a top-level root route (e.g. `/conversations`), and
// dispatch their tool calls bare — no `ws_<id>-` prefix.
//
// This set MIRRORS the backend identity-source set (`Runtime.getIdentitySource`
// in `src/runtime/runtime.ts`). It is keyed by **source / server name** — the
// value the resource host (`/v1/apps/:name/...`) and the bridge use — not the
// placement route. Keep the two tiers in lockstep: a source is identity-scoped
// on both or neither. v1 set: `conversations` (files and automations join when
// their data moves to identity ownership).
//
// The web tier can't import from `src/`, so this is a hand-kept mirror — the
// same arrangement as `web/src/lib/namespaced-tool.ts`.
// ---------------------------------------------------------------------------

/** Source/server names of the kernel identity apps. */
export const IDENTITY_APP_SOURCES: ReadonlySet<string> = new Set(["conversations"]);

/** Whether an app (by source/server name) is a kernel identity app. */
export function isIdentityApp(serverName: string): boolean {
  return IDENTITY_APP_SOURCES.has(serverName);
}

/**
 * The top-level root route an identity app renders at — its source name as a
 * path segment (e.g. `conversations` → `/conversations`). Identity apps live
 * outside any workspace, so they never carry a `/w/<slug>` prefix.
 */
export function identityAppRoute(serverName: string): string {
  return `/${serverName}`;
}
