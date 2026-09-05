/**
 * The notifications block on the workspace record — source ceilings and routes.
 *
 * It sits beside `hooks` for the reason `hooks` sits beside `oauthOperatorApps`:
 * operator-plane, workspace-scoped, a lifecycle related to but not identical to
 * a bundle install, and one read on the path that needs it. Written only by a
 * workspace admin through the settings surface; never by a bundle, and never by
 * the agent.
 *
 * **The principal is the writer.** Every route carries `createdBy`, and a route
 * dispatches under that identity — so `createdBy` is stamped from the
 * authenticated caller on every write and can never arrive in a body. A
 * route rewritten by a second admin is re-stamped to that admin rather than
 * keeping the first one: an editor who could change a target while keeping
 * somebody else's principal could reach tools their own grants do not, which is
 * the impersonation the "no `as` field" rule exists to prevent.
 */

import { randomBytes } from "node:crypto";
import {
  DEFAULT_SOURCE_MAX_LEVEL,
  NOTIFICATION_PLACEHOLDERS,
  type NotificationDeliverTarget,
  type NotificationRouteDisabled,
  type NotificationRouteInput,
  type NotificationRouteMatch,
} from "../tools/platform/schemas/notifications.ts";
import { serializePerWorkspace } from "../workspace/serialize.ts";
import type { Workspace } from "../workspace/types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { PLACEHOLDER_RE } from "./template.ts";
import { NOTIFICATION_LEVELS, type NotificationLevel } from "./types.ts";

export { DEFAULT_SOURCE_MAX_LEVEL };

/**
 * Whether a matching route's `kind: "tool"` targets are actually dispatched.
 *
 * A constant rather than an operator feature flag: there is nothing for an
 * operator to decide here. It reaches the settings surface as `routesExecuted`
 * and drives what the editor says about a saved route. An `agent` target is
 * still recorded as deferred and not run, which is why the editor's notice
 * narrows to that kind rather than disappearing.
 */
export const ROUTES_EXECUTE = true;

/** What an admin set for one emitting connector. */
export interface NotificationSourceSetting {
  /** Highest level this source's items may reach a route at. */
  maxLevel: NotificationLevel;
}

/** One stored route. `createdBy` is the principal it dispatches under. */
export interface NotificationRoute {
  id: string;
  createdBy: string;
  match: NotificationRouteMatch;
  deliver: NotificationDeliverTarget[];
  /**
   * Why the runtime is refusing to dispatch this route, when it is.
   *
   * The runtime's field on an otherwise operator-owned record, and the only
   * one: an admin writes a route, and the runtime reports back that its author
   * is no longer a member. It is cleared automatically when a later evaluation
   * finds the author is a member again, so it is never something an admin has
   * to un-set. `set_routes` replaces the whole list and does not carry it,
   * which means a re-save clears it too and the next evaluation re-establishes
   * the truth.
   */
  disabled?: NotificationRouteDisabled;
}

/**
 * The `notifications` block on a workspace record.
 *
 * Two halves with different authors and one home. `sources` and `routes` are
 * the operator's, written from the settings surface. `cursors` is the poller's,
 * written on its own schedule.
 *
 * They share this type rather than sitting in two blocks because they share a
 * record, and `WorkspaceStore.update` replaces a patched field whole: a writer
 * that re-derived only its own half would persist an empty one for the other.
 * One type, one reader ({@link readNotificationsConfig}), one writer
 * ({@link updateNotificationsConfig}) — so neither half can drop the other's.
 */
export interface WorkspaceNotificationsConfig {
  sources?: Record<string, NotificationSourceSetting>;
  routes?: NotificationRoute[];
  /**
   * Where the poller has read up to in each connector's outbox, keyed by the
   * connector's MCP source name.
   *
   * The value is the emitting server's own opaque cursor: the runtime hands it
   * back verbatim on the next read and never parses, compares or synthesizes
   * one. An absent entry means "never read", which is the bootstrap — a first
   * read with no cursor returns no events and establishes the position — so
   * dropping a cursor loses nothing and replays nothing.
   *
   * Not operator-facing: it is machine state, and the settings surface neither
   * shows nor edits it. See `src/notifications/cursors.ts`.
   */
  cursors?: Record<string, string>;
}

/** Longest serialized `input` one tool target may carry. */
const DELIVER_INPUT_MAX_BYTES = 8192;

const PLACEHOLDERS = new Set<string>(NOTIFICATION_PLACEHOLDERS);

/**
 * The stored block, re-derived from what is on disk.
 *
 * A workspace record is an untrusted input by the time it is read back — hand
 * edited, restored from a backup, written by an older version — so nothing here
 * trusts the declared type. A malformed entry is dropped rather than throwing:
 * a settings page that cannot render is a worse answer than one missing a route
 * the admin can see is gone.
 */
