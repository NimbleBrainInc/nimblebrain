import { log } from "../observability/log.ts";
import {
  DEFAULT_NOTIFICATION_LEVEL,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_LEVELS,
  NOTIFICATION_META_KEY,
  NOTIFICATION_SUBJECT_MAX,
  NOTIFICATION_TITLE_MAX,
  type NotificationEnvelope,
  type NotificationEnvelopeMeta,
  type NotificationLevel,
  type NotificationPresentation,
} from "./types.ts";

/**
 * Re-deriving one envelope from `unknown`.
 *
 * The bytes come from a connector's outbox, so nothing about the declared type
 * is a guarantee. Everything below reads the shape back out of `unknown`, the
 * way `parseHookDeclarations` does for the other block a server authors.
 *
 * Two rules, and they pull in opposite directions on purpose:
 *
 *   - **A known field with a malformed value drops the whole envelope.** There
 *     is no partial item: a notification with a bad timestamp or an invented
 *     level would be a record whose fields mean different things depending on
 *     which one you read. One bad envelope costs one event, never the poll.
 *   - **An unknown key is kept and ignored.** The `_meta` contract is additive,
 *     and a server ahead of this host must not be punished for it. That is also
 *     how `link.tool` and `actions[]` are treated: absent from v1, so a server
 *     that sends them has them dropped rather than honored.
 *
 * Nothing here throws. A malformed envelope is a debug line and a `null`.
 */

/** Longest serialized envelope the inbox admits, in bytes of UTF-8 JSON. */
export const NOTIFICATION_ENVELOPE_MAX_BYTES = 64 * 1024;

/** Longest an id, a name, a cursor, or a link may be. */
const ID_MAX = 200;
const NAME_MAX = 200;
const CURSOR_MAX = 1024;
const LINK_MAX = 2048;

/**
 * URI schemes a `link.resource` may never carry. Each is a scheme a renderer
 * can be talked into executing or into reading local state from, and a link is
 * the one envelope field aimed at a click.
 */
const FORBIDDEN_LINK_SCHEMES = new Set(["javascript", "data", "vbscript", "file", "blob"]);

/** A URI with a scheme, e.g. `acme://notifications` or `https://…`. */
const URI_WITH_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** Whether a string carries a C0/DEL control character. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Strip control characters and collapse the whitespace they leave behind.
 *
 * `title` and `body` are plain text on every surface that shows them, so a
 * newline or an ANSI escape in them is never content — it is a server shaping
 * a human's terminal or a log line. Removing rather than escaping keeps the
 * string one thing on every surface instead of one thing per renderer.
 */
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += " ";
      continue;
    }
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Sanitize and cap one plain-text field. Returns `""` when nothing survives. */
export function capText(value: string, max: number): string {
  const clean = stripControlChars(value);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** A plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A bounded, control-character-free identifier string. */
function isCleanString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !hasControlChars(value)
  );
}

/**
 * Whether a `link.resource` is a URI this host is willing to carry.
 *
 * The check is on the scheme, not on a parse: the host resolves nothing from
 * the URI, so what matters is only that a renderer downstream cannot be handed
 * something that executes.
 */
function isAcceptableLink(value: unknown): value is string {
  if (!isCleanString(value, LINK_MAX)) return false;
  const match = URI_WITH_SCHEME_RE.exec(value);
  if (!match) return false;
  return !FORBIDDEN_LINK_SCHEMES.has(match[1]!.toLowerCase());
}

/** Drop with a reason. Always returns `null` so callers read as one line. */
function drop(reason: string, eventId?: unknown): null {
  log.debug(
    "notify",
    `[notifications] dropping malformed envelope: ${reason}` +
      (typeof eventId === "string" ? ` (eventId ${eventId})` : ""),
  );
  return null;
}

/**
 * Normalize the `_meta["ai.nimblebrain/notification"]` block.
 *
 * Returns the block on success, `null` when a declared field is malformed
 * (which drops the envelope), and the defaults when there is no block at all —
 * an `EventOccurrence` with no `_meta` is a notification like any other.
 */
