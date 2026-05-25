import { useEffect, useRef } from "react";
import type { EventConnection } from "../api/sse";
import { connectEvents } from "../api/sse";
import type {
  ConfigChangedEvent,
  ConnectionStateChangedEvent,
  ConversationTitleEvent,
  DataChangedEvent,
  SseEventMap,
  SseEventType,
} from "../types";

export interface UseEventsOptions {
  /** Called when a data.changed SSE event is received. */
  onDataChanged?: (event: DataChangedEvent) => void;
  /** Called when a config.changed SSE event is received. */
  onConfigChanged?: (event: ConfigChangedEvent) => void;
  /** Called when an auto-generated conversation title arrives. */
  onConversationTitle?: (event: ConversationTitleEvent) => void;
  /** Called when a per-Connection state transition fires (URL bundles). */
  onConnectionStateChanged?: (event: ConnectionStateChangedEvent) => void;
  /**
   * Called on bundle install / uninstall. Both events affect the shell
   * (placements appear / disappear), so consumers typically wire this
   * to a shell refetch. The two events share a callback because the
   * downstream action is the same.
   */
  onBundleLifecycleChanged?: () => void;
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
  const onConversationTitleRef = useRef(options?.onConversationTitle);
  onConversationTitleRef.current = options?.onConversationTitle;
  const onConnectionStateChangedRef = useRef(options?.onConnectionStateChanged);
  onConnectionStateChangedRef.current = options?.onConnectionStateChanged;
  const onBundleLifecycleChangedRef = useRef(options?.onBundleLifecycleChanged);
  onBundleLifecycleChangedRef.current = options?.onBundleLifecycleChanged;

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
        if (type === "conversation.title") {
          onConversationTitleRef.current?.(data as ConversationTitleEvent);
        }
        if (type === "connection.state_changed") {
          onConnectionStateChangedRef.current?.(data as ConnectionStateChangedEvent);
        }
        if (type === "bundle.installed" || type === "bundle.uninstalled") {
          onBundleLifecycleChangedRef.current?.();
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
