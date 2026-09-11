import type { ResourceListChangedNotification } from "@modelcontextprotocol/sdk/types.js";
import { useCallback, useEffect, useRef } from "react";
import { getActiveWorkspaceId } from "../api/client";
import type {
  ExtAppsResourcesListChangedNotification,
  UiDataChangedMessage,
} from "../bridge/types";
import { debug } from "../lib/debug";
import type { DataChangedEvent } from "../types";

/** A single change record buffered before dispatch. */
type DataChange =
  | { source: "agent"; server: string; tool: string; timestamp: string }
  | { source: "server"; server: string; timestamp: string };

/**
 * What a server-announced change is forwarded as: the spec notification, not a
 * NimbleBrain extension, so an app written against the MCP Apps spec hears it
 * with no knowledge of this host. `satisfies` pins the method to the SDK's own
 * type, so a rename in the spec fails the build here.
 */
const RESOURCES_LIST_CHANGED = {
  jsonrpc: "2.0",
  method: "notifications/resources/list_changed",
} as const satisfies ExtAppsResourcesListChangedNotification &
  Pick<ResourceListChangedNotification, "method">;

const DEBOUNCE_MS = 100;

/** Post one app's buffered changes to one of its iframes, each in its wire form. */
function postChanges(iframe: HTMLIFrameElement, appName: string, changes: DataChange[]): void {
  // Srcdoc iframes have the opaque "null" origin; `postMessage`'s
  // targetOrigin can't address it (literal "null" throws). Until
  // sandbox-proxy lands (iframe.ts TODO) this stays "*". The leak
  // direction (iframe→parent) is hardened via hostContext.origin.
  let serverAnnounced = false;
  for (const change of changes) {
    if (change.source === "server") {
      serverAnnounced = true;
      continue;
    }
    const message: UiDataChangedMessage = {
      jsonrpc: "2.0",
      method: "synapse/data-changed",
      params: {
        source: "agent",
        server: change.server,
        tool: change.tool,
      },
    };
    debug("sync", `→ iframe[data-app="${appName}"] ${change.server}/${change.tool}`);
    iframe.contentWindow?.postMessage(message, "*");
  }
  if (serverAnnounced) {
    debug("sync", `→ iframe[data-app="${appName}"] ${RESOURCES_LIST_CHANGED.method}`);
    iframe.contentWindow?.postMessage(RESOURCES_LIST_CHANGED, "*");
  }
}

/**
 * Hook that buffers `data.changed` SSE events and forwards them to
 * matching iframes via postMessage.
 *
 * When a `data.changed` event arrives for the active workspace, it is buffered
 * for up to 100ms. After the debounce window closes, each iframe whose
 * `data-app` attribute matches the event's server name receives it:
 *
 *   - an agent-detected change (`source: "agent"`, or absent) as one
 *     `synapse/data-changed` per buffered change, naming the tool;
 *   - a server-announced change (`source: "server"`) as the spec's
 *     `notifications/resources/list_changed`, once per flush however many
 *     arrived — the notification carries nothing, so N of them say what one
 *     says.
 *
 * An event stamped with a different workspace is dropped here — see the note
 * at the workspace check for why the filter is client-side.
 *
 * Returns a stable callback to be wired into the SSE event handler.
 */
export function useDataSync(): (event: DataChangedEvent) => void {
  const bufferRef = useRef<Map<string, DataChange[]>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flush buffered changes to matching iframes
  const flush = useCallback(() => {
    const buffer = bufferRef.current;
    if (buffer.size === 0) return;

    const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe[data-app]");
    // Answers: "are the iframes I expect actually in the DOM with the right
    // data-app?" — the most common cause of UIs that don't update. Gated on
    // `localStorage.nb_debug=sync` (see web/src/lib/debug.ts).
    debug("sync", `flush ${buffer.size} buffer entries, ${iframes.length} iframes`, {
      bufferKeys: [...buffer.keys()],
      iframeApps: Array.from(iframes).map((f) => f.dataset.app),
    });

    for (const iframe of iframes) {
      const appName = iframe.dataset.app;
      if (!appName) continue;

      const changes = buffer.get(appName);
      if (!changes || changes.length === 0) continue;
      postChanges(iframe, appName, changes);
    }

    buffer.clear();
    timerRef.current = null;
  }, []);

  // Clean up pending timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Stable callback for receiving data.changed events
  const onDataChanged = useCallback(
    (event: DataChangedEvent) => {
      // Confirms the SSE connection is delivering `data.changed` events to
      // the browser. If this never fires, the break is upstream (server sink
      // wrap not installed, SSE connection closed, etc.).
      debug(
        "sync",
        `SSE data.changed source=${event.source ?? "agent"} server=${event.server} tool=${event.tool ?? "-"} ws=${event.wsId ?? "-"}`,
      );

      // The same app installed in two workspaces has the same bare `data-app`,
      // so a write in workspace A would otherwise postMessage-match a mounted
      // workspace-B iframe and send it to re-fetch data that did not change.
      //
      // The SECOND of two filters, not the only one: the server already scopes
      // the fan-out to the caller's workspace MEMBERSHIPS. Membership is the
      // broader set — a user in both A and B legitimately receives both — so
      // narrowing to the workspace actually on screen belongs here, where the
      // active workspace is known.
      //
      // Only drop on a POSITIVE mismatch. An event with no `wsId` is an
      // identity-door call and belongs to no workspace; a browser with no active
      // workspace has nothing to compare. Either way, deliver — the old
      // behaviour, kept for the cases the field cannot speak to. That second
      // case also covers bootstrap, where the active workspace lags the route by
      // a render: an event arriving in that window is delivered rather than
      // dropped.
      const activeWsId = getActiveWorkspaceId();
      if (event.wsId && activeWsId && event.wsId !== activeWsId) {
        debug("sync", `drop: ws=${event.wsId} is not the active ${activeWsId}`);
        return;
      }

      const change: DataChange =
        event.source === "server"
          ? { source: "server", server: event.server, timestamp: event.timestamp }
          : {
              source: "agent",
              server: event.server,
              // Every agent-detected broadcast names its tool; the type is
              // optional only because a server-announced one has none.
              tool: event.tool ?? "",
              timestamp: event.timestamp,
            };

      const buffer = bufferRef.current;
      const existing = buffer.get(event.server);
      if (existing) {
        existing.push(change);
      } else {
        buffer.set(event.server, [change]);
      }

      // Start debounce timer if not already running
      if (timerRef.current === null) {
        timerRef.current = setTimeout(flush, DEBOUNCE_MS);
      }
    },
    [flush],
  );

  return onDataChanged;
}
