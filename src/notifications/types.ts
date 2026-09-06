/**
 * Notifications — the facts a connector records that nobody asked for.
 *
 * A server that learns something asynchronously (a domain it ordered went
 * active, a reply landed) writes an envelope into its own outbox and exposes
 * that outbox as one MCP resource. The runtime reads it, stamps provenance,
 * and holds the result in a workspace-owned inbox. Nothing here reaches a
 * human on its own: routing and delivery are operator configuration.
 *
 * The envelope IS the MCP Triggers-and-Events sketch's `EventOccurrence` —
 * `eventId`, `name`, `timestamp`, `data`, an optional per-event `cursor`, and
 * `_meta`. Everything this host renders and routes on lives under the
 * reverse-DNS `_meta` key {@link NOTIFICATION_META_KEY}, the same convention
 * the host extension already uses for `ai.nimblebrain/host`. A server that
 * emits a plain `EventOccurrence` with no `_meta` block still lands in the
 * inbox, rendered from `name`.
 *
 * **The line the runtime holds: it reads the four standard fields and its own
 * `_meta` block, and never `data`.** `data` is the server's structured payload,
 * opaque here and forwarded verbatim the way a tool result's
 * `structuredContent` is. The moment runtime code reads a field out of it, the
 * host has started knowing what a server's events mean — which is the split
 * this design exists to keep.
 */

import {
  type DeliveryRecord,
  NOTIFICATION_LEVELS,
  type NotificationLevel,
} from "../tools/platform/schemas/notifications.ts";

/**
 * Re-exported so everything under `src/notifications/` imports its vocabulary
 * from one place. The values themselves live in the schema module, which is
 * the one directory the web codegen compiles and must stay self-contained.
 */
export { type DeliveryRecord, NOTIFICATION_LEVELS, type NotificationLevel };

/**
 * Rank used to resolve a `level` filter as a minimum rather than an exact
 * match. Derived from the ordered vocabulary rather than restating it, so a
 * fourth level ranks itself.
 *
 * Level is advisory throughout: the inbox sorts by it and a route may match on
 * it, and nothing else treats it as authority — the emitting server chose it.
 */
export const NOTIFICATION_LEVEL_RANK: Readonly<Record<NotificationLevel, number>> =
  Object.fromEntries(NOTIFICATION_LEVELS.map((level, rank) => [level, rank])) as Record<
    NotificationLevel,
    number
  >;

/** The `_meta` key carrying everything this host renders and routes on. */
export const NOTIFICATION_META_KEY = "ai.nimblebrain/notification";

/** Level applied when an envelope declares none. */
export const DEFAULT_NOTIFICATION_LEVEL: NotificationLevel = "info";

/** Plain-text caps. Longer values are truncated, never rejected. */
export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_BODY_MAX = 2000;
export const NOTIFICATION_SUBJECT_MAX = 200;

/**
 * What the host renders and routes on, from
 * `_meta["ai.nimblebrain/notification"]`.
 *
 * `title` and `body` are **plain text**. They are server-authored strings that
 * reach a human's attention surface, so they are stripped of control
 * characters and capped on parse, and no consumer interprets markup in them.
 *
 * There is no `link.tool` and no `actions[]` in v1, deliberately: a server
 * naming a tool and an input that a UI renders as an affordance is where the
 * envelope crosses from presentation into instruction.
 */
export interface NotificationPresentation {
  /** What this is about — free text, used for grouping. */
  subject?: string;
  level: NotificationLevel;
  /** One line. Defaults to the event's `name` when the server declares none. */
  title: string;
  body?: string;
  /** Where to go. A URI with a scheme; the host resolves nothing from it. */
  link?: { resource: string };
}

/**
 * An envelope's `_meta`: this host's block plus whatever else the server put
 * there. Other keys are preserved on the record and never read.
 */
export type NotificationEnvelopeMeta = {
  "ai.nimblebrain/notification"?: NotificationPresentation;
} & Record<string, unknown>;

/** One `EventOccurrence` as a server wrote it, after parsing and normalization. */
export interface NotificationEnvelope {
  /** Server-unique, and the idempotency key. Servers use the upstream id where one exists. */
  eventId: string;
  /** The server's own dotted event name. The runtime matches it as a string and never enumerates names. */
  name: string;
  /** ISO 8601, normalized on parse. */
  timestamp: string;
  /** The server's structured payload. Opaque: no runtime code reads a field of it. */
  data: Record<string, unknown>;
  /** Position after this event, when the server issues per-event cursors. */
  cursor?: string;
  _meta?: NotificationEnvelopeMeta;
}

/**
 * One stored inbox item: the envelope plus what the runtime stamps on it.
 *
 * Every stamped field is the runtime's. A server has no way to set one: the
 * parser produces an envelope and only the store stamps, so `source`,
 * `workspaceId`, `receivedAt` and `seq` say what the platform observed rather
 * than what the payload claimed.
 */
