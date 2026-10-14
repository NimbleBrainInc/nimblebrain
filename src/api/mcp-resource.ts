/**
 * The MCP endpoint as an OAuth protected resource (RFC 9728, RFC 8707).
 *
 * Every MCP connection is addressed to one workspace by URL: `/mcp/<wsId>`.
 * That URL, built from the configured public origin, is the resource's
 * canonical identifier — the `resource` an MCP client sends the authorization
 * server, the `aud` of the token it gets back, and the `resource` the
 * per-workspace metadata document advertises. Built from `publicOrigin()` only,
 * never from the request's `Host` or `X-Forwarded-*` headers, so a caller
 * cannot choose the audience a token is checked against.
 */

import { publicOrigin } from "../oauth/public-origin.ts";

/** Path prefix of the per-workspace MCP endpoint. */
export const MCP_PATH_PREFIX = "/mcp";

/** Well-known path of Protected Resource Metadata (RFC 9728 §3). */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** The canonical resource URL of a workspace's MCP endpoint: `<origin>/mcp/<wsId>`. */
export function mcpResourceUrl(wsId: string): string {
  return `${publicOrigin()}${MCP_PATH_PREFIX}/${wsId}`;
}

/**
 * Where that resource's metadata lives: the well-known path inserted between
 * the origin and the resource's path (RFC 9728 §3.1).
 */
export function mcpResourceMetadataUrl(wsId: string): string {
  return `${publicOrigin()}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH_PREFIX}/${wsId}`;
}
