import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EventSink } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import {
  NOTIFICATION_LIST_DEFAULT_LIMIT,
  NOTIFICATION_LIST_MAX_LIMIT,
} from "../tools/platform/schemas/notifications.ts";
import type { WorkspaceContext } from "../workspace/context.ts";
import {
  NOTIFICATION_LEVEL_RANK,
  type Notification,
  type NotificationEnvelope,
  type NotificationLevel,
  notificationId,
  notificationPresentation,
} from "./types.ts";

/**
 * The inbox — workspace-owned, path-authoritative (ADR-0003).
 *
 * Every item a connector emits for a workspace lands under
 * `workspaces/<wsId>/notifications/`, in an append-only JSONL file per day,
 * rolled and pruned the way the workspace audit log is. The directory is the
 * boundary: `Notification.workspaceId` is a denormalised convenience and no
 * read here can reach another workspace, because the store is constructed from
 * a {@link WorkspaceContext} that holds one and takes no workspace argument.
 *
 * There is no owner sub-partition, and that is deliberate. Conversations,
 * files and automations are authored by a user and private to them; a
 * notification is authored by a *connector*, so ownership follows the
 * connector — any member who can reach its tools can read what it said. An
 * owner partition would file the inbox under whoever happened to be polling,
 * which is nobody.
 *
 * Reads scan the retained day files rather than consulting a cache. The volume
 * is a few events an hour per workspace against a 90-day retention, so the
 * scan is small, and every operation seeing exactly what is on disk matters
 * more than the microseconds: the poller, the tool surface and the REST route
 * all read and write this same tree.
 */

/** How long an item stays in the inbox. The workspace audit line outlives it. */
export const NOTIFICATION_RETENTION_DAYS = 90;

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Filters for {@link NotificationStore.list}. All optional; all narrowing. */
export interface NotificationListOptions {
  /** Only items nobody has marked read. */
  unreadOnly?: boolean;
  /** Minimum level, not an exact match — `attention` includes `urgent`. */
  level?: NotificationLevel;
  /** Only items from this connector. */
  source?: string;
  /** Only items with a `seq` greater than this. */
  after?: number;
  /** Page size, clamped to {@link NOTIFICATION_LIST_MAX_LIMIT}. */
  limit?: number;
}

/** What an append did: the stored item, and whether this call created it. */
export interface NotificationAppendResult {
  item: Notification;
  created: boolean;
}

/** One item's identity, as `markRead` addresses it. */
export interface NotificationRef {
  source: string;
  eventId: string;
}

export interface NotificationStoreOptions {
  /**
   * Where `notification.created` goes. Required rather than optional because
   * the write and the event are one operation: an item that reached the inbox
   * without the browser hearing about it is an inbox that only refreshes on
   * reload, and an optional sink is how that happens silently at one call
   * site. Construct through `Runtime.getNotificationStore(wsId)` so every
   * store gets the runtime's own sink — the SSE stream and the workspace audit
   * log both hang off it.
   */
  eventSink: EventSink;
  retentionDays?: number;
}

export class NotificationStore {
  readonly #dir: string;
  readonly #wsId: string;
  readonly #retentionDays: number;
  readonly #eventSink: EventSink;

  constructor(ctx: WorkspaceContext, opts: NotificationStoreOptions) {
    this.#dir = ctx.getDataPath("notifications");
    this.#wsId = ctx.workspaceId;
    this.#eventSink = opts.eventSink;
    this.#retentionDays = opts.retentionDays ?? NOTIFICATION_RETENTION_DAYS;
  }

  /** The workspace this store is bound to. There is no way to address another. */
  get workspaceId(): string {
    return this.#wsId;
  }

  /**
   * Write one envelope to the inbox, stamping the runtime's fields on it.
   *
   * Idempotent on `(source, eventId)`: the transport is at-least-once, so a
   * second write of the same event is a no-op returning what is already
   * stored, and emits nothing. `seq` is assigned here and nowhere else, which
   * is what makes it monotonic per workspace however many connectors are
   * emitting.
   *
   * The durable write happens first and `notification.created` follows it. The
   * inbox is the guarantee; anything downstream of the event is best-effort
   * and never rolls the item back.
   */
  append(source: string, envelope: NotificationEnvelope): NotificationAppendResult {
    const existing = this.#find(source, envelope.eventId);
    if (existing) return { item: existing, created: false };

    const item: Notification = {
      envelope,
      source,
      workspaceId: this.#wsId,
      receivedAt: new Date().toISOString(),
      seq: this.#nextSeq(),
      deliveries: [],
    };

    mkdirSync(this.#dir, { recursive: true });
    appendFileSync(this.#dayFile(item.receivedAt.slice(0, 10)), `${JSON.stringify(item)}\n`);
    this.prune();

    const presentation = notificationPresentation(item.envelope);
    this.#eventSink.emit({
      type: "notification.created",
      data: {
        workspaceId: item.workspaceId,
        id: notificationId(item),
        seq: item.seq,
        source: item.source,
        name: item.envelope.name,
        level: presentation.level,
        title: presentation.title,
        ...(presentation.subject ? { subject: presentation.subject } : {}),
        receivedAt: item.receivedAt,
      },
    });

    return { item, created: true };
  }

