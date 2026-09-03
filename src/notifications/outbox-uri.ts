import { NOTIFICATION_RETENTION_DAYS } from "./store.ts";

/**
 * Expanding the outbox resource template.
 *
 * A server declares a bare URI and the runtime reads it as the RFC 6570
 * template `<resource>{?cursor,maxEvents,maxAgeMs}`. The declaration parser
 * refuses a URI that already carries a query or a fragment, so appending is
 * unambiguous and there is no case where a server's own parameters and the
 * runtime's could collide.
 */

/**
 * How far back the runtime will replay when the stored cursor is older than
 * the answer would like to be.
 *
 * The inbox keeps items for {@link NOTIFICATION_RETENTION_DAYS}, so an event
 * older than that window is one the runtime would have pruned had it been read
 * on time — pulling it now would put a fact in an inbox whose contemporaries
 * are already gone, which reads as news and is history. Derived from the
 * retention rather than chosen next to it, so the two cannot drift apart.
 *
 * `maxAgeMs` narrows rather than widens: the server honours the later of the
 * cursor and the age bound, so this only ever trims a backlog.
 */
export const NOTIFICATION_REPLAY_MAX_AGE_MS = NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Query parameters the runtime supplies on every outbox read. */
export interface OutboxReadParams {
  /** Omitted on the bootstrap read, which returns no events and sets a position. */
  cursor?: string;
  maxEvents: number;
  maxAgeMs: number;
}

/** Expand `<resource>{?cursor,maxEvents,maxAgeMs}` into a concrete URI. */
export function outboxReadUri(resource: string, params: OutboxReadParams): string {
  const query = new URLSearchParams();
  if (params.cursor !== undefined) query.set("cursor", params.cursor);
  query.set("maxEvents", String(params.maxEvents));
  query.set("maxAgeMs", String(params.maxAgeMs));
  return `${resource}?${query.toString()}`;
}
