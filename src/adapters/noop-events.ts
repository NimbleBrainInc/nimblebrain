import type { EngineEvent, EventSink } from "../engine/types.ts";

/** Discards all events. Default event sink. */
export class NoopEventSink implements EventSink {
  emit(_event: EngineEvent): void {
    // intentionally empty
  }
}
