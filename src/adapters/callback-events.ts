import type { EngineEvent, EventSink } from "../engine/types.ts";

/**
 * Event sink that forwards events to a callback.
 * Designed for bridging engine events into UI frameworks (e.g., React state).
 */
export class CallbackEventSink implements EventSink {
  private listener: ((event: EngineEvent) => void) | null = null;

  /** Register a listener. Only one at a time — last one wins. */
  subscribe(fn: (event: EngineEvent) => void): () => void {
    this.listener = fn;
    return () => {
      if (this.listener === fn) this.listener = null;
    };
  }

  emit(event: EngineEvent): void {
    this.listener?.(event);
  }
}