  /**
   * Items matching the filters, **newest first**, capped.
   *
   * Newest-first because this backs a human's inbox and an agent's "what is
   * new"; `after` still means "seq greater than", so a caller resuming from a
   * cursor gets what it has not seen with the most recent at the top.
   */
  list(opts: NotificationListOptions = {}): Notification[] {
    const limit = clampLimit(opts.limit);
    const out: Notification[] = [];
    for (const item of this.#loadAll().reverse()) {
      if (!matchesFilters(item, opts)) continue;
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Items with `seq` greater than `after`, in **ascending seq order** — the
   * replay the SSE stream cannot provide, so a tab opened tomorrow sees what a
   * tab open today saw live.
   */
  since(after: number, limit?: number): Notification[] {
    const cap = clampLimit(limit);
    return this.#loadAll()
      .filter((item) => item.seq > after)
      .slice(0, cap);
  }

  /** One item by its `(source, eventId)` identity, or `undefined`. */
  get(source: string, eventId: string): Notification | undefined {
    return this.#find(source, eventId);
  }

  /**
   * Mark items read, returning the ones that changed.
   *
   * A ref naming nothing in this workspace is skipped — including one that is
   * real in a *different* workspace, which this store cannot see and therefore
   * cannot mark. The wall holds structurally here rather than as a check.
   */
  markRead(refs: readonly NotificationRef[]): Notification[] {
    const wanted = new Set(refs.map((ref) => refKey(ref.source, ref.eventId)));
    if (wanted.size === 0) return [];
    const readAt = new Date().toISOString();
    const changed: Notification[] = [];

    for (const day of this.#dayFiles()) {
      const items = this.#readDayFile(day);
      let dirty = false;
      for (const item of items) {
        if (item.readAt) continue;
        if (!wanted.has(refKey(item.source, item.envelope.eventId))) continue;
        item.readAt = readAt;
        dirty = true;
        changed.push(item);
      }
      if (dirty) this.#rewriteDayFile(day, items);
    }
    return changed;
  }

  /** Delete day files past the retention window. Best-effort. */
  prune(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.#retentionDays);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    for (const day of this.#dayFiles()) {
      if (day >= cutoffDay) continue;
      try {
        unlinkSync(this.#dayFile(day));
      } catch {
        // Best-effort — a file we cannot remove is retried on the next append.
      }
    }
  }

  // -- internals ---------------------------------------------------------

  #dayFile(day: string): string {
    return join(this.#dir, `${day}.jsonl`);
  }

  /** Retained day keys (`YYYY-MM-DD`), oldest first. */
  #dayFiles(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.#dir);
    } catch {
      return [];
    }
    const days: string[] = [];
    for (const name of entries) {
      const match = DAY_FILE_RE.exec(name);
      if (match) days.push(match[1]!);
    }
    return days.sort();
  }

  #readDayFile(day: string): Notification[] {
    const path = this.#dayFile(day);
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf-8").trimEnd();
    if (!content) return [];
    const items: Notification[] = [];
    for (const line of content.split("\n")) {
      try {
        const parsed = JSON.parse(line) as Notification;
        // A stored record is an untrusted input again by the time it is read
        // back. A line missing the coordinates every read keys on is not one.
        if (typeof parsed?.source !== "string" || typeof parsed?.seq !== "number") continue;
        if (typeof parsed.envelope?.eventId !== "string") continue;
        items.push(parsed);
      } catch {
        log.debug("notify", `[notifications] skipping malformed line in ${path}`);
      }
    }
    return items;
  }

  #rewriteDayFile(day: string, items: Notification[]): void {
    const path = this.#dayFile(day);
    const body = items.map((item) => JSON.stringify(item)).join("\n");
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, body.length > 0 ? `${body}\n` : "");
    renameSync(tmp, path);
  }

  /** Every retained item, ascending by `seq`. */
  #loadAll(): Notification[] {
    const items: Notification[] = [];
    for (const day of this.#dayFiles()) items.push(...this.#readDayFile(day));
    return items.sort((a, b) => a.seq - b.seq);
  }

  #find(source: string, eventId: string): Notification | undefined {
    for (const day of this.#dayFiles()) {
      for (const item of this.#readDayFile(day)) {
        if (item.source === source && item.envelope.eventId === eventId) return item;
      }
    }
    return undefined;
  }

  /**
   * The next `seq` for this workspace.
   *
   * Derived from what is on disk rather than from a counter file: a counter is
   * a second name for a number the records already carry, and it drifts
   * exactly when it matters (a partial write, a restore). Scanning the newest
   * non-empty day file finds the maximum in one read, because `seq` and
   * `receivedAt` advance together.
   */
  #nextSeq(): number {
    const days = this.#dayFiles();
    for (let i = days.length - 1; i >= 0; i--) {
      const items = this.#readDayFile(days[i]!);
      if (items.length === 0) continue;
      let max = 0;
      for (const item of items) if (item.seq > max) max = item.seq;
      return max + 1;
    }
    return 1;
  }
}

/**
 * Dedupe key for one `(source, eventId)` pair.
 *
 * Encoded rather than concatenated with a separator: an `eventId` is a
 * server-chosen string, so any separator picked here is one a server can put
 * inside an id to make two different pairs share a key.
 */
function refKey(source: string, eventId: string): string {
  return JSON.stringify([source, eventId]);
}

/** Whether one item survives every narrowing filter a list asked for. */
function matchesFilters(item: Notification, opts: NotificationListOptions): boolean {
  if (opts.unreadOnly && item.readAt) return false;
  if (opts.source && item.source !== opts.source) return false;
  if (opts.after !== undefined && item.seq <= opts.after) return false;
  if (opts.level) {
    const rank = NOTIFICATION_LEVEL_RANK[notificationPresentation(item.envelope).level];
    if (rank < NOTIFICATION_LEVEL_RANK[opts.level]) return false;
  }
  return true;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return NOTIFICATION_LIST_DEFAULT_LIMIT;
  return Math.max(1, Math.min(NOTIFICATION_LIST_MAX_LIMIT, Math.floor(limit)));
}
