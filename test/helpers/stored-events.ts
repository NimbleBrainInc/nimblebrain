import type { ConversationEvent } from "../../src/conversation/types.ts";

/** The stored conversation event whose `type` is `K`. */
export type StoredEventOf<K extends ConversationEvent["type"]> = Extract<
  ConversationEvent,
  { type: K }
>;

/**
 * The first event of type `K` in a conversation's stored log that `where`
 * accepts, or undefined. The `type` discriminant narrows the event, so its
 * fields are typed by the log's own event union.
 */
export function firstStoredEvent<K extends ConversationEvent["type"]>(
  events: readonly ConversationEvent[],
  type: K,
  where: (event: StoredEventOf<K>) => boolean = () => true,
): StoredEventOf<K> | undefined {
  return events.filter((e): e is StoredEventOf<K> => e.type === type).find(where);
}
