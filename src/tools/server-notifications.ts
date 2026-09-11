/**
 * Relaying an app server's own notifications to that server's views.
 *
 * The MCP Apps spec has the host forward a server's list-changed notifications
 * to the views it rendered for that server, each under a host capability the
 * view reads at `ui/initialize` (`serverResources.listChanged`, …). The host
 * here is a relay, not an interpreter: a notification on the allowlist below
 * reaches the server's views as the server sent it, in the workspace whose
 * session received it, and nothing is inferred from it on the way.
 *
 * Three rules shape the relay, and each exists because the server is untrusted:
 *
 *   - **Allowlist.** Only methods listed in `RELAYED_SERVER_NOTIFICATIONS` pass.
 *     A server cannot reach its views with arbitrary JSON-RPC by picking a
 *     method name. The web bridge advertises the matching capability for each
 *     entry (pinned together by `test/unit/tools/server-notifications.test.ts`).
 *   - **Parsed params only.** What is relayed is what the SDK schema parsed —
 *     an object, capped in size — never the raw frame.
 *   - **The host sets the rate.** Notifications are coalesced per (workspace,
 *     server, method): the first is delivered at once, the rest of a window
 *     collapse into one trailing delivery. A server announcing in a loop costs
 *     the host one delivery per window, not one per announcement multiplied by
 *     every open tab of every member.
 */

import {
  type ResourceListChangedNotification,
  ResourceListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { serverNotificationsRelayedTotal } from "../api/metrics.ts";
import type { EventSink } from "../engine/types.ts";
import { isPersonalConnectorName } from "./identity-sources.ts";
import { bareToolName } from "./namespace.ts";

/** `notifications/resources/list_changed`, typed from the SDK so a spec rename fails the build. */
export const RESOURCES_LIST_CHANGED: ResourceListChangedNotification["method"] =
  "notifications/resources/list_changed";

/**
 * The server notifications a host relays to that server's views, each with the
 * SDK schema its handler is registered under. This is the one home for the
 * list: `McpSource` registers a handler per entry, and the bridge advertises a
 * capability per entry.
 *
 * `tools/list_changed` and `prompts/list_changed` are also forwardable under
 * MCP Apps, but only behind capabilities this host does not advertise, so they
 * are not listed. Adding one here is the whole change on the runtime side.
 */
export const RELAYED_SERVER_NOTIFICATIONS = {
  [RESOURCES_LIST_CHANGED]: ResourceListChangedNotificationSchema,
} as const;

export type RelayedServerNotificationMethod = keyof typeof RELAYED_SERVER_NOTIFICATIONS;

/** One relayed notification, as a view receives it. */
export interface ServerNotification {
  method: RelayedServerNotificationMethod;
  params?: Record<string, unknown>;
}

/**
 * The largest params object relayed, in bytes of JSON. The list-changed
 * notifications carry only `_meta`, so this is generous for every method on the
 * allowlist and exists to bound what an untrusted server can push through the
 * host into every member's tabs.
 */
export const MAX_RELAYED_PARAMS_BYTES = 4096;

/**
 * The params worth relaying: an object, within `MAX_RELAYED_PARAMS_BYTES`.
 * Anything else is dropped (the notification still goes, without params) —
 * every method on the allowlist means the same thing with no params at all.
 */
export function relayableParams(params: unknown): Record<string, unknown> | undefined {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return undefined;
  let size: number;
  try {
    size = JSON.stringify(params).length;
  } catch {
    return undefined;
  }
  if (size > MAX_RELAYED_PARAMS_BYTES) return undefined;
  return params as Record<string, unknown>;
}

/**
 * Whether a bare server name can have views to deliver to, and should. Both the
 * agent path (`deriveDataChangedTarget`) and the server-notification relay ask.
 *
 * A personal connector has no listener, and the marker is NOT stripped to find
 * one. `server` is matched against an iframe's `data-app`, and a personal
 * connector cannot mount an iframe: a `ui://` read resolves through
 * `readIdentityAppResource` (kernel identity sources only) or `readAppResource`
 * (the workspace registry), and a connector is in neither. De-marking would
 * therefore never reach the connector's own surface — it would reach a
 * WORKSPACE app of the same name, refreshing an unrelated app. That same-name
 * collision is the exact thing the marker exists to prevent.
 *
 * System tools (`nb`) render no app data of their own; signalling for them
 * makes iframes re-fetch on every streaming chunk (flicker + tool-call
 * amplification).
 */
export function hasAppViews(server: string): boolean {
  if (isPersonalConnectorName(server)) return false;
  if (server === "nb") return false;
  return true;
}

/**
 * How long a coalescing window stays open after a delivery, in ms.
 *
 * Long enough that a server announcing once per write in a tight loop reaches
 * its views a handful of times a second rather than once per write; short
 * enough that a single announcement — the ordinary case — is delivered at once
 * (the window only delays a *second* announcement) and a view never trails the
 * data by more than a quarter second.
 */
export const RELAY_COALESCE_WINDOW_MS = 250;

/** The engine event a relayed notification becomes, before SSE fan-out. */
export interface ServerNotificationEventData {
  /** The bare server name — what an iframe's `data-app` carries. */
  server: string;
  workspaceId: string;
  method: RelayedServerNotificationMethod;
  params?: Record<string, unknown>;
}

interface CoalesceWindow {
  timer: ReturnType<typeof setTimeout>;
  /** The latest notification that arrived inside this window, if any. */
  pending: ServerNotification | null;
}

/**
 * Build the relay for one workspace: a function that takes a source's name and
 * a notification that source's server sent, and emits `server.notification` on
 * `eventSink` — coalesced, guarded, and stamped with `workspaceId`.
 *
 * Its state is the open coalescing windows, which close on their own within
 * `RELAY_COALESCE_WINDOW_MS` of the last notification; a workspace registry
 * lives as long as the process, so there is nothing to dispose.
 */
export function createServerNotificationRelay(
  workspaceId: string,
  eventSink: EventSink,
): (sourceName: string, notification: ServerNotification) => void {
  const windows = new Map<string, CoalesceWindow>();

  const deliver = (server: string, notification: ServerNotification): void => {
    serverNotificationsRelayedTotal.inc({ outcome: "forwarded" });
    const data: ServerNotificationEventData = {
      server,
      workspaceId,
      method: notification.method,
      ...(notification.params ? { params: notification.params } : {}),
    };
    eventSink.emit({ type: "server.notification", data: { ...data } });
  };

  const openWindow = (key: string, server: string): CoalesceWindow => {
    const opened: CoalesceWindow = {
      pending: null,
      timer: setTimeout(() => {
        const trailing = opened.pending;
        if (!trailing) {
          windows.delete(key);
          return;
        }
        // Deliver what the window held and keep coalescing: a server still
        // announcing gets one delivery per window for as long as it keeps on.
        deliver(server, trailing);
        windows.set(key, openWindow(key, server));
      }, RELAY_COALESCE_WINDOW_MS),
    };
    // A pending trailing delivery must not keep the process alive at shutdown.
    (opened.timer as { unref?: () => void }).unref?.();
    return opened;
  };

  return (sourceName: string, notification: ServerNotification): void => {
    const server = bareToolName(sourceName);
    if (!server || !hasAppViews(server)) return;

    const key = JSON.stringify([server, notification.method]);
    const open = windows.get(key);
    if (open) {
      serverNotificationsRelayedTotal.inc({ outcome: "coalesced" });
      open.pending = notification;
      return;
    }
    deliver(server, notification);
    windows.set(key, openWindow(key, server));
  };
}
