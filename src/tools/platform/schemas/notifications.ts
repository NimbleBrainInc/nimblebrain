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

/** Page sizes for every notification list — the tool and the store. */
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
        "Only items with a `seq` greater than this. Pass back the `cursor` from your last " +
        'call: with the default newest-first order that means "what has arrived since", and ' +
        'with `order: "asc"` it walks forward through a backlog one page at a time.',
    }),
  ),
  order: Type.Optional(
    StringEnum(["desc", "asc"] as const, {
      description:
        'Newest first (`desc`, the default) answers "what is new". `asc` answers "what did ' +
        'I miss" and is the one that pages: repeat with `after` set to the previous ' +
        "`cursor` to walk a backlog forward.",
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
 * Where one route target stands for one notification.
 *
 * Three of the six are terminal because retrying changes nothing until
 * configuration does, and the split is the dispatch's own, read rather than
 * re-derived:
 *
 * | Outcome | Terminal | Means |
 * |---|---|---|
 * | `pending` | no | written before the attempt; a retry is due |
 * | `delivered` | yes | the tool ran and did not report failure |
 * | `deferred` | yes for now | an agent target, waiting on the slice that wakes one |
 * | `denied` | yes | a gate refused the author this tool |
 * | `skipped` | yes | the author is no longer a member of the workspace |
 * | `failed` | yes | the call did not complete, and the retry budget is spent |
 *
 * `pending` is what makes the ledger the retry state rather than a report of
 * it: the row is written before the first attempt, so a runtime that restarts
 * mid-delivery finds the work on disk and resumes it. There is no queue
 * anywhere else holding the same fact.
 */
export type DeliveryOutcome =
  | "pending"
  | "delivered"
  | "deferred"
  | "denied"
  | "skipped"
  | "failed";

/**
 * How one route target fared for one notification.
 *
 * The ledger is what makes a failed delivery visible instead of silent: a
 * notification that reached the inbox and never reached the Slack channel it
 * was routed to looks identical to one nobody routed, unless the attempt is
 * recorded.
 *
 * One row per `(routeId, target)`, which is also its identity — a route that
 * names the same tool twice is one row, because two attempts at the same call
 * with the same input are one delivery.
 *
 * It lives in this directory rather than in `src/notifications/` because it
 * crosses to the web on `NotificationView`, and this is the one directory the
 * web codegen compiles; the domain re-exports it.
 */
export interface DeliveryRecord {
  /** The route that matched, from the workspace record. */
  routeId: string;
  /** What the route aimed at — a tool name, or an automation id. */
  target: string;
  /** Which kind of target `target` names. */
  kind: "tool" | "agent";
  attempts: number;
  lastError?: string;
  outcome: DeliveryOutcome;
  /**
   * Why, for a non-`delivered` outcome — the dispatch's own classification
   * (`owner_not_member`, `timeout`, `tool_error`, …), or `awaiting_wake` for a
   * deferred agent target. Opaque to the browser, which renders it as text.
   */
  classification?: string;
  /** ISO 8601 instant this row last changed. */
  updatedAt: string;
  /** ISO 8601 instant the next attempt is due. Present only while `pending`. */
  nextAttemptAt?: string;
}

/**
 * The wire shape of one inbox item — what `notifications__list` returns, and
 * the only projection of a stored record that leaves the runtime.
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
  /** The level the emitting connector chose. */
  level: NotificationLevel;
  /**
   * The level routes were matched against, when the workspace's ceiling for
   * this source held it below {@link level}. Absent when nothing was clamped,
   * because an unclamped item's effective level IS its level and a second copy
   * of one value is a field that can disagree with itself.
   *
   * Stamped when the item was written, not derived on read: it records the
   * ceiling that was in force at the moment routes were evaluated, which is
   * what explains why one did or did not fire. Lowering a ceiling afterwards
   * does not rewrite history.
   */
  effectiveLevel?: NotificationLevel;
  title: string;
  subject?: string;
  body?: string;
  link?: { resource: string };
  /** When the emitting server says the fact happened. */
  timestamp: string;
  /** When this runtime wrote it. */
  receivedAt: string;
  /**
   * When somebody marked it read. **Read state is shared across the
   * workspace**, deliberately: a notification is authored by a connector, not
   * by a person, so the queue it forms is the workspace's and "has anyone
   * dealt with this" is the question it answers. {@link readBy} names who,
   * which is the field that keeps the choice visible in the record instead of
   * implied by its absence.
   */
  readAt?: string;
  /** The member who marked it read. Absent while unread. */
  readBy?: string;
  /**
   * One row per route target that matched. Absent while none has — an empty
   * ledger is not a fact worth rendering, and omitting it keeps every item in
   * a routeless workspace one field smaller.
   */
  deliveries?: DeliveryRecord[];
  data: Record<string, unknown>;
}

export interface NotificationsListOutput {
  notifications: NotificationView[];
  /**
   * Highest `seq` in this page, absent when the page is empty. Pass it back as
   * `after` to continue — forward through a backlog under `order: "asc"`, or
   * as a "what has arrived since" mark under the default newest-first order,
   * which does not walk backwards.
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

// -- The settings surface: source ceilings and routes ----------------------

/**
 * Level a newly declared source is held to until an admin raises it.
 *
 * Declaring an outbox grants nothing on its own: a connector can put items in
 * the inbox by declaring one, but a route above this ceiling does not fire for
 * it until a workspace admin says so. `info` is the floor of the
 * vocabulary, so the default is "nothing this source emits reaches a route that
 * asks for urgency".
 */
export const DEFAULT_SOURCE_MAX_LEVEL: NotificationLevel = "info";

/** Longest `id` / `source` / tool / automation name a route may name. */
const ROUTE_NAME_MAX = 200;

/** `rt_<hex>` when the runtime mints one; an admin-supplied id is any slug. */
const ROUTE_ID_PATTERN = "^[a-zA-Z0-9_-]{1,64}$";

/**
 * The event-name glob a route matches on.
 *
 * Event names are the emitting server's own dotted, lower-case strings and the
 * runtime never enumerates them, so this is a shape check and not a vocabulary:
 * it admits the characters a name can contain plus `*`, and nothing else. That
 * keeps a match expression from carrying a regex, a path, or a template.
 */
const ROUTE_NAME_GLOB_PATTERN = "^[a-zA-Z0-9._*-]{1,200}$";

/**
 * The only placeholders a `kind: "tool"` input may carry.
 *
 * Resolved from the notification's presentation block — which is why `data` is
 * absent: the runtime does not read a connector's payload, so it cannot
 * template out of one. Mustache-style, no logic. A route naming anything else
 * is rejected at write time rather than rendering the literal braces into
 * somebody's Slack channel.
 */
export const NOTIFICATION_PLACEHOLDERS = ["title", "body", "subject", "link.resource"] as const;
export type NotificationPlaceholder = (typeof NOTIFICATION_PLACEHOLDERS)[number];

export const NotificationRouteMatch = Type.Object(
  {
    source: Type.Optional(
      Type.String({
        maxLength: ROUTE_NAME_MAX,
        description: "Exact connector server name. Omit to match every source in this workspace.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        pattern: ROUTE_NAME_GLOB_PATTERN,
        description:
          "Glob over the event name the server chose, e.g. `domain.*`. Omit to match every name.",
      }),
    ),
    level: Type.Optional(
      StringEnum(NOTIFICATION_LEVELS, {
        description:
          "Minimum level, not an exact match. A level above the source's ceiling never fires " +
          "until an admin raises that ceiling.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "All three are optional; an empty match is every notification this workspace receives.",
  },
);
export type NotificationRouteMatch = Static<typeof NotificationRouteMatch>;

/**
 * The templated arguments for a `kind: "tool"` target.
 *
 * Deliberately an open object: it is the target tool's own input, whose schema
 * belongs to that tool and not to this one. String values may carry the
 * placeholders in {@link NOTIFICATION_PLACEHOLDERS}; the handler rejects any
 * other `{{…}}`.
 */
const NotificationDeliverInput = Type.Unsafe<Record<string, unknown>>({
  type: "object",
  properties: {},
  additionalProperties: true,
  description:
    "Arguments for the tool, as its own schema expects them. String values may contain " +
    "{{title}}, {{body}}, {{subject}} and {{link.resource}} — no other placeholder is resolved.",
});

export const NotificationDeliverTarget = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("tool"),
      tool: Type.String({
        maxLength: ROUTE_NAME_MAX,
        description:
          "A tool installed in this workspace, as `<connector>__<tool>`. A name outside that " +
          "set is rejected.",
      }),
      input: Type.Optional(NotificationDeliverInput),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("agent"),
      automation: Type.String({
        maxLength: ROUTE_NAME_MAX,
        description: "An automation of yours in this workspace, by id.",
      }),
    },
    { additionalProperties: false },
  ),
]);
export type NotificationDeliverTarget = Static<typeof NotificationDeliverTarget>;

/** Most targets one route may fan out to. */
export const NOTIFICATION_ROUTE_MAX_DELIVER = 5;
/** Most routes one workspace may hold. */
export const NOTIFICATION_ROUTES_MAX = 50;
/**
 * Most sources one workspace may hold a ceiling for.
 *
 * The map lives on the workspace record, and the inbound-delivery door reads
 * every workspace record in full on every delivery — a walk that stays cheap
 * only because those records stay small. A ceiling is one entry per connector
 * that ever declared an outbox, so this bound is far above any real workspace
 * and exists to keep an unbounded key space off that path.
 */
export const NOTIFICATION_SOURCES_MAX = 200;

/**
 * One route as the editor writes it.
 *
 * `createdBy` is absent by construction, not filtered: the schema is closed, so
 * a body carrying it — or an `as`, or any other principal-shaped field — is
 * refused by the validator before the handler runs. The principal a route
 * dispatches under is stamped from the authenticated identity, and a field the
 * caller could set would be the impersonation this design forbids.
 */
export const NotificationRouteInput = Type.Object(
  {
    id: Type.Optional(
      Type.String({
        pattern: ROUTE_ID_PATTERN,
        description:
          "Keep an existing route's id to edit it in place. Omit and the runtime mints one.",
      }),
    ),
    match: NotificationRouteMatch,
    deliver: Type.Array(NotificationDeliverTarget, {
      minItems: 1,
      maxItems: NOTIFICATION_ROUTE_MAX_DELIVER,
      description: "Where a matching notification goes. At least one target.",
    }),
  },
  { additionalProperties: false },
);
export type NotificationRouteInput = Static<typeof NotificationRouteInput>;

export const NotificationsSetRoutesInput = Type.Object(
  {
    routes: Type.Array(NotificationRouteInput, {
      maxItems: NOTIFICATION_ROUTES_MAX,
      description:
        "The workspace's whole route list, replacing what is stored. Send an empty array to " +
        "remove every route.",
    }),
  },
  { required: ["routes"], additionalProperties: false },
);
export type NotificationsSetRoutesInput = Static<typeof NotificationsSetRoutesInput>;

export const NotificationsSetSourceLevelInput = Type.Object(
  {
    source: Type.String({
      maxLength: ROUTE_NAME_MAX,
      description: "The connector's server name, as `notifications__settings` reports it.",
    }),
    maxLevel: StringEnum(NOTIFICATION_LEVELS, {
      description:
        "The highest level this source's notifications may reach a route at. Levels above it " +
        "are clamped, so a route asking for them never fires.",
    }),
  },
  { required: ["source", "maxLevel"], additionalProperties: false },
);
export type NotificationsSetSourceLevelInput = Static<typeof NotificationsSetSourceLevelInput>;

export const NotificationsSettingsInput = Type.Object({}, { additionalProperties: false });
export type NotificationsSettingsInput = Static<typeof NotificationsSettingsInput>;

// -- Settings output ------------------------------------------------------

/** One connector that declares an outbox, and the ceiling it is held to. */
export interface NotificationSourceView {
  /** The connector's server name — what the runtime stamps on an item's `source`. */
  source: string;
  /** Display name from the catalog, falling back to the server name. */
  label: string;
  /** What the connector says its outbox carries. Operator-facing prose. */
  description?: string;
  /** The effective ceiling: what an admin set, or {@link DEFAULT_SOURCE_MAX_LEVEL}. */
  maxLevel: NotificationLevel;
  /** False while the source is still at the default — nobody has raised it. */
  configured: boolean;
}

/**
 * Why a route is dormant, written by the runtime rather than by an admin.
 *
 * The one condition today is an author who has left the workspace: the
 * dispatch skips them, and without this the route would look healthy while
 * silently doing nothing. Cleared by the runtime when a later evaluation finds
 * the author is a member again — the same self-healing-on-re-add a scheduled
 * run gets — so it is a report, not a setting.
 */
export interface NotificationRouteDisabled {
  /** One line an admin can act on. */
  reason: string;
  /** ISO 8601 instant the runtime last observed the condition. */
  at: string;
}

/** One stored route, with the principal it dispatches under. */
export interface NotificationRouteView {
  id: string;
  /** The admin who last wrote this route. Stamped server-side; never sent. */
  createdBy: string;
  match: NotificationRouteMatch;
  deliver: NotificationDeliverTarget[];
  /** Present while the runtime is refusing to dispatch this route. */
  disabled?: NotificationRouteDisabled;
}

/**
 * Everything the workspace settings surface needs to render and validate the
 * notifications configuration, in one read.
 *
 * The pickers and the validator are fed from the same call deliberately: a
 * route the editor could offer but the handler would refuse is the drift this
 * shape exists to prevent.
 */
export interface NotificationsSettingsOutput {
  sources: NotificationSourceView[];
  routes: NotificationRouteView[];
  /** Tool names a `kind: "tool"` target may name — this workspace's installed set. */
  deliverableTools: string[];
  /** Automations the caller owns in this workspace, for a `kind: "agent"` target. */
  automations: { id: string; name: string }[];
  /** The placeholders a tool input may carry. */
  placeholders: readonly string[];
  /**
   * Whether a matching route's **tool** targets actually run. An `agent`
   * target is stored, matched and recorded in the ledger as deferred, and the
   * slice that wakes an automation is unbuilt — so the editor narrows its
   * notice to that kind rather than dropping it.
   */
  routesExecuted: boolean;
}
