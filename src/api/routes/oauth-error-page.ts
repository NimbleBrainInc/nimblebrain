/**
 * The one line every OAuth error page ends with: where to go to try again.
 *
 * Shared by the `mcp-auth` and `composio-auth` callbacks. A callback that
 * succeeds renders nothing: it redirects to the connectors page, which confirms
 * the connection in the app's own theme.
 */

import { brandName } from "../../brand/index.ts";

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

/** The closing line of every OAuth error page: where to go to try again. */
export function reinitiateParagraph(): string {
  return `<p>Re-initiate the connection from ${escapeHtml(brandName())}.</p>`;
}
