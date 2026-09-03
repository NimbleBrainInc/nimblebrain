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
 * How one route target fared for one notification.
 *
 * The ledger is what makes a failed delivery visible instead of silent: a
 * notification that reached the inbox and never reached the Slack channel it
 * was routed to looks identical to one nobody routed, unless the attempt is
 * recorded. Empty until routes are dispatched.
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
  attempts: number;
  lastError?: string;
  outcome: "delivered" | "failed" | "skipped";
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
  /**
   * One row per route target that has been tried. Absent while nothing has
   * tried — an empty ledger is not a fact worth rendering, and omitting it
   * keeps every item in a routeless workspace one field smaller.
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
 * The declaration itself grants nothing (spec §4.2): a connector can put items
 * in the inbox by declaring an outbox, but a route above this ceiling does not
 * fire for it until a workspace admin says so. `info` is the floor of the
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
 * One route as the editor writes it.
 *
 * `createdBy` is absent by construction, not filtered: the schema is closed, so
 * a body carrying it — or an `as`, or any other principal-shaped field — is
 * refused by the validator before the handler runs. The principal a route
 * dispatches under is stamped from the authenticated identity (spec §4.4), and
 * a field the caller could set would be the impersonation this design forbids.
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

/** One stored route, with the principal it dispatches under. */
export interface NotificationRouteView {
  id: string;
  /** The admin who last wrote this route. Stamped server-side; never sent. */
  createdBy: string;
  match: NotificationRouteMatch;
  deliver: NotificationDeliverTarget[];
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
   * Whether a matching route actually runs. False while the dispatch half is
   * unbuilt: routes are stored, validated and shown, and nothing reads them.
   * The editor says so rather than implying a delivery that will not happen.
   */
  routesExecuted: boolean;
}
