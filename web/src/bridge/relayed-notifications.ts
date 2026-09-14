/**
 * The app-server notifications this host relays to the server's views, and the
 * `ui/initialize` capabilities that promise it.
 *
 * The runtime decides what reaches the browser (`RELAYED_SERVER_NOTIFICATIONS`
 * in `src/tools/server-notifications.ts`); this list is the browser's copy, used
 * for two things: the web shell posts only these methods to an iframe, and the
 * bridge advertises the capability for each. The two lists cannot share a
 * module (the runtime image ships `src/` alone), so
 * `test/unit/tools/server-notifications.test.ts` pins them equal.
 */

import type {
  ResourceListChangedNotification,
  ToolListChangedNotification,
} from "@modelcontextprotocol/sdk/types.js";

/** Typed from the SDK so a spec rename fails the build. */
export const RESOURCES_LIST_CHANGED: ResourceListChangedNotification["method"] =
  "notifications/resources/list_changed";
const TOOLS_LIST_CHANGED: ToolListChangedNotification["method"] =
  "notifications/tools/list_changed";

export const RELAYED_TO_VIEWS: readonly string[] = [RESOURCES_LIST_CHANGED];

/** Whether the host relays `method` to an app's views. */
export function relaysToViews(method: string): boolean {
  return RELAYED_TO_VIEWS.includes(method);
}

/**
 * The `serverTools` / `serverResources` host capabilities, with `listChanged`
 * set exactly when the matching notification is relayed. The rest of each
 * capability — that the bridge proxies the server's tool calls and resource
 * reads/listings — holds regardless.
 */
export function serverCapabilities(): {
  serverTools: { listChanged?: true };
  serverResources: { listChanged?: true };
} {
  return {
    serverTools: relaysToViews(TOOLS_LIST_CHANGED) ? { listChanged: true } : {},
    serverResources: relaysToViews(RESOURCES_LIST_CHANGED) ? { listChanged: true } : {},
  };
}
