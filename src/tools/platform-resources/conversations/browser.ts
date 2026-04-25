/**
 * Re-export the conversation browser HTML from the bundle source.
 *
 * This allows the platform `conversations` in-process MCP source to
 * serve the same UI without duplicating the HTML.
 */
export { BROWSER_HTML } from "../../../bundles/conversations/src/ui/browser.ts";
