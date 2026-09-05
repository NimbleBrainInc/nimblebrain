import type { NotificationView } from "../tools/platform/schemas/notifications.ts";
import type { Notification } from "./types.ts";
import { notificationId, notificationPresentation } from "./types.ts";

export type { NotificationView };

/** Flatten one stored notification onto the wire. */
export function toNotificationView(item: Notification): NotificationView {
  const presentation = notificationPresentation(item.envelope);
  return {
    id: notificationId(item),
    seq: item.seq,
    source: item.source,
    name: item.envelope.name,
    level: presentation.level,
    // Forwarded only when the record carries one, which the store writes only
    // when a ceiling actually clamped the item. Absent means "the connector's
    // level is the effective one".
    ...(item.effectiveLevel ? { effectiveLevel: item.effectiveLevel } : {}),
    title: presentation.title,
    ...(presentation.subject ? { subject: presentation.subject } : {}),
    ...(presentation.body ? { body: presentation.body } : {}),
    ...(presentation.link ? { link: presentation.link } : {}),
    timestamp: item.envelope.timestamp,
    receivedAt: item.receivedAt,
    ...(item.readAt ? { readAt: item.readAt } : {}),
    ...(item.readBy ? { readBy: item.readBy } : {}),
    ...(item.deliveries.length > 0 ? { deliveries: item.deliveries } : {}),
    data: item.envelope.data,
  };
}
