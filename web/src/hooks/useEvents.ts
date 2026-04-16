import { useEffect, useRef } from "react";
import type { EventConnection } from "../api/sse";
import { connectEvents } from "../api/sse";
import type { ConfigChangedEvent, DataChangedEvent, SseEventMap, SseEventType } from "../types";

export interface UseEventsOptions {
  /** Called when a data.changed SSE event is received. */
  onDataChanged?: (event: DataChangedEvent) => void;
  /** Called when a config.changed SSE event is received. */
  onConfigChanged?: (event: ConfigChangedEvent) => void;
}

/**
 * Subscribe to the workspace-level SSE event stream.
 *
 * This replaces the SSE subscription that was previously inside useWorkspace.
 * Forwards data.changed events to the provided callback (typically from useDataSync).
 */
export function useEvents(
  token: string,
  workspaceId: string | undefined,
  options?: UseEventsOptions,
): void {
  const connectionRef = useRef<EventConnection | null>(null);
  const onDataChangedRef = useRef(options?.onDataChanged);
  onDataChangedRef.current = options?.onDataChanged;
  const onConfigChangedRef = useRef(options?.onConfigChanged);
  onConfigChangedRef.current = options?.onConfigChanged;

  useEffect(() => {
    if (!token || !workspaceId) return;

    const connection = connectEvents({
      token,
      workspaceId,
      onEvent: <K extends SseEventType>(type: K, data: SseEventMap[K]) => {
        if (type === "data.changed") {
          onDataChangedRef.current?.(data as DataChangedEvent);
        }
        if (type === "config.changed") {
          onConfigChangedRef.current?.(data as ConfigChangedEvent);
        }
      },
    });

    connectionRef.current = connection;

    return () => {
      connection.close();
      connectionRef.current = null;
    };
  }, [token, workspaceId]);
}
