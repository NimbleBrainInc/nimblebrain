import type { EngineEventPayloads } from "./schemas/events.ts";
import type { EngineEvent, EngineEventType } from "./types.ts";

/** Handlers for some event types, each given its own type's payload. */
export type EngineEventHandlers<R = void> = {
  [K in EngineEventType]?: (data: EngineEventPayloads[K]) => R;
};

/**
 * Call the handler for `event.type` with its payload, if there is one.
 *
 * The map's type pairs each handler with its event's payload. TypeScript cannot
 * carry that pairing through `handlers[event.type](event.data)` (it types the
 * lookup and the argument as independent unions), so the one cast lives here
 * rather than in every sink.
 */
export function dispatchEngineEvent<R>(
  handlers: EngineEventHandlers<R>,
  event: EngineEvent,
): R | undefined {
  const handler = handlers[event.type] as ((data: EngineEvent["data"]) => R) | undefined;
  return handler?.(event.data);
}
