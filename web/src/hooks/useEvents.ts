import { useEffect, useRef } from "react";
import { onReconnect, subscribe } from "../api/events-client";
import type {
  ConfigChangedEvent,
  ConnectionStateChangedEvent,
  ConversationTitleEvent,
  DataChangedEvent,
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
  /**
   * Called after every successful reconnection (NOT the initial
   * connect). The workspace stream has no `Last-Event-Id` replay, so
   * during the disconnect gap consumers can miss `bundle.installed` /
   * `config.changed` / state-change events and silently drift out of
   * sync. Consumers wire this to a refetch of whatever state they
   * derive from those events (typically the shell + workspace config).
   */
  onReconnect?: () => void;
}

/**
 * Subscribe to the workspace-level SSE event stream.
 *
 * Transport ownership lives in the singleton at `api/events-client.ts`.
 * This hook is a thin subscriber: any number of components can call
 * `useEvents` and they all share **one** `/v1/events` connection per
 * tab. The previous shape opened a fresh `connectEvents()` per hook
 * instance, which silently held 2-3 duplicate connections per tab once
 * `App` + `WorkspaceAppIconsProvider` (+ optionally `ConnectorList`)
 * each mounted it.
 *
 * The `token` and `workspaceId` parameters are vestigial — the
 * singleton reads the current token internally per (re)connect and
 * `/v1/events` is identity-scoped server-side. The signature is
 * preserved so call sites need no edits.
 */
export function useEvents(
  _token: string,
  _workspaceId: string | undefined,
  options?: UseEventsOptions,
): void {
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
  const onReconnectRef = useRef(options?.onReconnect);
  onReconnectRef.current = options?.onReconnect;

  useEffect(() => {
    // One subscription per event type. Each handler dispatches through
    // a ref so consumers can re-render freely without churning the
    // subscriptions (the underlying connection persists for tab life).
    const unsubs: Array<() => void> = [];

    unsubs.push(
      subscribe("data.changed", (data) => {
        onDataChangedRef.current?.(data);
      }),
    );
    unsubs.push(
      subscribe("config.changed", (data) => {
        onConfigChangedRef.current?.(data);
      }),
    );
    unsubs.push(
      subscribe("conversation.title", (data) => {
        onConversationTitleRef.current?.(data as ConversationTitleEvent);
      }),
    );
    unsubs.push(
      subscribe("connection.state_changed", (data) => {
        onConnectionStateChangedRef.current?.(data);
      }),
    );
    unsubs.push(
      subscribe("bundle.installed", () => {
        onBundleLifecycleChangedRef.current?.();
      }),
    );
    unsubs.push(
      subscribe("bundle.uninstalled", () => {
        onBundleLifecycleChangedRef.current?.();
      }),
    );
    unsubs.push(
      onReconnect(() => {
        onReconnectRef.current?.();
      }),
    );

    return () => {
      for (const u of unsubs) u();
    };
  }, []);
}
