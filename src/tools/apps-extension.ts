/**
 * The MCP Apps extension (`io.modelcontextprotocol/ui`), client side.
 *
 * A server checks the client's declaration before it attaches a `ui://`
 * resource to a tool (ext-apps `getUiCapability`), so a host that renders
 * apps but does not declare the extension gets none from such a server.
 */

/** Extension identifier, the key in `capabilities.extensions`. */
export const APPS_EXTENSION_ID = "io.modelcontextprotocol/ui" as const;

/**
 * The MIME type the MCP Apps spec gives a `ui://` resource. The parameter is
 * what tells a public MCP Apps host an app panel from plain HTML, so it is
 * claimed only for `ui://` URIs — see `defaultMimeType` in `in-process-app.ts`.
 */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The client's declaration: the UI resource MIME types this host renders. */
export function appsClientExtension(): Record<string, { mimeTypes: string[] }> {
  return { [APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } };
}