export function readNotificationsConfig(
  ws: Pick<Workspace, "notifications"> | null | undefined,
): WorkspaceNotificationsConfig {
  const raw = ws?.notifications as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const block = raw as Record<string, unknown>;
  return {
    ...(readSources(block.sources) ? { sources: readSources(block.sources) } : {}),
    ...(readRoutes(block.routes) ? { routes: readRoutes(block.routes) } : {}),
    ...(readCursors(block.cursors) ? { cursors: readCursors(block.cursors) } : {}),
  };
}

/** The ceiling in force for one source — configured, or the default. */
export function sourceMaxLevel(
  config: WorkspaceNotificationsConfig,
  source: string,
): NotificationLevel {
  return config.sources?.[source]?.maxLevel ?? DEFAULT_SOURCE_MAX_LEVEL;
}

/** What a route write may name. Supplied by the caller, which knows the workspace. */
export interface RouteValidationContext {
  /** Tool names installed in this workspace, bare `<connector>__<tool>`. */
  toolNames: ReadonlySet<string>;
  /** Automation ids the writing identity owns in this workspace. */
  automationIds: ReadonlySet<string>;
  /** The identity stamped as every route's `createdBy`. */
  createdBy: string;
}

/**
 * Turn the editor's routes into stored ones, or explain the first refusal.
 *
 * The schema has already enforced shape; what is left is the part a schema
 * cannot express — that a named tool is one this workspace actually installed,
 * that a named automation exists, that a template names a placeholder the
 * runtime resolves, and that two routes do not share an id.
 *
 * `match.source` is deliberately NOT checked against the installed set. It is a
 * filter, not a capability: a route that outlives a connector's reinstall is
 * correct, and refusing one would delete an admin's configuration because a
 * connector happened to be down. The editor offers the installed set; the door
 * only refuses what could not work.
 */
export function validateRoutes(
  input: readonly NotificationRouteInput[],
  ctx: RouteValidationContext,
): { ok: true; routes: NotificationRoute[] } | { ok: false; error: string } {
  const routes: NotificationRoute[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    const id = raw.id ?? mintRouteId();
    if (seen.has(id)) return { ok: false, error: `Two routes share the id "${id}".` };
    seen.add(id);

    for (const target of raw.deliver) {
      const refusal = checkTarget(target, ctx);
      if (refusal) return { ok: false, error: `Route "${id}": ${refusal}` };
    }

    routes.push({
      id,
      // Stamped, never carried. The schema is closed, so an input that tried to
      // set this was already refused; stamping here is what makes the stored
      // principal the writer's own even so.
      createdBy: ctx.createdBy,
      match: raw.match,
      deliver: raw.deliver.map((t) => ({ ...t })),
    });
  }

  return { ok: true, routes };
}

/** Apply a mutation to one workspace's notifications block and persist it. */
export async function updateNotificationsConfig(
  store: WorkspaceStore,
  wsId: string,
  mutate: (current: WorkspaceNotificationsConfig) => WorkspaceNotificationsConfig | null,
): Promise<WorkspaceNotificationsConfig | null> {
  return serializePerWorkspace(wsId, async () => {
    const ws = await store.get(wsId);
    if (!ws) return null;
    const next = mutate(readNotificationsConfig(ws));
    if (next === null) return null;
    await store.update(wsId, { notifications: next });
    return next;
  });
}

/**
 * Set or clear one route's dormancy note, if the stored state disagrees.
 *
 * Returns whether anything was written. A no-op when the note already says
 * what it should, which is the common case: the condition is re-observed on
 * every matching notification, and rewriting a workspace record per delivery
 * to restate a fact would put the operator record on the hot path.
 *
 * A route that has since been deleted or rewritten under a new id is simply
 * not found, and the note goes nowhere — correct, because the route it
 * described no longer exists.
 */
export async function setRouteDisabled(
  store: WorkspaceStore,
  wsId: string,
  routeId: string,
  disabled: NotificationRouteDisabled | null,
): Promise<boolean> {
  let wrote = false;
  await updateNotificationsConfig(store, wsId, (current) => {
    const routes = current.routes;
    const route = routes?.find((r) => r.id === routeId);
    if (!route) return null;
    if (
      disabled === null ? route.disabled === undefined : route.disabled?.reason === disabled.reason
    ) {
      return null;
    }
    wrote = true;
    return {
      ...current,
      routes: routes?.map((r) => {
        if (r.id !== routeId) return r;
        const { disabled: _dropped, ...rest } = r;
        return disabled === null ? rest : { ...rest, disabled };
      }),
    };
  });
  return wrote;
}

// -- internals ------------------------------------------------------------

