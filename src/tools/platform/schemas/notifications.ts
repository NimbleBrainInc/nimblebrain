import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

/**
 * Canonical urgency vocabulary, ordered least to most urgent. Single source of
 * truth: the TypeBox enum below, the {@link NotificationLevel} type, and the
 * domain's rank map (`src/notifications/types.ts`) all derive from this array,
 * so a fourth level is added in exactly one place.
 *
 * It lives here rather than in `src/notifications/` for the same reason
 * `USAGE_GROUP_BYS` does: this directory is the one the web codegen compiles,
 * and it must stay self-contained.
 */
export const NOTIFICATION_LEVELS = ["info", "attention", "urgent"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/** Page sizes for every notification list — the tool, the store, the REST route. */
export const NOTIFICATION_LIST_DEFAULT_LIMIT = 20;
export const NOTIFICATION_LIST_MAX_LIMIT = 100;

export const NotificationsListInput = Type.Object({
  unreadOnly: Type.Optional(
    Type.Boolean({ description: "Only items nobody has marked read. Default: false." }),
  ),
  level: Type.Optional(
    StringEnum(NOTIFICATION_LEVELS, {
      description:
        "Minimum level, not an exact match: `attention` also returns `urgent`. " +
        "Levels are advisory, chosen by the connector that emitted the item.",
    }),
  ),
  source: Type.Optional(
    Type.String({
      maxLength: 128,
      description: "Only items from this connector, by its server name (e.g. `acme`).",
    }),
  ),
  after: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Only items with a `seq` greater than this. Pass the highest `seq` you have already " +
        "seen to page through what is new.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: NOTIFICATION_LIST_MAX_LIMIT,
      description: `Page size. Default ${NOTIFICATION_LIST_DEFAULT_LIMIT}, maximum ${NOTIFICATION_LIST_MAX_LIMIT}.`,
    }),
  ),
});
export type NotificationsListInput = Static<typeof NotificationsListInput>;

export const NotificationsMarkReadInput = Type.Object(
  {
    ids: Type.Array(Type.String({ minLength: 3, maxLength: 512 }), {
      minItems: 1,
      maxItems: NOTIFICATION_LIST_MAX_LIMIT,
      description: "Notification ids, exactly as `notifications__list` returned them.",
    }),
  },
  { required: ["ids"] },
);
export type NotificationsMarkReadInput = Static<typeof NotificationsMarkReadInput>;

// -- Output types (AGENTS.md 2.1) -----------------------------------------

/**
 * The wire shape of one inbox item — the agent's tool and the web inbox's REST
 * route return the same projection, so the two can never disagree about what
 * an item is.
 *
 * It is a flattening of the stored record, not a subset with a policy in it:
 * the presentation block is resolved with its defaults applied and the
 * envelope's identity fields are lifted beside it.
 *
 * `data` is the emitting server's own structured payload, forwarded verbatim.
 * No runtime code reads a field of it — it crosses this boundary the way a
 * tool result's `structuredContent` does, and carries exactly as much
 * authority: it is data a connector wrote, not an instruction.
 */
export interface NotificationView {
  /** `<source>:<eventId>`. What `notifications__mark_read` is addressed with. */
  id: string;
  /** Monotonic position in this workspace's inbox. */
  seq: number;
  /** The connector that emitted it, stamped by the runtime. */
  source: string;
  /** The server's own event name. */
  name: string;
  level: NotificationLevel;
  title: string;
  subject?: string;
  body?: string;
  link?: { resource: string };
  /** When the emitting server says the fact happened. */
  timestamp: string;
  /** When this runtime wrote it. */
  receivedAt: string;
  readAt?: string;
  data: Record<string, unknown>;
}

export interface NotificationsListOutput {
  notifications: NotificationView[];
  /**
   * Highest `seq` in this page, absent when the page is empty. Pass it back as
   * `after` to continue.
   */
  cursor?: number;
}

export interface NotificationsMarkReadOutput {
  /** Ids that were unread in this workspace and are now read. */
  marked: string[];
  /**
   * Ids that named nothing markable here — unknown, already read, malformed,
   * or belonging to another workspace, which this session cannot reach.
   */
  skipped: string[];
}