function parsePresentation(raw: unknown, name: string): NotificationPresentation | null {
  if (raw === undefined) return { level: DEFAULT_NOTIFICATION_LEVEL, title: name };
  if (!isPlainObject(raw)) return null;

  const level = readLevel(raw.level);
  if (level === null) return null;
  const title = readCappedText(raw.title, NOTIFICATION_TITLE_MAX);
  if (title === null) return null;
  const subject = readCappedText(raw.subject, NOTIFICATION_SUBJECT_MAX);
  if (subject === null) return null;
  const body = readCappedText(raw.body, NOTIFICATION_BODY_MAX);
  if (body === null) return null;
  const link = readLink(raw.link);
  if (link === null) return null;

  return {
    level,
    // A title that survives sanitizing as an empty string is not a title; the
    // event's own name is a better answer than a blank line in an inbox.
    title: title.length > 0 ? title : name,
    ...(subject.length > 0 ? { subject } : {}),
    ...(body.length > 0 ? { body } : {}),
    ...(link ? { link } : {}),
  };
}

/** The declared level, the default when absent, or `null` when it is not one of the three. */
function readLevel(raw: unknown): NotificationLevel | null {
  if (raw === undefined) return DEFAULT_NOTIFICATION_LEVEL;
  return NOTIFICATION_LEVELS.find((level) => level === raw) ?? null;
}

/** Sanitized, capped text; `""` when absent; `null` when the value is not a string. */
function readCappedText(raw: unknown, max: number): string | null {
  if (raw === undefined) return "";
  if (typeof raw !== "string") return null;
  return capText(raw, max);
}

/**
 * The link, `undefined` when absent, or `null` when malformed.
 *
 * `resource` is the only member v1 defines. `tool` and anything else are
 * dropped rather than rejected: the block is additive, and honoring a
 * server-named tool is the line this envelope does not cross.
 */
function readLink(raw: unknown): { resource: string } | undefined | null {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) return null;
  if (raw.resource === undefined) return undefined;
  if (!isAcceptableLink(raw.resource)) return null;
  return { resource: raw.resource };
}

/** The instant as ISO 8601, or `undefined` when it is not a parseable date string. */
function readTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Parse one `EventOccurrence` from a connector's outbox into a stored-ready
 * envelope, or `null` when it is not well-formed enough to hold.
 *
 * The result is normalized: `timestamp` is ISO 8601, the presentation block is
 * present with its defaults applied, and `title` / `body` / `subject` are
 * sanitized plain text. Every other `_meta` key is carried through untouched.
 */
export function parseNotificationEnvelope(raw: unknown): NotificationEnvelope | null {
  if (!isPlainObject(raw)) return drop("not an object");

  if (!isCleanString(raw.eventId, ID_MAX)) return drop("eventId is not a bounded string");
  const eventId = raw.eventId;

  // `name` is matched as a string and never enumerated, so the only constraint
  // is that it stays a legible identifier: bounded, and with no whitespace or
  // control characters that would make a glob or a log line ambiguous.
  if (!isCleanString(raw.name, NAME_MAX) || /\s/.test(raw.name)) {
    return drop("name is not a bounded whitespace-free string", eventId);
  }
  const name = raw.name;

  const timestamp = readTimestamp(raw.timestamp);
  if (!timestamp) return drop("timestamp is not an ISO 8601 instant", eventId);

  if (!isPlainObject(raw.data)) return drop("data is not an object", eventId);
  const data = raw.data;

  if (raw.cursor !== undefined && !isCleanString(raw.cursor, CURSOR_MAX)) {
    return drop("cursor is not a bounded string", eventId);
  }
  const cursor = raw.cursor as string | undefined;

  if (raw._meta !== undefined && !isPlainObject(raw._meta)) {
    return drop("_meta is not an object", eventId);
  }
  const meta = raw._meta as Record<string, unknown> | undefined;

  const presentation = parsePresentation(meta?.[NOTIFICATION_META_KEY], name);
  if (!presentation) return drop(`malformed ${NOTIFICATION_META_KEY} block`, eventId);

  const outMeta: NotificationEnvelopeMeta = { ...meta, [NOTIFICATION_META_KEY]: presentation };

  const envelope: NotificationEnvelope = {
    eventId,
    name,
    timestamp,
    data,
    ...(cursor !== undefined ? { cursor } : {}),
    _meta: outMeta,
  };

  // The last check, because it is the only one that needs the whole thing
  // assembled. `data` is opaque and therefore unbounded by anything upstream;
  // without a ceiling one server's payload decides how large a workspace's
  // inbox files get.
  const size = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (size > NOTIFICATION_ENVELOPE_MAX_BYTES) {
    return drop(
      `envelope is ${size} bytes, over the ${NOTIFICATION_ENVELOPE_MAX_BYTES} cap`,
      eventId,
    );
  }

  return envelope;
}