function mintRouteId(): string {
  return `rt_${randomBytes(6).toString("hex")}`;
}

/** Why this target cannot be stored, or `null`. */
function checkTarget(
  target: NotificationDeliverTarget,
  ctx: RouteValidationContext,
): string | null {
  if (target.kind === "agent") {
    return ctx.automationIds.has(target.automation)
      ? null
      : `no automation "${target.automation}" in this workspace. A route wakes one of your ` +
          "own automations, and it has to exist when the route is written.";
  }

  if (!ctx.toolNames.has(target.tool)) {
    return (
      `"${target.tool}" is not a tool installed in this workspace. A route may only deliver ` +
      "through a connector the workspace already has."
    );
  }

  const input = target.input;
  if (input === undefined) return null;

  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return `the input for "${target.tool}" is not JSON.`;
  }
  if (Buffer.byteLength(serialized, "utf8") > DELIVER_INPUT_MAX_BYTES) {
    return `the input for "${target.tool}" is larger than ${DELIVER_INPUT_MAX_BYTES} bytes.`;
  }

  const unknown = unknownPlaceholders(input);
  if (unknown.length > 0) {
    return (
      `the input for "${target.tool}" uses ${unknown.map((p) => `{{${p}}}`).join(", ")}. ` +
      `Only ${NOTIFICATION_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")} are resolved — ` +
      "anything else would be delivered as literal text."
    );
  }
  return null;
}

/**
 * Placeholder names in a target's input that the runtime does not resolve.
 *
 * Caught here rather than at delivery because the failure is invisible at
 * delivery: an unresolved `{{name}}` renders as itself, so the message arrives
 * looking almost right and nobody reads it as a broken route.
 */
function unknownPlaceholders(value: unknown, found: Set<string> = new Set()): string[] {
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER_RE)) {
      const token = match[1] ?? "";
      if (!PLACEHOLDERS.has(token)) found.add(token);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) unknownPlaceholders(item, found);
  } else if (value && typeof value === "object") {
    // Entries, not values: a `{{…}}` used as a KEY is delivered as literally as
    // one used as a value, so the check has to see both sides.
    for (const [key, item] of Object.entries(value)) {
      unknownPlaceholders(key, found);
      unknownPlaceholders(item, found);
    }
  }
  return [...found];
}

function readSources(raw: unknown): Record<string, NotificationSourceSetting> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, NotificationSourceSetting> = {};
  for (const [source, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const level = (entry as { maxLevel?: unknown }).maxLevel;
    if (typeof level !== "string" || !isLevel(level)) continue;
    out[source] = { maxLevel: level };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The stored cursors, dropping any entry that is not a non-empty string.
 *
 * A cursor the runtime cannot hand back verbatim is not a position: sending it
 * would ask the server a question in a shape it never issued, and dropping it
 * bootstraps that connector instead, which loses nothing it had.
 */
function readCursors(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [source, cursor] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof cursor !== "string" || cursor.length === 0) continue;
    out[source] = cursor;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readRoutes(raw: unknown): NotificationRoute[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: NotificationRoute[] = [];
  for (const entry of raw) {
    const route = readRoute(entry);
    if (route) out.push(route);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * One stored route, or `undefined` when the line cannot be one.
 *
 * A route with no id or no author is not a route: the id is how the ledger
 * names it and the author is the principal it dispatches under, so a record
 * missing either would dispatch as nobody.
 */
function readRoute(entry: unknown): NotificationRoute | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const route = entry as Record<string, unknown>;
  if (typeof route.id !== "string" || typeof route.createdBy !== "string") return undefined;
  if (!Array.isArray(route.deliver) || route.deliver.length === 0) return undefined;
  const match = route.match;
  if (match !== undefined && (typeof match !== "object" || match === null)) return undefined;
  const disabled = readDisabled(route.disabled);
  return {
    id: route.id,
    createdBy: route.createdBy,
    match: (match ?? {}) as NotificationRouteMatch,
    deliver: route.deliver as NotificationDeliverTarget[],
    ...(disabled ? { disabled } : {}),
  };
}

/**
 * The runtime's dormancy note, or `undefined` when the record does not carry a
 * usable one. A half-written note is dropped rather than rendered: a route
 * shown as disabled "for no reason" is worse than one shown as healthy, since
 * the next evaluation re-establishes the truth either way.
 */
function readDisabled(raw: unknown): NotificationRouteDisabled | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const note = raw as { reason?: unknown; at?: unknown };
  if (typeof note.reason !== "string" || typeof note.at !== "string") return undefined;
  return { reason: note.reason, at: note.at };
}

function isLevel(value: string): value is NotificationLevel {
  return (NOTIFICATION_LEVELS as readonly string[]).includes(value);
}