export interface Notification {
  envelope: NotificationEnvelope;
  /** The connector's server name, as the runtime knows it. */
  source: string;
  /** Denormalised — the storage path is authoritative (ADR-0003). */
  workspaceId: string;
  /** ISO 8601 instant the runtime wrote this item. */
  receivedAt: string;
  /** Monotonic per workspace. The addressable position for replay (`?after=`). */
  seq: number;
  /**
   * The level routes were matched against, when the workspace's ceiling for
   * this source held it below the level the connector chose.
   *
   * Stored only when it differs, and read back through
   * {@link notificationEffectiveLevel}. An unclamped item's effective level is
   * its own, and writing a second copy of one value is how the two come to
   * disagree.
   */
  effectiveLevel?: NotificationLevel;
  /**
   * ISO 8601 instant a reader marked it read. Absent while unread.
   *
   * **One instant for the whole workspace, decided rather than inherited.** A
   * notification is authored by a *connector*, so it is filed by workspace and
   * not by person, and the queue it forms is shared: a route that posted an
   * item to a channel already delivered it to everyone, and per-member read
   * state would disagree with the channel. {@link readBy} names who marked it,
   * which is what makes the choice a field in the record rather than an
   * omission — a later move to per-member state has a place to put the map.
   */
  readAt?: string;
  /** The member who marked it read. Absent while unread. */
  readBy?: string;
  /** One row per route target that matched. Empty until one does. */
  deliveries: DeliveryRecord[];
}

/**
 * The level routes were evaluated at — the stamped one, or the connector's own
 * when nothing clamped it.
 */
export function notificationEffectiveLevel(item: Notification): NotificationLevel {
  return item.effectiveLevel ?? notificationPresentation(item.envelope).level;
}

/**
 * The lower of a connector's chosen level and the workspace's ceiling for it.
 *
 * The ceiling is the operator's grant: declaring an outbox costs a poll and
 * some inbox rows, and it should not also be a decision to let that connector
 * reach a route that asks for urgency. Clamping rather than filtering is what
 * keeps the item in the inbox at the level the connector meant while holding
 * what it can *reach* to what the admin allowed.
 */
export function clampLevel(
  level: NotificationLevel,
  ceiling: NotificationLevel,
): NotificationLevel {
  return NOTIFICATION_LEVEL_RANK[level] <= NOTIFICATION_LEVEL_RANK[ceiling] ? level : ceiling;
}

/**
 * The wire id for one notification: `<source>:<eventId>`.
 *
 * Derived rather than stored, because the pair it is built from is already the
 * dedupe key — a stored id would be a second name for the same identity and
 * could disagree with it. Source names are slugs and carry no colon, so the
 * first colon splits it unambiguously.
 */
export function notificationId(
  item: Pick<Notification, "source"> & {
    envelope: Pick<NotificationEnvelope, "eventId">;
  },
): string {
  return `${item.source}:${item.envelope.eventId}`;
}

/** Inverse of {@link notificationId}, or `null` when the string is not one. */
export function parseNotificationId(id: string): { source: string; eventId: string } | null {
  const idx = id.indexOf(":");
  if (idx <= 0 || idx === id.length - 1) return null;
  return { source: id.slice(0, idx), eventId: id.slice(idx + 1) };
}

/**
 * The presentation block for an item, with the documented defaults applied.
 *
 * The parser already normalizes the block, so this is total for anything that
 * came through it. It re-derives anyway because a stored record is an
 * untrusted input again by the time it is read back off disk.
 */
export function notificationPresentation(envelope: NotificationEnvelope): NotificationPresentation {
  const block = envelope._meta?.[NOTIFICATION_META_KEY];
  const level =
    block && NOTIFICATION_LEVELS.includes(block.level) ? block.level : DEFAULT_NOTIFICATION_LEVEL;
  const title = block?.title && block.title.length > 0 ? block.title : envelope.name;
  const out: NotificationPresentation = { level, title };
  if (block?.subject) out.subject = block.subject;
  if (block?.body) out.body = block.body;
  if (block?.link?.resource) out.link = { resource: block.link.resource };
  return out;
}

/**
 * One outbox a server declares in `_meta["ai.nimblebrain/host"].notifications`.
 *
 * Unlike `hooks`, this declaration **grants no privilege**: no URL is minted,
 * no new token audience exists, and nothing here opens a path to a human — a
 * route does that, and only a workspace admin writes one. What it does impose
 * is cost, a standing poll per `(workspace, connector)` at the runtime's
 * expense, which the runtime bounds rather than the server.
 *
 * That is also why its provenance can widen where `hooks`' cannot. Today it is
 * read from the operator-published catalog entry alongside `hooks`; a server's
 * own `initialize` result is a legitimate future source for it, because the
 * worst a forged declaration buys is a poll the runtime already rate-limits.
 */
export interface NotificationsDeclaration {
  /**
   * The outbox resource URI, e.g. `acme://notifications`. A URI with a scheme
   * and no query string: the runtime reads it as the RFC 6570 template
   * `<resource>{?cursor,maxEvents,maxAgeMs}` and supplies those parameters
   * itself.
   */
  resource: string;
  /** What the outbox carries. Operator-facing; the runtime never acts on it. */
  description?: string;
}
