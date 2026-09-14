import { useCallback } from "react";
import { getActiveWorkspaceId } from "../api/client";
import { relaysToViews } from "../bridge/relayed-notifications";
import type { RelayedServerNotification } from "../bridge/types";
import { debug } from "../lib/debug";
import type { ServerNotificationEvent } from "../types";

/**
 * Hook that relays an app server's own notifications (`server.notification`
 * SSE events) to that server's iframes, verbatim.
 *
 * The notification reaches every iframe whose `data-app` is the server — its
 * inline views and its placements alike — as `{ jsonrpc, method, params }`,
 * exactly the MCP message the server sent, so an app written against the MCP
 * Apps spec hears it with no knowledge of this host. No debounce here: the
 * runtime already coalesces per (workspace, server, method) before anything
 * reaches the browser.
 *
 * Two checks, both belt to the runtime's braces: only methods on
 * `RELAYED_TO_VIEWS` are posted, and an event stamped with a workspace other
 * than the one on screen is dropped. The runtime scopes delivery to the
 * workspace's MEMBERS; a member of two workspaces still has only one of them
 * on screen, and the same app installed in both mounts under the same bare
 * `data-app`.
 *
 * Returns a stable callback to be wired into the SSE event handler.
 */
export function useServerNotificationRelay(): (event: ServerNotificationEvent) => void {
  return useCallback((event: ServerNotificationEvent) => {
    debug("sync", `SSE server.notification server=${event.server} method=${event.method}`);
    if (!relaysToViews(event.method)) {
      debug("sync", `drop: ${event.method} is not relayed to views`);
      return;
    }
    // Drop only on a positive mismatch: while the active workspace lags the
    // route by a render at bootstrap, there is nothing to compare, and the
    // notification is delivered rather than lost.
    const activeWsId = getActiveWorkspaceId();
    if (activeWsId && event.workspaceId !== activeWsId) {
      debug("sync", `drop: ws=${event.workspaceId} is not the active ${activeWsId}`);
      return;
    }

    const message: RelayedServerNotification = {
      jsonrpc: "2.0",
      method: event.method,
      ...(event.params ? { params: event.params } : {}),
    };
    // Compared by `dataset.app` rather than spliced into a selector, so a
    // server name is never parsed as CSS.
    for (const iframe of document.querySelectorAll<HTMLIFrameElement>("iframe[data-app]")) {
      if (iframe.dataset.app !== event.server) continue;
      debug("sync", `→ iframe[data-app="${event.server}"] ${event.method}`);
      // Srcdoc iframes have the opaque "null" origin, which `postMessage`'s
      // targetOrigin cannot address — the same constraint `useDataSync` notes.
      iframe.contentWindow?.postMessage(message, "*");
    }
  }, []);
}
