// ---------------------------------------------------------------------------
// The inbox and its settings, as the shell calls them.
//
// There is no REST route for notifications and there is not meant to be: a
// paginated JSON read meets none of the four conditions the runtime requires of
// a new `/v1/...` endpoint, and the shell already sends `X-Workspace-Id` on
// every request, so a path-segment workspace would name nothing the header had
// not. Everything here is a `tools/call` through the same door the agent and
// any external MCP client use.
//
// The wrappers exist so the response types are imported once, from the
// generated schema tree, rather than re-declared at each call site.
// ---------------------------------------------------------------------------

import type {
  NotificationsListInput,
  NotificationsListOutput,
  NotificationsMarkReadOutput,
  NotificationsSetRoutesInput,
  NotificationsSetSourceLevelInput,
  // Imported as well as re-exported below, and both are load-bearing: the
  // local binding types the return values here, and `export type … from`
  // creates no local name.
  NotificationsSettingsOutput,
} from "../_generated/platform-schemas/notifications";
import { callTool } from "./client";
import { parseToolResult } from "./tool-result";

export type {
  DeliveryRecord,
  NotificationDeliverTarget,
  NotificationLevel,
  NotificationRouteInput,
  NotificationRouteMatch,
  NotificationRouteView,
  NotificationSourceView,
  NotificationsSettingsOutput,
  NotificationView,
} from "../_generated/platform-schemas/notifications";

export async function listNotifications(
  args: NotificationsListInput = {},
): Promise<NotificationsListOutput> {
  return parseToolResult<NotificationsListOutput>(await callTool("notifications", "list", args));
}

export async function markNotificationsRead(ids: string[]): Promise<NotificationsMarkReadOutput> {
  return parseToolResult<NotificationsMarkReadOutput>(
    await callTool("notifications", "mark_read", { ids }),
  );
}

export async function readNotificationSettings(): Promise<NotificationsSettingsOutput> {
  return parseToolResult<NotificationsSettingsOutput>(
    await callTool("notifications", "settings", {}),
  );
}

/**
 * Raise or lower one source's ceiling. Returns the whole settings surface, not
 * the one field: the write is a read-modify-write on the workspace record, so
 * what it hands back is what is now stored — nothing here reconstructs state
 * from an optimistic guess.
 */
export async function setNotificationSourceLevel(
  args: NotificationsSetSourceLevelInput,
): Promise<NotificationsSettingsOutput> {
  return parseToolResult<NotificationsSettingsOutput>(
    await callTool("notifications", "set_source_level", args),
  );
}

/** Replace the workspace's routes. `createdBy` is stamped server-side. */
export async function setNotificationRoutes(
  args: NotificationsSetRoutesInput,
): Promise<NotificationsSettingsOutput> {
  return parseToolResult<NotificationsSettingsOutput>(
    await callTool("notifications", "set_routes", args),
  );
}
