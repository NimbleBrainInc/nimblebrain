/**
 * Workspace id ↔ URL slug.
 *
 * The URL slug is the workspace id with the `ws_` prefix stripped — a
 * pure cosmetic transform, NOT a name derivation. Workspace ids are
 * opaque and name-independent (`ws_<opaque>`, generated at create time;
 * see `generateWorkspaceId` server-side), so the slug in `/w/<slug>` is
 * an opaque token that never changes when the workspace is renamed. The
 * id remains the single source of truth; these helpers only add/remove
 * the `ws_` prefix for the URL.
 */

/** Workspace id → URL slug: "ws_a1b2c3d4" → "a1b2c3d4". */
export function toSlug(wsId: string): string {
  return wsId.replace(/^ws_/, "");
}

/** URL slug → workspace id: "a1b2c3d4" → "ws_a1b2c3d4". */
export function toWsId(slug: string): string {
  return slug.startsWith("ws_") ? slug : `ws_${slug}`;
}
