/** Convert workspace ID to URL slug: "ws_engineering" → "engineering" */
export function toSlug(wsId: string): string {
  return wsId.replace(/^ws_/, "");
}

/** Convert URL slug to workspace ID: "engineering" → "ws_engineering" */
export function toWsId(slug: string): string {
  return slug.startsWith("ws_") ? slug : `ws_${slug}`;
}
