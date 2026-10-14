import type { ControlFrame, ConversationStreamEvents, TurnFrame } from "../api/schemas/events.ts";
import type { EngineEvent } from "../engine/types.ts";

/** The engine events a turn's viewers receive: the conversation stream catalog's engine entries. */
type StreamedRunEvent = Exclude<keyof ConversationStreamEvents, TurnFrame | ControlFrame>;

/**
 * Every engine event a conversation's viewers receive. Keyed by the catalog, so
 * the set and `ConversationStreamEvents` cannot disagree: an entry missing here,
 * or one the catalog does not declare, fails the build. Any other engine event a
 * run emits (its system prompt in `run.start`, connector skill bodies, context
 * accounting) stays on the server.
 */
const STREAMED_RUN_EVENTS: { readonly [K in StreamedRunEvent]: true } = {
  "chat.start": true,
  "text.delta": true,
  "reasoning.delta": true,
  "tool.preparing": true,
  "tool.start": true,
  "tool.done": true,
  "llm.done": true,
  "skills.loaded": true,
};

/** Whether a run's engine event is one its viewers receive. */
export function isStreamedRunEvent(
  event: EngineEvent,
): event is Extract<EngineEvent, { type: StreamedRunEvent }> {
  return Object.hasOwn(STREAMED_RUN_EVENTS, event.type);
}
