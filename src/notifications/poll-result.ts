import { log } from "../observability/log.ts";

/**
 * Re-deriving one poll answer from `unknown`.
 *
 * The body comes off a connector's resource read, so nothing about its declared
 * shape is a guarantee — the same posture `parseNotificationEnvelope` takes one
 * level down. The difference is the consequence: a malformed *envelope* costs
 * one event, and a malformed *result* costs the poll, because there is no
 * position in it the runtime can trust to advance past. So this returns `null`
 * and the caller counts a failed poll, leaving the cursor where it was.
 *
 * `events` is carried as `unknown[]` deliberately. Each entry is parsed
 * individually by the envelope parser, which drops one bad entry without
 * touching the rest; validating them here would either duplicate that parser or
 * make one bad envelope fail the batch.
 */

/** The poll answer an outbox returns. */
export interface OutboxPollResult {
  /** `EventOccurrence`s, oldest first. Parsed one at a time by the caller. */
  events: unknown[];
  /** Position after the last event. Absent means "no new position". */
  cursor?: string;
  /** The outbox dropped undelivered events to stay under its cap: a real gap. */
  truncated: boolean;
  /** The batch was cut at `maxEvents`; poll again at once, within the budget. */
  hasMore: boolean;
  /** The server's cadence recommendation, honoured inside the runtime's clamp. */
  nextPollMs?: number;
}

/** Longest cursor admitted. Matches the envelope parser's own cursor bound. */
const CURSOR_MAX = 1024;

/**
 * Most events one answer may carry.
 *
 * The runtime asks for `maxEvents` and a well-behaved server honours it, so
 * this is not the request bound — it is the ceiling on what a *misbehaving*
 * one can make the runtime hold in memory and walk in a single tick, several
 * times the largest page the runtime ever asks for.
 */
const EVENTS_MAX = 5_000;

/** Parse a poll answer, or `null` when the body is not one. */
export function parseOutboxPollResult(raw: unknown): OutboxPollResult | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return drop("result is not an object");
  }
  const body = raw as Record<string, unknown>;

  if (!Array.isArray(body.events)) return drop("events is not an array");
  if (body.events.length > EVENTS_MAX) {
    return drop(`events has ${body.events.length} entries, over the ${EVENTS_MAX} cap`);
  }

  const cursor = readCursor(body.cursor);
  if (cursor === null) return drop("cursor is not a bounded string");

  const truncated = readFlag(body.truncated);
  if (truncated === null) return drop("truncated is not a boolean");

  const hasMore = readFlag(body.hasMore);
  if (hasMore === null) return drop("hasMore is not a boolean");

  const nextPollMs = readNextPollMs(body.nextPollMs);
  if (nextPollMs === null) return drop("nextPollMs is not a positive number");

  return {
    events: body.events,
    ...(cursor !== undefined ? { cursor } : {}),
    truncated,
    hasMore,
    ...(nextPollMs !== undefined ? { nextPollMs } : {}),
  };
}

/**
 * Parse the resource body's text as JSON first, then as a poll answer.
 *
 * Split from the parse above so a test can hand it a value and the poller can
 * hand it bytes, and so "the server sent something that is not JSON" and "the
 * server sent JSON that is not a poll answer" are one outcome at the call site
 * — both are a failed poll, and neither advances anything.
 */
export function parseOutboxPollBody(text: string | undefined): OutboxPollResult | null {
  if (text === undefined) return drop("resource read returned no text body");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return drop("resource body is not JSON");
  }
  return parseOutboxPollResult(parsed);
}

/** The cursor, `undefined` when absent, `null` when it is not a bounded string. */
function readCursor(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > CURSOR_MAX) return null;
  return raw;
}

/** A boolean flag, defaulting to false when absent; `null` when it is not one. */
function readFlag(raw: unknown): boolean | null {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "boolean") return null;
  return raw;
}

/** The cadence hint, `undefined` when absent, `null` when it is not a positive number. */
function readNextPollMs(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

/** Drop with a reason. Always returns `null` so callers read as one line. */
function drop(reason: string): null {
  log.debug("notify", `[notifications] dropping malformed poll result: ${reason}`);
  return null;
}
